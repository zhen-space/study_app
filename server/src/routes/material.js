import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as material from '../material/service.js';
import { MaterialInputError } from '../material/service.js';
import { listStudyMaterials, listStudyMaterialShelf } from '../material/library.js';
import { parseMaterialImage, toDraftInput } from '../material/parser.js';
import { importPayloadError } from '../material/draft.js';
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
      if (e.stale) body.stale = true;
      if (e.code) body.code = e.code;
      if (e.preview) body.preview = e.preview;
      if (e.impact) body.impact = e.impact;
      return res.status(e.status || 400).json(body);
    }
    console.error('[material]', e);
    res.status(500).json({ error: '教材操作失敗' });
  }
};

const num = v => (v == null || v === '' ? null : Number(v));

/* ---------- Book ---------- */

router.get('/material/books', handle(async (req, res) => {
  const qy = req.query;
  const inUse = qy.in_use === '1' ? true : qy.in_use === '0' ? false : undefined;
  res.json(await material.listBooks(req.userId, {
    includeArchived: qy.archived === '1',
    filters: {
      subject_list_id: qy.subject_list_id,
      kind: qy.kind,
      plan_id: qy.plan_id,
      in_use: inUse,
    },
  }));
}));

// 匯入／新增前的同名檢查：回傳疑似同名（同名＋同科目）的既有教材，讓前端提供
// 「合併到現有／另存新教材／取消」三選一。這一步不寫任何東西。
router.get('/material/name-check', handle(async (req, res) => {
  const books = await material.sameNameBooks(req.userId, req.query.title || '', req.query.subject_list_id ?? null);
  res.json({ same_name_books: books, has_conflict: books.length > 0 });
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

// 合併／增補目錄 preview：把新 TOC 比對到既有書，回分類與是否需確認順序。不寫入。
router.post('/material/books/:id/merge/preview', handle(async (req, res) => {
  const b = req.body || {};
  res.json(await material.previewBookMerge(req.userId, req.params.id, b.draft ?? b));
}));

// 合併／增補目錄 apply：單一交易併入既有書，保留完成度／選取／Task linkage。
router.post('/material/books/:id/merge', handle(async (req, res) => {
  const b = req.body || {};
  res.status(201).json(await material.applyBookMerge(req.userId, req.params.id, b.draft ?? b, {
    expectedFingerprint: b.expected_fingerprint ?? null,
    confirmOrder: b.confirm_order === true,
    confirmDuplicates: b.confirm_duplicates === true,
  }));
}));

// 刪除的正常語意是「真正的 soft-delete（tombstone）」：教材從教材庫消失，但完成度／
// StudySession／ScheduleVersion／ScheduledBlock 等歷史一律保留、不 cascade。
// active／paused Plan 正在選用時擋下（409 IN_USE_BY_ACTIVE_PLAN），帶 ?unlink=1 先安全
// 解除關聯再刪。?hard=1 仍可對「完全沒有任何 reference」的乾淨書做實體清除。
router.delete('/material/books/:id', handle(async (req, res) => {
  if (req.query.hard === '1') return res.json(await material.hardDeleteBook(req.userId, req.params.id));
  res.json(await material.softDeleteBook(req.userId, req.params.id, { unlink: req.query.unlink === '1' }));
}));

// 刪除前的 CURRENT 影響（唯讀）：Plan 依狀態、Task linkage、完成度、StudySession、
// ScheduledBlock 等，以及會擋刪除的 active／paused 計畫清單。
router.get('/material/books/:id/impact', handle(async (req, res) => {
  res.json(await material.bookImpact(req.userId, req.params.id));
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

// 打錯字要有得救。改名不換 identity——完成度、Plan selection 與既有 Task
// 的 linkage 全部原樣保留，改的是同一筆東西的名字，不是換一個東西。
router.patch('/material/nodes/:id', handle(async (req, res) => {
  res.json(await material.updateNode(req.userId, req.params.id, req.body || {}));
}));

router.patch('/material/content-items/:id', handle(async (req, res) => {
  res.json(await material.updateContentItem(req.userId, req.params.id, req.body || {}));
}));

// 刪除只在完全沒有使用紀錄時才成立。有完成度／計畫選取／任務的一律 409，
// 並把 references 一起回去讓畫面說得出「為什麼不能刪」。
router.delete('/material/nodes/:id', handle(async (req, res) => {
  res.json(await material.deleteNode(req.userId, req.params.id));
}));

router.delete('/material/content-items/:id', handle(async (req, res) => {
  res.json(await material.deleteContentItem(req.userId, req.params.id));
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

// 整本教材的快速選取（全選章／節／主題／清除）。一次算完，不是每一章打一次。
// node_kinds 省略＝整本；指定時只動那幾種節點底下的內容。
router.post('/plans/:id/material-books/:bookId', handle(async (req, res) => {
  const body = req.body || {};
  const kinds = Array.isArray(body.node_kinds) ? body.node_kinds : null;
  res.json(await material.selectBookNodes(req.userId, req.params.id, req.params.bookId, {
    selected: body.selected !== false, nodeKinds: kinds,
  }));
}));

/* ---------- 正式 Material import：preview → 使用者確認 → atomic commit ---------- */

// Preview：呼叫正式 parser、回 canonical draft。
//
// **完全不寫資料庫**：不建 Book、不建 Node、不建 ContentItem，也不碰 legacy
// toc_items。這一步只是「AI 讀到了什麼，你要不要」。
router.post('/material/import/preview', handle(async (req, res) => {
  const b = req.body || {};
  const files = b.files?.length
    ? b.files
    : (b.data ? [{ filename: b.filename || '', mime: b.mime || '', data: b.data }] : []);
  // 便宜的輸入驗證（張數／格式／大小）先做，且**不依賴 AI 金鑰**——壞輸入要能明確回報，
  // 不是先卡在「尚未設定金鑰」也不是撞上 body parser 的通用 413。規則見 draft.js（純函式共用）。
  const payloadErr = importPayloadError(files);
  if (payloadErr) return res.status(400).json({ error: payloadErr });
  if (b.subject_list_id != null) {
    const l = await material.assertSubject(req.userId, b.subject_list_id);
    if (!l) return res.status(400).json({ error: '找不到這個科目' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '伺服器尚未設定 AI 金鑰（ANTHROPIC_API_KEY）' });
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
    // 必須把 preview 回傳的那份 source_snapshot 原樣送回來：
    // commit 只能正式化使用者實際看過的那一份舊資料。
    sourceSnapshot: b.source_snapshot,
  }));
}));

/* ---------- Unified student-facing library ---------- */

// 學生只看到一個「教材」的世界：正式 Material 與 legacy 目錄同一個形狀回來，
// 但每一筆都標明 source 與各自的 identity，兩邊永遠不互轉。
// legacy 沒有正式完成度時回 completion_supported: false，不捏造 0%。
router.get('/study-materials', handle(async (req, res) => {
  const opts = {
    planId: num(req.query.plan_id),
    includeLegacy: req.query.legacy !== '0',
  };
  // shelf=1：只要書單。畫一份書單不需要把每一本的完整教材樹都建起來。
  if (req.query.shelf === '1') return res.json(await listStudyMaterialShelf(req.userId, opts));
  res.json(await listStudyMaterials(req.userId, opts));
}));

export default router;
