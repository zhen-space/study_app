// Unified student-facing library：學生只看到一個「教材」的世界。
//
//   正式 Material provider ─┐
//                          ├─► unified library model ─► 前端
//   Legacy compatibility ──┘
//
// 前端之後不該再寫 `if (legacy) … if (material) …`——那是把兩個資料來源的
// 差異外洩給每一個畫面，只要漏掉一處就會出現「舊資料被當成正式教材」。
//
// 但 presentation 一致**不等於** identity 一致：
//   ・正式 Material：source='material'，帶 material_book_id / material_node_id /
//     material_content_item_id，有真正的 completion
//   ・Legacy：source='legacy'，帶 legacy_ref = { toc_id, path }，
//     completion_supported=false
//
// 兩者的 identity 永遠不互轉，也不做任何 title / 書名 / path 的比對配對。

import { q } from '../db/init.js';
import { listBooks, getBookTree } from './service.js';
import { listLegacyBooks, SOURCE_MATERIAL, SOURCE_LEGACY } from './legacy.js';

// 正式 Material 的樹 → unified 形狀。加上 source 與明確的 identity 欄位。
const materialNode = node => ({
  source: SOURCE_MATERIAL,
  kind: node.kind,
  title: node.title,
  order_index: node.order_index,
  material_node_id: node.id,
  progress: node.progress,
  selection: node.selection,
  completion_supported: true,
  content_items: (node.content_items || []).map(it => ({
    source: SOURCE_MATERIAL,
    kind: it.kind,
    title: it.title,
    order_index: it.order_index,
    material_content_item_id: it.id,
    estimated_minutes: it.estimated_minutes ?? null,
    completed: it.completed,
    selected: it.selected,
    completion_supported: true,
  })),
  children: (node.children || []).map(materialNode),
});

// 一位使用者的完整教材世界。
//
// plan_id 只影響**正式 Material** 的 selection：legacy 沒有 plan_material_items
// 可以指向，所以它永遠沒有 selection，也不假裝有。
export async function listStudyMaterials(userId, { planId = null, includeLegacy = true } = {}) {
  const books = await listBooks(userId);
  const formal = [];
  for (const b of books) {
    const tree = await getBookTree(userId, b.id, { planId });
    formal.push({
      source: SOURCE_MATERIAL,
      material_book_id: b.id,
      title: b.title,
      publisher: b.publisher || '',
      subject_list_id: b.subject_list_id ?? null,
      progress: tree.progress,
      selection: tree.selection,
      completion_supported: true,
      chapters: tree.nodes.map(materialNode),
    });
  }

  const legacy = includeLegacy ? await listLegacyBooks(userId) : [];

  return {
    books: [...formal, ...legacy],
    counts: { material: formal.length, legacy: legacy.length },
  };
}

/* ---------- 書櫃層：只要「有哪些教材」，不要整棵樹 ---------- */

// Step 1 第一眼只需要書名／科目／進度／這次選了幾項。
// 走 listStudyMaterials 會為了畫一份書單把每一本的完整樹都建起來——
// 教材一多就是 N 次全樹查詢，而畫面上一個節點都不會用到。
//
// 回傳形狀與 listStudyMaterials 的 book 相同（少了 chapters、多了 chapter_count），
// 所以前端仍然只認識一種「教材」，不需要分辨資料是從哪一支來的。
export async function listStudyMaterialShelf(userId, { planId = null, includeLegacy = true } = {}) {
  const books = await listBooks(userId);

  // 這個 Plan 在每一本書裡選了幾項。只算「已選且尚未完成」——
  // 與 countSelected 前端規則一致：已完成的不佔這次要讀的份量。
  let selectedBy = new Map();
  if (planId != null) {
    const rows = await q.all(
      `SELECT i.book_id AS book_id, COUNT(*) AS n
         FROM plan_material_items pmi
         JOIN material_content_items i ON i.id=pmi.content_item_id
         LEFT JOIN material_progress p ON p.content_item_id=i.id AND p.user_id=pmi.user_id
        WHERE pmi.user_id=? AND pmi.plan_id=? AND pmi.selected=1
          AND COALESCE(p.completed,0)=0
        GROUP BY i.book_id`, [userId, planId]);
    selectedBy = new Map(rows.map(r => [r.book_id, Number(r.n)]));
  }

  const counts = await q.all(
    'SELECT book_id, COUNT(*) AS n FROM material_nodes WHERE user_id=? AND kind=? GROUP BY book_id',
    [userId, 'chapter']);
  const chapterCount = new Map(counts.map(r => [r.book_id, Number(r.n)]));

  const formal = books.map(b => ({
    source: SOURCE_MATERIAL,
    material_book_id: b.id,
    title: b.title,
    publisher: b.publisher || '',
    subject_list_id: b.subject_list_id ?? null,
    progress: b.progress,
    completion_supported: true,
    requires_content_confirmation: false,
    selectable: true,
    chapter_count: chapterCount.get(b.id) ?? 0,
    selected_count: selectedBy.get(b.id) ?? 0,
  }));

  // legacy 這一段刻意不給 progress、也不給 selected_count：它沒有正式完成度，
  // 更沒有 plan_material_items 可以指向。給 0 會被讀成「有，但是 0」。
  const legacy = includeLegacy
    ? (await listLegacyBooks(userId)).map(b => ({
      source: SOURCE_LEGACY,
      legacy_ref: b.legacy_ref,
      title: b.title,
      publisher: b.publisher,
      subject_list_id: b.subject_list_id,
      completion_supported: false,
      requires_content_confirmation: true,
      selectable: false,
      chapter_count: b.chapters.length,
    }))
    : [];

  return {
    books: [...formal, ...legacy],
    counts: { material: formal.length, legacy: legacy.length },
  };
}

export { SOURCE_MATERIAL, SOURCE_LEGACY };
