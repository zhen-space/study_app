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

export { SOURCE_MATERIAL, SOURCE_LEGACY };
