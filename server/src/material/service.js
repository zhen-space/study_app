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
  await q.run('DELETE FROM material_content_items WHERE user_id=? AND book_id=?', [userId, id]);
  await q.run('DELETE FROM material_nodes WHERE user_id=? AND book_id=?', [userId, id]);
  await q.run('DELETE FROM material_books WHERE user_id=? AND id=?', [userId, id]);
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
// 被 Lock 擋住的 Task 不會被靜默略過，而是原樣回報給呼叫端。
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

export { NODE_KINDS, ITEM_KINDS };
