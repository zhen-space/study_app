// Legacy toc_items 的 **read-only** compatibility projection。
//
// 為什麼存在：production 有 55 筆 toc_items，正式 Material 目前是 0。
// 學生只該看到一個「教材」的世界，不該看到「教材庫／舊版目錄」兩個分頁。
// 但這**不代表**要把舊資料 migrate 成 Material——migration 是不可逆的，
// 而且會把「猜出來的對應」變成看起來像事實的資料。
//
// 所以這裡只做投影：讀 toc_items，投影成與正式 Material 同形狀的模型，
// 但 identity 永遠標明來源。
//
// 這個檔案**只有 SELECT**。不 UPDATE、不 INSERT、不 DELETE toc_items。
//
// 三條不可跨越的線：
//   ① legacy identity 與 Material identity 不互轉。legacy 帶 { toc_id, path }，
//      Material 帶 material_* id，兩者不做任何 title / 書名 / path 的比對配對。
//   ② legacy 沒有正式 completion。**不得捏造 0%** 假裝語意相同——
//      回 completion_supported: false，讓呼叫端自己決定怎麼自然呈現。
//   ③ legacy 巢狀 Topic 只在**呈現上**攤平成與 Section 同層；
//      原始 path 完整保留，之後要指回原本那一列仍然精準。

import { q } from '../db/init.js';

export const SOURCE_MATERIAL = 'material';
export const SOURCE_LEGACY = 'legacy';

// legacy 的 level 是自由文字（課本上印什麼就填什麼）。
// 只有明確對得上的才對應到正式節點種類；對不上的一律保守處理。
const SECTION_LEVELS = ['節', '小節', '單元'];
const TOPIC_LEVELS = ['主題', '重點'];

// 「焦點」這類 level 在正式 Material 沒有對應的 kind。
// production 有 25 筆。不猜成 reading / example / example_problem / unit_exercise——
// 猜錯就是把使用者的教材結構改掉，而且沒有任何回頭路。
//
// 保守契約：投影成 kind='legacy_node' 的顯示節點，原始 level 原樣保留在
// legacy_level，並標明 completion_supported: false、selectable: false。
// 它不是正式 Material 節點，也不會有 Material identity。
export const LEGACY_NODE_KIND = 'legacy_node';

export function projectLevel(level) {
  const l = String(level || '').trim();
  if (SECTION_LEVELS.includes(l)) return 'section';
  if (TOPIC_LEVELS.includes(l)) return 'topic';
  return LEGACY_NODE_KIND;
}

const parseSections = row => {
  try {
    const v = JSON.parse(row.sections || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};

// 舊資料有兩種形狀：字串陣列（最早期）與物件樹。統一成物件。
const normNode = n => (typeof n === 'string'
  ? { title: n, level: '節', children: [] }
  : { title: n?.title ?? '', level: n?.level ?? '節', children: Array.isArray(n?.children) ? n.children : [] });

// 把一列 toc_items（＝一章）投影成 unified chapter。
//
// legacy 原始：Chapter → Section → Topic（Topic 巢狀在 Section 底下）
// 投影之後：  Chapter → [Section, Topic, …]（同層）
//
// 攤平**只發生在呈現**。每個節點都帶 legacy_ref = { toc_id, path }，
// path 是它在原始 sections JSON 裡的索引路徑，所以指得回原本那一列的那個位置。
export function projectChapter(row) {
  const children = [];
  const sections = parseSections(row).map(normNode);

  sections.forEach((sec, si) => {
    children.push({
      source: SOURCE_LEGACY,
      kind: projectLevel(sec.level),
      legacy_level: String(sec.level || ''),
      title: sec.title,
      order_index: si,
      legacy_ref: { toc_id: row.id, path: [si] },
      content_items: [],
      children: [],
      completion_supported: false,
    });
    // 巢狀的 Topic 提到與 Section 同層，但 path 記的仍是它真正的位置 [si, ti]
    (sec.children || []).map(normNode).forEach((topic, ti) => {
      children.push({
        source: SOURCE_LEGACY,
        kind: projectLevel(topic.level),
        legacy_level: String(topic.level || ''),
        title: topic.title,
        order_index: si + (ti + 1) / 1000,   // 緊跟在自己原本的父節點之後
        legacy_ref: { toc_id: row.id, path: [si, ti] },
        content_items: [],
        children: [],
        completion_supported: false,
        // 呈現上與 Section 同層，但這一筆原本是巢狀在某個 Section 底下。
        // 保留這個事實，之後要回溯或做正式轉換時才不用重新推測。
        legacy_flattened_from: { toc_id: row.id, path: [si] },
      });
    });
  });

  children.sort((a, b) => a.order_index - b.order_index);
  return {
    source: SOURCE_LEGACY,
    kind: 'chapter',
    title: row.title,
    order_index: row.order_index ?? 0,
    legacy_ref: { toc_id: row.id, path: [] },
    legacy_level: String(row.level || ''),
    content_items: [],
    children: children.map((c, i) => ({ ...c, order_index: i })),
    completion_supported: false,
  };
}

// 舊資料以 (list_id, book) 為一本書。book 是自由文字，可能是空字串。
const bookKey = row => `${row.list_id}|${row.book || ''}`;

// 讀出這位使用者所有 legacy 教材，投影成 unified book 形狀。純 SELECT。
export async function listLegacyBooks(userId) {
  const rows = await q.all(
    'SELECT * FROM toc_items WHERE user_id=? ORDER BY list_id, book, order_index, id', [userId]);
  const byBook = new Map();
  for (const row of rows) {
    const key = bookKey(row);
    if (!byBook.has(key)) {
      byBook.set(key, {
        source: SOURCE_LEGACY,
        // legacy 沒有 material_book_id，而且**不得**被指派一個。
        // identity 就是 (科目, 書名) 這個 legacy 座標本身。
        legacy_ref: { list_id: row.list_id, book: row.book || '' },
        title: row.book || '（未命名教材）',
        publisher: row.publisher || '',
        subject_list_id: row.list_id,
        chapters: [],
        // legacy 沒有正式 completion。不給 progress 物件，也不給 0%。
        completion_supported: false,
      });
    }
    byBook.get(key).chapters.push(projectChapter(row));
  }
  return [...byBook.values()];
}
