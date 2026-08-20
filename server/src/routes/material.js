import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as material from '../material/service.js';
import { MaterialInputError } from '../material/service.js';

// Material domain API。所有邏輯都在 material/service.js，這一層只負責
// HTTP 形狀與錯誤碼——路由裡不寫任何 SQL，也不重算 derived 數字。
const router = Router();
router.use(requireAuth);

// service 丟出的 MaterialInputError 帶著自己的 status；其他例外一律 500。
const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof MaterialInputError) {
      const body = { error: e.message };
      if (e.references) body.references = e.references;
      if (e.completed_item_ids) body.completed_item_ids = e.completed_item_ids;
      return res.status(e.status || 400).json(body);
    }
    console.error('[material]', e);
    res.status(500).json({ error: '教材操作失敗' });
  }
};

const num = v => (v == null || v === '' ? null : Number(v));

/* ---------- Book ---------- */

router.get('/material/books', handle(async (req, res) => {
  res.json(await material.listBooks(req.userId, { includeArchived: req.query.archived === '1' }));
}));

router.post('/material/books', handle(async (req, res) => {
  res.status(201).json(await material.createBook(req.userId, req.body || {}));
}));

router.patch('/material/books/:id', handle(async (req, res) => {
  res.json(await material.updateBook(req.userId, req.params.id, req.body || {}));
}));

// 教材樹。帶 plan_id 時同時回這個 Plan 的 tri-state 選取狀態，
// 但 selection 與 completion 是兩組獨立欄位，前端不要用其中一個推另一個。
router.get('/material/books/:id/tree', handle(async (req, res) => {
  res.json(await material.getBookTree(req.userId, req.params.id, { planId: num(req.query.plan_id) }));
}));

router.get('/material/books/:id/references', handle(async (req, res) => {
  const refs = await material.bookReferences(req.userId, req.params.id);
  res.json({ references: refs, can_hard_delete: Object.values(refs).every(n => n === 0) });
}));

// 刪除的正常語意就是封存，所以 DELETE 預設走 archive。
// 真的要 hard delete 必須明確帶 ?hard=1，而且完全沒有歷史 reference 才會成功。
router.delete('/material/books/:id', handle(async (req, res) => {
  if (req.query.hard === '1') return res.json(await material.hardDeleteBook(req.userId, req.params.id));
  res.json(await material.archiveBook(req.userId, req.params.id, true));
}));

router.post('/material/books/:id/unarchive', handle(async (req, res) => {
  res.json(await material.archiveBook(req.userId, req.params.id, false));
}));

/* ---------- Node / ContentItem ---------- */

router.post('/material/nodes', handle(async (req, res) => {
  res.status(201).json(await material.createNode(req.userId, req.body || {}));
}));

router.post('/material/content-items', handle(async (req, res) => {
  res.status(201).json(await material.createContentItem(req.userId, req.body || {}));
}));

/* ---------- Completion（ContentItem 專屬，跨 Plan 全域） ---------- */

// 只有 ContentItem 有這個端點。Chapter / Section / Topic 沒有對應的 completion
// 端點，這是刻意的：它們的完成度一律 derived（契約 1）。
router.put('/material/content-items/:id/completion', handle(async (req, res) => {
  const body = req.body || {};
  res.json(await material.setCompletion(req.userId, req.params.id, {
    completed: body.completed, source: 'manual',
  }));
}));

/* ---------- Category ---------- */

router.get('/material/categories', handle(async (req, res) => {
  res.json(await material.listCategories(req.userId));
}));

router.post('/material/categories', handle(async (req, res) => {
  res.status(201).json(await material.createCategory(req.userId, req.body || {}));
}));

router.put('/material/categories/:id/books/:bookId', handle(async (req, res) => {
  res.json(await material.addBookToCategory(req.userId, req.params.id, req.params.bookId));
}));

router.delete('/material/categories/:id/books/:bookId', handle(async (req, res) => {
  res.json(await material.removeBookFromCategory(req.userId, req.params.id, req.params.bookId));
}));

/* ---------- Plan selection ---------- */

router.get('/plans/:id/material-items', handle(async (req, res) => {
  res.json(await material.getPlanSelection(req.userId, req.params.id));
}));

// 單一或批次的 ContentItem 選取。selected=false 時不刪 Task，
// 而是讓既有未完成 Task 走 lifecycle 安全退出排程，回傳 task_exits 交代結果。
router.post('/plans/:id/material-items', handle(async (req, res) => {
  const body = req.body || {};
  res.json(await material.selectItems(
    req.userId, req.params.id, body.content_item_ids ?? body.content_item_id, body.selected !== false));
}));

// 節點層的 tri-state 批次選取。只會寫底下的 ContentItem selection，
// 不可能改到任何 completion。
router.post('/plans/:id/material-nodes/:nodeId', handle(async (req, res) => {
  const body = req.body || {};
  res.json(await material.selectNode(req.userId, req.params.id, req.params.nodeId, body.selected !== false));
}));

export default router;
