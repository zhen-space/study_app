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
  const all = await q.all(
    'SELECT * FROM toc_items WHERE user_id=? ORDER BY list_id, book, order_index, id', [userId]);
  // 已經正式化的來源列不再以 legacy 身分出現——否則同一本教材會變成兩本。
  // 判準是 provenance 的 source_row_id，**不是**書名比對。
  const done = await formalizedSourceRowIds(userId);
  const rows = all.filter(r => !done.has(Number(r.id)));
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
        // 這本教材還沒有正式的內容資訊，要先讓學生確認一次才能拿來排計畫。
        // 學生看到的是「確認這本教材裡有哪些內容」，不是 migration。
        requires_content_confirmation: true,
        selectable: false,
      });
    }
    byBook.get(key).chapters.push(projectChapter(row));
  }
  return [...byBook.values()];
}

/* ---------- Just-in-time formalization ---------- */

// 哪些 legacy 來源列已經被正式化過。deterministic：查的是 provenance 的
// source_row_id，不是書名。
export async function formalizedSourceRowIds(userId) {
  const rows = await q.all(
    'SELECT source_row_id FROM material_book_sources WHERE user_id=? AND source_kind=?',
    [userId, 'legacy_toc']);
  return new Set(rows.map(r => Number(r.source_row_id)));
}

// 把一本 legacy 教材投影成「可以拿去正式化的 canonical draft」。
//
// 能 deterministic 帶入的：書名、出版社、科目、章、節／主題（含巢狀 Topic 的
// presentation flatten 結果）。
//
// **不能** deterministic 帶入的：ContentItem 的 kind。
// legacy 的 toc_items 完全沒有存內容類型——舊流程裡「範例／例題／單元練習／
// 歷屆試題」是使用者在排程時當場勾的，從來沒有落庫。所以這裡每個節點的
// content_items 一律是空陣列，由使用者確認之後才填。猜就是無中生有。
//
// 對不上正式種類的 legacy 節點（如「焦點」）不會進 draft 的 children——
// 它不是 section 也不是 topic，硬塞就是在猜。它們列在 unsupported_nodes 裡，
// 讓呼叫端可以如實呈現。
export async function legacyFormalizationDraft(userId, { listId, book = '' }) {
  const rows = await q.all(
    'SELECT * FROM toc_items WHERE user_id=? AND list_id=? AND COALESCE(book,\'\')=? ORDER BY order_index, id',
    [userId, listId, book]);
  if (!rows.length) return null;

  const done = await formalizedSourceRowIds(userId);
  const alreadyFormalized = rows.filter(r => done.has(Number(r.id))).map(r => Number(r.id));

  const unsupported = [];
  const chapters = rows.map((row, ci) => {
    const projected = projectChapter(row);
    const children = [];
    for (const c of projected.children) {
      if (c.kind === 'section' || c.kind === 'topic') {
        children.push({
          kind: c.kind,
          title: c.title,
          order: children.length,
          // 使用者確認前一律是空的
          content_items: [],
          legacy_ref: c.legacy_ref,
        });
      } else {
        unsupported.push({ title: c.title, legacy_level: c.legacy_level, legacy_ref: c.legacy_ref });
      }
    }
    return {
      title: row.title,
      order: ci,
      content_items: [],
      children,
      legacy_ref: { toc_id: Number(row.id), path: [] },
    };
  });

  return {
    draft: {
      book: {
        title: book || rows[0].book || '（未命名教材）',
        publisher: rows[0].publisher || '',
        subject_list_id: rows[0].list_id ?? null,
      },
      chapters,
    },
    source_row_ids: rows.map(r => Number(r.id)),
    already_formalized_row_ids: alreadyFormalized,
    unsupported_nodes: unsupported,
    // 內容類型一定要使用者確認：legacy 沒有這個資訊，系統不猜。
    requires_content_confirmation: true,
  };
}
