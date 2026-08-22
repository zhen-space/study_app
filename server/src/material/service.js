// Material domain service。所有 material 的 DB 存取只從這裡走。
//
// 三條分界線，動任何一行之前先確認沒有踩到：
//   ① 完成度只寫 material_progress，最小單位是 ContentItem（契約 1）。
//      節點的完成度一律由 tree.js 現算，資料庫裡沒有節點完成欄位可寫。
//   ② Plan 選取只寫 plan_material_items，永遠不碰 material_progress（契約 9）。
//   ③ 排程只認 Task。這個檔案不寫 scheduled_blocks / schedule_versions，
//      需要讓某個 Task 退出未來排程時，一律呼叫既有的 lifecycle
//      transitionTaskOutcome，不另外寫一套（契約 10）。

import { q } from '../db/init.js';
import { transitionTaskOutcome } from '../schedule/persistence.js';
import {
  buildTree, descendantItemIds, nodePlacementProblem, itemPlacementProblem,
  NODE_KINDS, ITEM_KINDS,
} from './tree.js';
import { validateDraft, draftSummary } from './draft.js';
import {
  legacyFormalizationDraft, formalizedSourceRowIds, readLegacyGroup,
  sourceFingerprint, LEGACY_SOURCE_KIND as LEGACY_KIND,
} from './legacy.js';

export class MaterialInputError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'MaterialInputError'; this.status = status; }
}

const now = () => new Date().toISOString();

/* ---------- 取用（一律綁 user_id，避免跨帳號窺探） ---------- */

export const getBook = (userId, id) =>
  q.get('SELECT * FROM material_books WHERE id=? AND user_id=?', [id, userId]);

const mustBook = async (userId, id) => {
  const b = await getBook(userId, id);
  if (!b) throw new MaterialInputError('找不到這本教材', 404);
  return b;
};

const mustNode = async (userId, id) => {
  const n = await q.get('SELECT * FROM material_nodes WHERE id=? AND user_id=?', [id, userId]);
  if (!n) throw new MaterialInputError('找不到這個教材章節', 404);
  return n;
};

const mustItem = async (userId, id) => {
  const it = await q.get('SELECT * FROM material_content_items WHERE id=? AND user_id=?', [id, userId]);
  if (!it) throw new MaterialInputError('找不到這個教材項目', 404);
  return it;
};

const mustPlan = async (userId, id) => {
  const p = await q.get('SELECT * FROM plans WHERE id=? AND user_id=?', [id, userId]);
  if (!p) throw new MaterialInputError('找不到這個計畫', 404);
  return p;
};

/* ---------- Book ---------- */

export async function listBooks(userId, { includeArchived = false } = {}) {
  const rows = await q.all(
    `SELECT * FROM material_books WHERE user_id=? ${includeArchived ? '' : 'AND COALESCE(archived,0)=0'}
      ORDER BY COALESCE(archived,0), title, id`, [userId]);
  if (!rows.length) return [];
  // 進度一次算完，不要一本書打一次 DB。
  const stats = await q.all(
    `SELECT i.book_id,
            COUNT(*) AS total_items,
            SUM(CASE WHEN p.completed=1 THEN 1 ELSE 0 END) AS completed_items
       FROM material_content_items i
       LEFT JOIN material_progress p ON p.content_item_id=i.id AND p.user_id=i.user_id
      WHERE i.user_id=? GROUP BY i.book_id`, [userId]);
  const m = new Map(stats.map(s => [s.book_id, s]));
  return rows.map(b => {
    const s = m.get(b.id);
    const total = s?.total_items ?? 0;
    const done = s?.completed_items ?? 0;
    return { ...b, progress: { total_items: total, completed_items: done, percent: total ? Math.round(done / total * 100) : 0 } };
  });
}

export async function createBook(userId, body = {}) {
  const title = String(body.title || '').trim();
  if (!title) throw new MaterialInputError('請輸入教材名稱');
  if (body.subject_list_id != null) {
    const l = await q.get('SELECT id FROM lists WHERE id=? AND user_id=?', [body.subject_list_id, userId]);
    if (!l) throw new MaterialInputError('找不到這個科目');
  }
  const r = await q.run(
    'INSERT INTO material_books (user_id,title,publisher,subject_list_id,source) VALUES (?,?,?,?,?)',
    [userId, title, body.publisher || '', body.subject_list_id ?? null, body.source || 'manual']);
  return getBook(userId, r.lastInsertRowid);
}

export async function updateBook(userId, id, body = {}) {
  const b = await mustBook(userId, id);
  if (body.title != null && !String(body.title).trim()) throw new MaterialInputError('請輸入教材名稱');
  if (body.subject_list_id != null) {
    const l = await q.get('SELECT id FROM lists WHERE id=? AND user_id=?', [body.subject_list_id, userId]);
    if (!l) throw new MaterialInputError('找不到這個科目');
  }
  await q.run(
    'UPDATE material_books SET title=?,publisher=?,subject_list_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
    [body.title == null ? b.title : String(body.title).trim(),
      body.publisher == null ? b.publisher : body.publisher,
      body.subject_list_id === undefined ? b.subject_list_id : (body.subject_list_id ?? null), id, userId]);
  return getBook(userId, id);
}

// 一本書身上掛著哪些「不能無聲消失」的歷史。hard delete 的唯一判準。
export async function bookReferences(userId, bookId) {
  const one = async (sql, args) => Number((await q.get(sql, args))?.n ?? 0);
  return {
    progress: await one(
      `SELECT COUNT(*) n FROM material_progress p JOIN material_content_items i
         ON i.id=p.content_item_id WHERE p.user_id=? AND i.book_id=?`, [userId, bookId]),
    plan_selections: await one(
      `SELECT COUNT(*) n FROM plan_material_items pmi JOIN material_content_items i
         ON i.id=pmi.content_item_id WHERE pmi.user_id=? AND i.book_id=?`, [userId, bookId]),
    tasks: await one(
      'SELECT COUNT(*) n FROM tasks WHERE user_id=? AND material_book_id=?', [userId, bookId]),
    categories: await one(
      'SELECT COUNT(*) n FROM material_category_books WHERE user_id=? AND book_id=?', [userId, bookId]),
  };
}

export async function archiveBook(userId, id, archived = true) {
  await mustBook(userId, id);
  await q.run(
    'UPDATE material_books SET archived=?,archived_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
    [archived ? 1 : 0, archived ? now() : null, id, userId]);
  return getBook(userId, id);
}

// 契約 5：刪除的正常語意是封存。只有完全乾淨的書才允許真的刪掉——
// 一旦有任何進度／選取／Task／分類 reference，硬刪就是在偽造「這件事沒發生過」。
export async function hardDeleteBook(userId, id) {
  await mustBook(userId, id);
  const refs = await bookReferences(userId, id);
  const blocking = Object.entries(refs).filter(([, n]) => n > 0);
  if (blocking.length) {
    const err = new MaterialInputError('這本教材已經有使用紀錄，只能封存不能刪除', 409);
    err.references = refs;
    throw err;
  }
  // 三段刪除要嘛全成功要嘛全不做：中途失敗會留下「書沒了但節點還在」的孤兒，
  // 而這些孤兒再也沒有入口可以清掉。
  await q.tx(async tx => {
    await tx.run('DELETE FROM material_content_items WHERE user_id=? AND book_id=?', [userId, id]);
    await tx.run('DELETE FROM material_nodes WHERE user_id=? AND book_id=?', [userId, id]);
    await tx.run('DELETE FROM material_books WHERE user_id=? AND id=?', [userId, id]);
  });
  return { deleted: true };
}

/* ---------- Node / ContentItem ---------- */

export async function createNode(userId, body = {}) {
  const book = await mustBook(userId, body.book_id);
  const title = String(body.title || '').trim();
  if (!title) throw new MaterialInputError('請輸入名稱');
  let parent = null;
  if (body.parent_id != null) {
    parent = await mustNode(userId, body.parent_id);
    if (parent.book_id !== book.id) throw new MaterialInputError('上層章節不屬於這本教材');
  }
  const problem = nodePlacementProblem(body.kind, parent?.kind ?? null);
  if (problem) throw new MaterialInputError(problem);
  const r = await q.run(
    'INSERT INTO material_nodes (user_id,book_id,parent_id,kind,title,order_index) VALUES (?,?,?,?,?,?)',
    [userId, book.id, parent?.id ?? null, body.kind, title, Number(body.order_index) || 0]);
  return q.get('SELECT * FROM material_nodes WHERE id=?', [r.lastInsertRowid]);
}

export async function createContentItem(userId, body = {}) {
  const node = await mustNode(userId, body.node_id);
  const title = String(body.title || '').trim();
  if (!title) throw new MaterialInputError('請輸入名稱');
  const problem = itemPlacementProblem(body.kind, node.kind);
  if (problem) throw new MaterialInputError(problem);
  const est = body.estimated_minutes == null || body.estimated_minutes === '' ? null : Number(body.estimated_minutes);
  if (est != null && (!Number.isFinite(est) || est <= 0)) throw new MaterialInputError('預估時間不正確');
  const r = await q.run(
    `INSERT INTO material_content_items (user_id,book_id,node_id,kind,title,estimated_minutes,order_index)
     VALUES (?,?,?,?,?,?,?)`,
    [userId, node.book_id, node.id, body.kind, title, est, Number(body.order_index) || 0]);
  return q.get('SELECT * FROM material_content_items WHERE id=?', [r.lastInsertRowid]);
}

/* ---------- 改名與刪除（打錯字要有得救） ---------- */

// 章／節／主題改名。**只改 title**：kind 換了會讓底下的內容變成非法擺放
// （例如節底下的例題，換成章之後就不合法），那不是「改名」，是重建結構。
export async function updateNode(userId, id, body = {}) {
  const node = await mustNode(userId, id);
  const title = String(body.title ?? '').trim();
  if (!title) throw new MaterialInputError('請輸入名稱');
  await q.run('UPDATE material_nodes SET title=? WHERE id=? AND user_id=?', [title, node.id, userId]);
  return q.get('SELECT * FROM material_nodes WHERE id=?', [node.id]);
}

// ContentItem 改名或改種類。改種類要重驗 placement——把「範例」改成「單元練習」
// 但它掛在節底下，那是非法的（單元練習只屬於章）。
//
// identity 不變：改的是同一筆 ContentItem，所以完成度、Plan selection、
// 既有 Task 的 linkage 全部原樣保留。改名不是換一個東西。
export async function updateContentItem(userId, id, body = {}) {
  const it = await mustItem(userId, id);
  const node = await mustNode(userId, it.node_id);
  const title = body.title === undefined ? it.title : String(body.title ?? '').trim();
  if (!title) throw new MaterialInputError('請輸入名稱');
  const kind = body.kind === undefined ? it.kind : String(body.kind);
  if (!ITEM_KINDS.includes(kind)) throw new MaterialInputError('教材項目類型不正確');
  const problem = itemPlacementProblem(kind, node.kind);
  if (problem) throw new MaterialInputError(problem);
  const est = body.estimated_minutes === undefined
    ? it.estimated_minutes
    : (body.estimated_minutes == null || body.estimated_minutes === '' ? null : Number(body.estimated_minutes));
  if (est != null && (!Number.isFinite(est) || est <= 0)) throw new MaterialInputError('預估時間不正確');
  await q.run(
    'UPDATE material_content_items SET title=?,kind=?,estimated_minutes=? WHERE id=? AND user_id=?',
    [title, kind, est, it.id, userId]);
  return q.get('SELECT * FROM material_content_items WHERE id=?', [it.id]);
}

// 一筆 ContentItem 身上掛著哪些「不能無聲消失」的歷史。
// 與 bookReferences 同一個判準，只是縮到單一項目。
export async function contentItemReferences(userId, itemIds) {
  const ids = (Array.isArray(itemIds) ? itemIds : [itemIds]).map(Number).filter(Number.isFinite);
  if (!ids.length) return { progress: 0, plan_selections: 0, tasks: 0 };
  const holes = ids.map(() => '?').join(',');
  const one = async (sql) => Number((await q.get(sql, [userId, ...ids]))?.n ?? 0);
  return {
    progress: await one(
      `SELECT COUNT(*) n FROM material_progress
        WHERE user_id=? AND completed=1 AND content_item_id IN (${holes})`),
    plan_selections: await one(
      `SELECT COUNT(*) n FROM plan_material_items
        WHERE user_id=? AND selected=1 AND content_item_id IN (${holes})`),
    tasks: await one(
      `SELECT COUNT(*) n FROM tasks
        WHERE user_id=? AND COALESCE(deleted,0)=0 AND material_content_item_id IN (${holes})`),
  };
}

const blockedByHistory = (refs, what) => {
  const blocking = Object.entries(refs).filter(([, n]) => n > 0);
  if (!blocking.length) return null;
  const err = new MaterialInputError(
    `${what}已經有使用紀錄（完成度、計畫選取或任務），不能刪除`, 409);
  err.references = refs;
  return err;
};

// 刪一筆 ContentItem。有任何歷史就不刪——硬刪等於偽造「這件事沒發生過」。
export async function deleteContentItem(userId, id) {
  const it = await mustItem(userId, id);
  const blocked = blockedByHistory(await contentItemReferences(userId, it.id), '這個項目');
  if (blocked) throw blocked;
  await q.run('DELETE FROM material_content_items WHERE id=? AND user_id=?', [it.id, userId]);
  return { deleted: true, id: it.id };
}

// 刪一個章／節／主題，連同底下的內容。同樣的判準，但看的是**整棵子樹**：
// 底下任何一筆有歷史就整個不刪，不做「刪一半」。
export async function deleteNode(userId, id) {
  const node = await mustNode(userId, id);
  const all = await q.all(
    'SELECT id,parent_id FROM material_nodes WHERE user_id=? AND book_id=?', [userId, node.book_id]);
  const subtree = new Set([node.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) {
      if (n.parent_id != null && subtree.has(n.parent_id) && !subtree.has(n.id)) {
        subtree.add(n.id); grew = true;
      }
    }
  }
  const nodeIds = [...subtree];
  const holes = nodeIds.map(() => '?').join(',');
  const items = await q.all(
    `SELECT id FROM material_content_items WHERE user_id=? AND node_id IN (${holes})`,
    [userId, ...nodeIds]);
  const blocked = blockedByHistory(
    await contentItemReferences(userId, items.map(r => r.id)), '這一段');
  if (blocked) throw blocked;
  // 內容與節點要嘛一起消失、要嘛都不動：中途失敗會留下沒有歸屬的孤兒項目。
  await q.tx(async tx => {
    await tx.run(
      `DELETE FROM material_content_items WHERE user_id=? AND node_id IN (${holes})`,
      [userId, ...nodeIds]);
    await tx.run(
      `DELETE FROM material_nodes WHERE user_id=? AND id IN (${holes})`, [userId, ...nodeIds]);
  });
  return { deleted: true, id: node.id, nodes: nodeIds.length, content_items: items.length };
}

/* ---------- 教材樹（含 derived 完成度與 tri-state 選取） ---------- */

const treeInputs = async (userId, bookId, planId) => {
  const nodes = await q.all(
    'SELECT * FROM material_nodes WHERE user_id=? AND book_id=? ORDER BY order_index,id', [userId, bookId]);
  const items = await q.all(
    'SELECT * FROM material_content_items WHERE user_id=? AND book_id=? ORDER BY order_index,id', [userId, bookId]);
  const done = await q.all(
    `SELECT p.content_item_id FROM material_progress p JOIN material_content_items i
       ON i.id=p.content_item_id WHERE p.user_id=? AND i.book_id=? AND p.completed=1`, [userId, bookId]);
  const selected = planId == null ? [] : await q.all(
    `SELECT pmi.content_item_id FROM plan_material_items pmi JOIN material_content_items i
       ON i.id=pmi.content_item_id
      WHERE pmi.user_id=? AND pmi.plan_id=? AND i.book_id=? AND pmi.selected=1`, [userId, planId, bookId]);
  return {
    nodes, items,
    completed: new Set(done.map(r => r.content_item_id)),
    selected: new Set(selected.map(r => r.content_item_id)),
  };
};

export async function getBookTree(userId, bookId, { planId = null } = {}) {
  const book = await mustBook(userId, bookId);
  if (planId != null) await mustPlan(userId, planId);
  const { nodes, items, completed, selected } = await treeInputs(userId, bookId, planId);
  return { book, plan_id: planId ?? null, ...buildTree(nodes, items, { completed, selected }) };
}

/* ---------- Completion（跨 Plan 的全域狀態） ---------- */

const isCompleted = async (userId, itemId) => Number(
  (await q.get('SELECT completed FROM material_progress WHERE user_id=? AND content_item_id=?',
    [userId, itemId]))?.completed ?? 0) === 1;

// 契約 3 的 reconciliation：ContentItem 一旦在任何地方完成，其他 Plan 就不該再
// 把它當成待排程工作。做法刻意用既有 lifecycle 的「取消」——
//   ・取消的語意本來就是「這件工作不再做」，而且已經會安全地退出 active schedule
//   ・不偽造其他 Plan 的 completed 歷史（那會污染 Plan 完成率與 Goal 進度）
//
// 順序是鎖定的產品決策，不要調換：completion 先寫入，再 reconcile。
// Material completion 是「這份教材內容已完成」的長期事實狀態，優先於其他 Plan 的
// Task／Schedule reconciliation；Lock 保護的是既有排程不被自動調整，不得阻止
// completion 本身被記錄。所以這裡失敗的 Task 一律保留原狀並回報，
// 絕不因為某一筆擋住就回頭把 completion 撤銷，也絕不靜默略過。
//
// 實作現況：取消會先把 Task 標為 cancelled，此時它自己的 Task Lock 已不再
// effective，Day／Slice Lock 比較時兩邊也都會濾掉該 block——Lock 不會擋下自己的
// 取消。因此 blocked[] 是防禦性通道（重建 active version 真的失敗時才有內容）。
async function reconcileOtherTasks(userId, itemId, { exceptTaskId = null } = {}) {
  const tasks = await q.all(
    `SELECT id, plan_id FROM tasks
      WHERE user_id=? AND material_content_item_id=? AND COALESCE(deleted,0)=0
        AND completed=0 AND COALESCE(cancelled,0)=0`, [userId, itemId]);
  const out = { cancelled: [], blocked: [] };
  for (const t of tasks) {
    if (exceptTaskId != null && Number(t.id) === Number(exceptTaskId)) continue;
    try {
      await transitionTaskOutcome(userId, t.id, 'cancelled');
      out.cancelled.push({ task_id: t.id, plan_id: t.plan_id });
    } catch (e) {
      out.blocked.push({ task_id: t.id, plan_id: t.plan_id, error: e.message, conflicts: e.conflicts ?? null });
    }
  }
  return out;
}

// 契約 2：使用者可以在 Material 層明確標記完成／未完成。
// 由 Task 完成帶起來時 source='task'，但存下來的仍然是同一份全域狀態；
// Task reopen **不會**呼叫這支把它改回未完成（見 routes/ticktick.js 的說明）。
export async function setCompletion(userId, itemId, { completed, source = 'manual', taskId = null } = {}) {
  await mustItem(userId, itemId);
  if (typeof completed !== 'boolean') throw new MaterialInputError('請指定完成或未完成');
  if (!['manual', 'task'].includes(source)) throw new MaterialInputError('完成來源不正確');
  await q.run(
    `INSERT INTO material_progress (user_id,content_item_id,completed,completed_at,source,source_task_id,updated_at)
     VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(user_id,content_item_id) DO UPDATE SET
       completed=excluded.completed, completed_at=excluded.completed_at,
       source=excluded.source, source_task_id=excluded.source_task_id, updated_at=CURRENT_TIMESTAMP`,
    [userId, itemId, completed ? 1 : 0, completed ? now() : null, source, taskId]);
  const reconciliation = completed
    ? await reconcileOtherTasks(userId, itemId, { exceptTaskId: taskId })
    : { cancelled: [], blocked: [] };
  return {
    content_item_id: Number(itemId),
    completed,
    progress: await q.get('SELECT * FROM material_progress WHERE user_id=? AND content_item_id=?', [userId, itemId]),
    reconciliation,
  };
}

/* ---------- Category（只 reference 書，不複製書） ---------- */

export async function listCategories(userId) {
  const cats = await q.all('SELECT * FROM material_categories WHERE user_id=? ORDER BY order_index,id', [userId]);
  if (!cats.length) return [];
  const links = await q.all(
    `SELECT cb.category_id, b.* FROM material_category_books cb
       JOIN material_books b ON b.id=cb.book_id AND b.user_id=cb.user_id
      WHERE cb.user_id=? ORDER BY cb.order_index, b.id`, [userId]);
  const m = new Map();
  for (const l of links) {
    const { category_id, ...book } = l;
    if (!m.has(category_id)) m.set(category_id, []);
    m.get(category_id).push(book);
  }
  return cats.map(c => ({ ...c, books: m.get(c.id) || [] }));
}

export async function createCategory(userId, body = {}) {
  const name = String(body.name || '').trim();
  if (!name) throw new MaterialInputError('請輸入分類名稱');
  const r = await q.run('INSERT INTO material_categories (user_id,name,order_index) VALUES (?,?,?)',
    [userId, name, Number(body.order_index) || 0]);
  return q.get('SELECT * FROM material_categories WHERE id=?', [r.lastInsertRowid]);
}

const mustCategory = async (userId, id) => {
  const c = await q.get('SELECT * FROM material_categories WHERE id=? AND user_id=?', [id, userId]);
  if (!c) throw new MaterialInputError('找不到這個分類', 404);
  return c;
};

// 加入分類只是建立一條 reference。同一本書可以同時在很多個分類裡，
// 而且永遠是同一本書——不複製，所以進度不會分裂成兩份。
export async function addBookToCategory(userId, categoryId, bookId) {
  await mustCategory(userId, categoryId);
  await mustBook(userId, bookId);
  await q.run(
    `INSERT INTO material_category_books (user_id,category_id,book_id,order_index) VALUES (?,?,?,0)
     ON CONFLICT(category_id,book_id) DO NOTHING`, [userId, categoryId, bookId]);
  return { category_id: Number(categoryId), book_id: Number(bookId), linked: true };
}

export async function removeBookFromCategory(userId, categoryId, bookId) {
  await mustCategory(userId, categoryId);
  // 移除的只有 reference。書、書的進度、書底下的 Task 都不受影響。
  await q.run('DELETE FROM material_category_books WHERE user_id=? AND category_id=? AND book_id=?',
    [userId, categoryId, bookId]);
  return { category_id: Number(categoryId), book_id: Number(bookId), linked: false };
}

/* ---------- Plan ↔ ContentItem selection ---------- */

const SELECTABLE_PLAN_STATUS = ['draft', 'active'];

export async function getPlanSelection(userId, planId) {
  await mustPlan(userId, planId);
  const rows = await q.all(
    `SELECT pmi.*, i.book_id, i.node_id, i.kind, i.title,
            COALESCE(p.completed,0) AS material_completed
       FROM plan_material_items pmi
       JOIN material_content_items i ON i.id=pmi.content_item_id AND i.user_id=pmi.user_id
       LEFT JOIN material_progress p ON p.content_item_id=i.id AND p.user_id=pmi.user_id
      WHERE pmi.user_id=? AND pmi.plan_id=? ORDER BY i.book_id, i.order_index, i.id`, [userId, planId]);
  return rows.map(r => ({ ...r, selected: !!r.selected, material_completed: !!r.material_completed }));
}

// 契約 6：checked 的意思是「尚未完成，而且這次要排」。
// 已完成的教材不能被選取——它不是「打勾的另一種樣子」，而是根本不該出現在
// 待排清單裡。這裡回 400 而不是靜默略過，才不會讓前端以為選成功了。
export async function selectItems(userId, planId, itemIds, selected) {
  const plan = await mustPlan(userId, planId);
  if (!SELECTABLE_PLAN_STATUS.includes(plan.status)) {
    throw new MaterialInputError('這個計畫目前不參與排程，無法調整教材選取', 409);
  }
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : [itemIds]).map(Number))].filter(Number.isFinite);
  if (!ids.length) throw new MaterialInputError('請選擇教材項目');
  const items = await q.all(
    `SELECT i.id, COALESCE(p.completed,0) AS completed FROM material_content_items i
       LEFT JOIN material_progress p ON p.content_item_id=i.id AND p.user_id=i.user_id
      WHERE i.user_id=? AND i.id IN (${ids.map(() => '?').join(',')})`, [userId, ...ids]);
  if (items.length !== ids.length) throw new MaterialInputError('找不到部分教材項目', 404);
  if (selected) {
    const done = items.filter(i => Number(i.completed) === 1);
    if (done.length) {
      const err = new MaterialInputError('已完成的教材不能再加入排程選取', 409);
      err.completed_item_ids = done.map(i => i.id);
      throw err;
    }
  }
  const out = { selected: [], deselected: [], task_exits: { cancelled: [], blocked: [] } };
  for (const id of ids) {
    if (selected) {
      await q.run(
        `INSERT INTO plan_material_items (user_id,plan_id,content_item_id,selected,removed_at,updated_at)
         VALUES (?,?,?,1,NULL,CURRENT_TIMESTAMP)
         ON CONFLICT(plan_id,content_item_id) DO UPDATE SET
           selected=1, removed_at=NULL, updated_at=CURRENT_TIMESTAMP`, [userId, planId, id]);
      out.selected.push(id);
    } else {
      const exit = await deselectOne(userId, planId, id);
      out.deselected.push(id);
      out.task_exits.cancelled.push(...exit.cancelled);
      out.task_exits.blocked.push(...exit.blocked);
    }
  }
  return out;
}

// 契約 4：取消選取只代表「這次 Plan 不排它」，不代表教材完成，也不刪 Task。
//   ・material_progress 完全不動
//   ・selection 列保留，只是 selected=0 並記下 removed_at（provenance）
//   ・已產生但尚未完成的 Task 走既有 lifecycle 取消，安全退出 active schedule；
//     Task 本身仍在，material_content_item_id 也還在，歷史查得到
async function deselectOne(userId, planId, itemId) {
  const row = await q.get(
    'SELECT * FROM plan_material_items WHERE user_id=? AND plan_id=? AND content_item_id=?',
    [userId, planId, itemId]);
  if (!row) return { cancelled: [], blocked: [] };
  await q.run(
    `UPDATE plan_material_items SET selected=0, removed_at=?, updated_at=CURRENT_TIMESTAMP
      WHERE user_id=? AND plan_id=? AND content_item_id=?`, [now(), userId, planId, itemId]);
  const tasks = await q.all(
    `SELECT id FROM tasks WHERE user_id=? AND plan_id=? AND material_content_item_id=?
       AND COALESCE(deleted,0)=0 AND completed=0 AND COALESCE(cancelled,0)=0`, [userId, planId, itemId]);
  const out = { cancelled: [], blocked: [] };
  for (const t of tasks) {
    try {
      await transitionTaskOutcome(userId, t.id, 'cancelled');
      out.cancelled.push({ task_id: t.id, plan_id: Number(planId) });
    } catch (e) {
      out.blocked.push({ task_id: t.id, plan_id: Number(planId), error: e.message, conflicts: e.conflicts ?? null });
    }
  }
  return out;
}

// tri-state 批次選取：使用者點的是節點，實際寫入的永遠是底下的 ContentItem。
// 節點自己沒有任何可寫狀態，所以這支不可能改到 completion（契約 6）。
export async function selectNode(userId, planId, nodeId, selected) {
  const node = await mustNode(userId, nodeId);
  const nodes = await q.all(
    'SELECT * FROM material_nodes WHERE user_id=? AND book_id=?', [userId, node.book_id]);
  const items = await q.all(
    'SELECT * FROM material_content_items WHERE user_id=? AND book_id=?', [userId, node.book_id]);
  const ids = descendantItemIds(node.id, nodes, items);
  if (!ids.length) return { selected: [], deselected: [], task_exits: { cancelled: [], blocked: [] } };
  if (selected) {
    // 批次選取時，已完成的項目安靜地跳過而不是讓整批失敗——
    // 使用者點的是「整章」，本來就不是在對已完成的項目表態。
    const open = await q.all(
      `SELECT i.id FROM material_content_items i
         LEFT JOIN material_progress p ON p.content_item_id=i.id AND p.user_id=i.user_id
        WHERE i.user_id=? AND i.id IN (${ids.map(() => '?').join(',')}) AND COALESCE(p.completed,0)=0`,
      [userId, ...ids]);
    if (!open.length) return { selected: [], deselected: [], task_exits: { cancelled: [], blocked: [] } };
    return selectItems(userId, planId, open.map(r => r.id), true);
  }
  return selectItems(userId, planId, ids, false);
}

// 整本教材的快速選取：全選章／全選節／全選主題／清除。
//
// 為什麼是一支 API 而不是讓前端對每一章各打一次 selectNode：
// 12 章就是 12 個 request，而且它們會各自 reconcile、各自回一份 task_exits，
// 使用者看到的是一連串閃動。這裡一次算完要動哪些 ContentItem，走同一支
// selectItems，所以 reconciliation 與 Lock 的行為完全一樣。
//
// nodeKinds 省略＝整本（章直屬的內容也算）。指定時只取那些 kind 的節點底下的內容，
// 例如 ['section'] 就是「全選節」。教材裡沒有那一層時回空結果，不是錯誤——
// 不是每一本書都有主題。
export async function selectBookNodes(userId, planId, bookId, { selected = true, nodeKinds = null } = {}) {
  const book = await mustBook(userId, bookId);
  const items = await q.all(
    `SELECT i.id, i.node_id, n.kind AS node_kind
       FROM material_content_items i
       JOIN material_nodes n ON n.id=i.node_id AND n.user_id=i.user_id
      WHERE i.user_id=? AND i.book_id=?`, [userId, book.id]);
  const wanted = nodeKinds == null
    ? items
    : items.filter(r => nodeKinds.includes(r.node_kind));
  const ids = wanted.map(r => Number(r.id));
  if (!ids.length) return { selected: [], deselected: [], task_exits: { cancelled: [], blocked: [] } };

  if (selected) {
    // 已完成的安靜跳過：使用者按的是「全選節」，不是在對已完成的項目表態。
    const open = await q.all(
      `SELECT i.id FROM material_content_items i
         LEFT JOIN material_progress p ON p.content_item_id=i.id AND p.user_id=i.user_id
        WHERE i.user_id=? AND i.id IN (${ids.map(() => '?').join(',')}) AND COALESCE(p.completed,0)=0`,
      [userId, ...ids]);
    if (!open.length) return { selected: [], deselected: [], task_exits: { cancelled: [], blocked: [] } };
    return selectItems(userId, planId, open.map(r => r.id), true);
  }
  return selectItems(userId, planId, ids, false);
}

export { NODE_KINDS, ITEM_KINDS };

// 科目必須是這位使用者自己的 lists.id。用名稱比對是不行的。
export const assertSubject = (userId, subjectListId) =>
  q.get('SELECT id FROM lists WHERE id=? AND user_id=?', [subjectListId, userId]);

/* ---------- Canonical draft 的唯一 full-tree writer ---------- */

// 整本教材一次建立，全成功或全不做。
//
// 這是**唯一**的 full-tree writer：import commit 與（未來）手動建立教材都走這裡。
// 兩套 writer 遲早會分岔成「一邊擋得住、另一邊繞得過」，所以不做第二套。
//
// 半本教材是最糟的結果：Book 存在但沒有章、章建了一半、ContentItem 缺一截。
// 學生看到的是一本壞掉的書，而且沒有任何入口可以修。所以全部包在一個
// transaction 裡，任何一步失敗就整筆 rollback。
export async function commitMaterialDraft(userId, input) {
  const { draft, problems } = validateDraft(input);
  if (problems.length) {
    const err = new MaterialInputError('教材內容有問題，尚未建立', 400);
    err.problems = problems;
    throw err;
  }
  return writeDraftTree(userId, draft);
}

// 真正的寫入層，與驗證分開。
//
// 分開有兩個理由：
//   ① 手動建立教材與 import 都只需要「組出 draft → 交給這支」，寫入路徑只有一條
//   ② 驗證擋掉的東西永遠到不了交易裡；交易要防的是**驗證看不到的失敗**
//      （DB 錯誤、併發刪除、bind 失敗）。把兩者分開，rollback 才測得到。
//
// 呼叫端有責任先跑 validateDraft。這支自己也會在迴圈裡再驗一次 placement，
// 但那是 defence in depth，不是主要防線。
export const LEGACY_SOURCE_KIND = LEGACY_KIND;

// sources：這本正式教材是由哪幾列來源資料正式化來的。
// **在同一筆 transaction 內**寫入——provenance 與 Material tree 必須同生共死，
// 否則會出現「教材建好了但沒有來源記錄」（legacy 副本永遠不會被隱藏）
// 或「有來源記錄但沒有教材」（那列 legacy 從此再也無法正式化）。
// verifyInTx：在**交易內**執行的最後一道檢查。放在交易外會有 TOCTOU——
// 檢查完到寫入之間，舊資料仍可能被改動。
export async function writeDraftTree(userId, draft, { sources = [], verifyInTx = null } = {}) {
  // 科目必須是這位使用者自己的 lists.id。用名稱比對是不行的：
  // 名稱可以重複、可以改，不是 identity。
  if (draft.book.subject_list_id != null) {
    const l = await q.get('SELECT id FROM lists WHERE id=? AND user_id=?',
      [draft.book.subject_list_id, userId]);
    if (!l) throw new MaterialInputError('找不到這個科目', 400);
  }

  const bookId = await q.tx(async tx => {
    if (verifyInTx) await verifyInTx(tx);
    const b = await tx.run(
      `INSERT INTO material_books (user_id,title,publisher,subject_list_id,source)
       VALUES (?,?,?,?,?)`,
      [userId, draft.book.title, draft.book.publisher || '',
        draft.book.subject_list_id ?? null, 'ocr_import']);
    const id = Number(b.lastInsertRowid);

    const addItems = async (nodeId, nodeKind, list) => {
      for (const it of list) {
        // 每一筆都再驗一次 placement：呼叫端就算繞過 validateDraft 也進不來。
        const problem = itemPlacementProblem(it.kind, nodeKind);
        if (problem) throw new MaterialInputError(problem, 400);
        await tx.run(
          `INSERT INTO material_content_items
             (user_id,book_id,node_id,kind,title,estimated_minutes,order_index)
           VALUES (?,?,?,?,?,?,?)`,
          [userId, id, nodeId, it.kind, it.title, it.estimated_minutes ?? null, it.order]);
      }
    };

    for (const ch of draft.chapters) {
      const chProblem = nodePlacementProblem('chapter', null);
      if (chProblem) throw new MaterialInputError(chProblem, 400);
      const c = await tx.run(
        `INSERT INTO material_nodes (user_id,book_id,parent_id,kind,title,order_index)
         VALUES (?,?,?,?,?,?)`,
        [userId, id, null, 'chapter', ch.title, ch.order]);
      const chapterId = Number(c.lastInsertRowid);
      await addItems(chapterId, 'chapter', ch.content_items);

      for (const child of ch.children) {
        // Section 與 Topic 都直接掛在章底下——這一行就是「同層」的實作。
        const problem = nodePlacementProblem(child.kind, 'chapter');
        if (problem) throw new MaterialInputError(problem, 400);
        const n = await tx.run(
          `INSERT INTO material_nodes (user_id,book_id,parent_id,kind,title,order_index)
           VALUES (?,?,?,?,?,?)`,
          [userId, id, chapterId, child.kind, child.title, child.order]);
        await addItems(Number(n.lastInsertRowid), child.kind, child.content_items);
      }
    }
    // provenance 與教材樹同一筆交易。UNIQUE(user_id, source_kind, source_row_id)
    // 會擋下重複正式化——第二次嘗試整筆 rollback，不會生出第二本重複的書。
    for (const src of sources) {
      await tx.run(
        `INSERT INTO material_book_sources (user_id,book_id,source_kind,source_row_id)
         VALUES (?,?,?,?)`,
        [userId, id, src.source_kind, src.source_row_id]);
    }
    return id;
  });

  return { book: await getBook(userId, bookId), summary: draftSummary(draft) };
}

// preview 用：只驗證與統計，**完全不寫資料庫**。
export function previewMaterialDraft(input) {
  const { draft, problems } = validateDraft(input);
  return { ok: problems.length === 0, problems, draft, summary: draftSummary(draft) };
}

/* ---------- Just-in-time formalization ---------- */

// 學生第一次真的要用這本舊教材時才發生。學生看到的只有「確認這本教材裡有哪些
// 內容」；legacy / migration / formalization / identity 全部是系統內部的事。
//
// 系統 deterministic 帶入結構（書名、出版社、科目、章、節／主題），
// ContentItem 的 kind 一律由使用者確認——legacy 沒有存這個資訊，猜就是無中生有。
export async function getLegacyFormalizationPreview(userId, { listId, book = '' }) {
  const out = await legacyFormalizationDraft(userId, { listId, book });
  if (!out) throw new MaterialInputError('找不到這本教材', 404);
  if (out.already_formalized_row_ids.length) {
    const err = new MaterialInputError('這本教材已經整理過了', 409);
    err.already_formalized_row_ids = out.already_formalized_row_ids;
    throw err;
  }
  return out;
}

// 使用者確認之後的 atomic 正式化。
//
// Material tree 與 provenance 在**同一筆 transaction**內建立：
//   ・任一步失敗 → 整筆 rollback，不留下半本教材，也不留下孤兒 provenance
//   ・使用者取消 → 根本不會呼叫這支，什麼都不會寫
//   ・重複正式化 → UNIQUE(user_id, source_kind, source_row_id) 擋下並整筆 rollback
export async function formalizeLegacyBook(userId, { listId, book = '', draft, sourceSnapshot } = {}) {
  // 使用者確認過的 draft 仍要完整驗證：結構是我們給的，內容是使用者填的。
  const { draft: valid, problems } = validateDraft(draft);
  if (problems.length) {
    const err = new MaterialInputError('教材內容有問題，尚未建立', 400);
    err.problems = problems;
    throw err;
  }

  // commit 的授權依據是**使用者實際 preview 過的那份 snapshot**，
  // 不是「現在 (list_id, book) 底下有哪些列」。少了這一步，preview 之後新增的
  // 舊資料列會被一起吃進 provenance 並從教材世界消失，但使用者根本沒看過它。
  const snap = sourceSnapshot;
  if (!snap || !Array.isArray(snap.row_ids) || !snap.row_ids.length || !snap.fingerprint) {
    throw new MaterialInputError('缺少教材來源資訊，請重新確認一次教材內容', 400);
  }
  if (snap.source_kind !== LEGACY_SOURCE_KIND) {
    throw new MaterialInputError('教材來源資訊不正確', 400);
  }
  const wantIds = [...new Set(snap.row_ids.map(Number))].sort((a, b) => a - b);

  const stale = message => {
    const err = new MaterialInputError(message, 409);
    err.stale = true;
    return err;
  };

  // 全部檢查都在**交易內**再跑一次：放在交易外會有 TOCTOU——
  // 檢查完到寫入之間，舊資料仍可能被改動。
  const verifyInTx = async tx => {
    // ① 有沒有哪一列已經被正式化過
    const done = await tx.all(
      `SELECT source_row_id FROM material_book_sources
        WHERE user_id=? AND source_kind=? AND source_row_id IN (${wantIds.map(() => '?').join(',')})`,
      [userId, LEGACY_SOURCE_KIND, ...wantIds]);
    if (done.length) {
      const err = new MaterialInputError('這本教材已經整理過了', 409);
      err.already_formalized_row_ids = done.map(r => Number(r.source_row_id));
      throw err;
    }
    // ② 快照描述的就是這一組嗎？
    //    group 查詢是 user-scoped，所以「成員完全相同」同時證明了三件事：
    //    每一列都存在、每一列都屬於這位使用者、而且沒有多出／少掉。
    //    row_ids 被竄改成別人的列時，這裡就對不上。
    //
    //    (list_id, book) 只用來「找出這一組」——它是舊資料模型留下的
    //    compatibility grouping，不是 commit 的授權依據。
    const group = await tx.all(
      `SELECT * FROM toc_items WHERE user_id=? AND list_id=? AND COALESCE(book,'')=?
        ORDER BY order_index, id`, [userId, snap.list_id ?? listId, snap.book ?? book]);
    const nowIds = group.map(r => Number(r.id)).sort((a, b) => a - b);
    if (JSON.stringify(nowIds) !== JSON.stringify(wantIds)) {
      throw stale('這本教材的內容已經變動，請重新確認一次');
    }
    // ③ 內容有沒有被改過。指紋涵蓋所有會影響 draft 的欄位，
    //    所以改章名、改 sections、改順序、改書名／出版社都會被抓到。
    if (sourceFingerprint(group) !== snap.fingerprint) {
      throw stale('這本教材的內容已經變動，請重新確認一次');
    }
  };

  // 來源列一律以 snapshot 為準，不是重新查出來的分組——
  // 否則 preview 之後新增的那一列就會被偷偷吃進 provenance。
  const sources = wantIds.map(id => ({ source_kind: LEGACY_SOURCE_KIND, source_row_id: id }));
  const out = await writeDraftTree(userId, valid, { sources, verifyInTx });
  return { ...out, source_row_ids: wantIds };
}

export { formalizedSourceRowIds };
