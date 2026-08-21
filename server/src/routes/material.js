import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as material from '../material/service.js';
import { MaterialInputError } from '../material/service.js';
import { listStudyMaterials } from '../material/library.js';
import { parseMaterialImage, toDraftInput } from '../material/parser.js';
import { toContentBlock, createFast, parseStructuredObj, aiError } from './import.js';

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
      if (e.problems) body.problems = e.problems;
      if (e.already_formalized_row_ids) body.already_formalized_row_ids = e.already_formalized_row_ids;
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

/* ---------- 正式 Material import：preview → 使用者確認 → atomic commit ---------- */

// Preview：呼叫正式 parser、回 canonical draft。
//
// **完全不寫資料庫**：不建 Book、不建 Node、不建 ContentItem，也不碰 legacy
// toc_items。這一步只是「AI 讀到了什麼，你要不要」。
router.post('/material/import/preview', handle(async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '伺服器尚未設定 AI 金鑰（ANTHROPIC_API_KEY）' });
  }
  const b = req.body || {};
  const files = b.files?.length
    ? b.files
    : (b.data ? [{ filename: b.filename || '', mime: b.mime || '', data: b.data }] : []);
  if (!files.length) return res.status(400).json({ error: '沒有收到檔案' });
  if (files.length > 12) return res.status(400).json({ error: '一次最多 12 張照片' });
  if (b.subject_list_id != null) {
    const l = await material.assertSubject(req.userId, b.subject_list_id);
    if (!l) return res.status(400).json({ error: '找不到這個科目' });
  }

  const blocks = [];
  for (let i = 0; i < files.length; i++) {
    if (files.length > 1) blocks.push({ type: 'text', text: `【第 ${i + 1} 張／共 ${files.length} 張】` });
    blocks.push(await toContentBlock(files[i].filename, files[i].mime, files[i].data));
  }

  let parsed;
  try {
    const response = await parseMaterialImage(blocks, { createFn: createFast });
    if (response.stop_reason === 'refusal') {
      return res.status(400).json({ error: 'AI 無法處理這份檔案，請換一張更清楚的照片' });
    }
    parsed = parseStructuredObj(response);
  } catch (err) {
    console.error('material import parse error:', err.message);
    return res.status(500).json({ error: aiError(err) });
  }

  const input = toDraftInput(parsed, {
    subjectListId: num(b.subject_list_id),
    fallbackTitle: b.title || '',
  });
  // validateDraft 會把不合法的結構（例如 Topic 巢狀在 Section 底下、
  // 單元練習被塞進節裡）逐條列出來，不讓它進到 commit。
  res.json(material.previewMaterialDraft(input));
}));

// Commit：把使用者確認過的 canonical draft 一次建立完整教材樹。
// 全成功或全不做——不會留下半本教材。
router.post('/material/import/commit', handle(async (req, res) => {
  res.status(201).json(await material.commitMaterialDraft(req.userId, req.body?.draft ?? req.body));
}));

/* ---------- 舊教材的 just-in-time 整理 ---------- */

// 學生第一次真的要用這本舊教材時才走這裡。
//
// 回傳的 draft 已經把能 deterministic 判斷的結構填好（書名、出版社、科目、
// 章、節／主題，含巢狀 Topic 的攤平結果），但每個節點的 content_items 都是空的：
// 舊資料完全沒有存「課本內容／範例／例題」這種資訊，系統不猜。
//
// 這一步**不寫任何東西**。使用者取消就什麼都不會發生。
router.get('/material/legacy-books/:listId/content-check', handle(async (req, res) => {
  res.json(await material.getLegacyFormalizationPreview(req.userId, {
    listId: Number(req.params.listId), book: req.query.book || '',
  }));
}));

// 使用者確認內容之後：教材樹與來源記錄在同一筆交易內建立。
// 之後這本教材就是正式 Material，Step 1 只使用正式的 material_content_item_id。
router.post('/material/legacy-books/:listId/content-check', handle(async (req, res) => {
  const b = req.body || {};
  res.status(201).json(await material.formalizeLegacyBook(req.userId, {
    listId: Number(req.params.listId), book: b.book || '', draft: b.draft,
  }));
}));

/* ---------- Unified student-facing library ---------- */

// 學生只看到一個「教材」的世界：正式 Material 與 legacy 目錄同一個形狀回來，
// 但每一筆都標明 source 與各自的 identity，兩邊永遠不互轉。
// legacy 沒有正式完成度時回 completion_supported: false，不捏造 0%。
router.get('/study-materials', handle(async (req, res) => {
  res.json(await listStudyMaterials(req.userId, {
    planId: num(req.query.plan_id),
    includeLegacy: req.query.legacy !== '0',
  }));
}));

export default router;
