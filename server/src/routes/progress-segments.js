import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { buildPlanProgress } from '../schedule/progress.js';
import { todayTW } from '../util/date.js';

// 段考「進度安排」API（A 層）。這是 Plan 內的輕量進度層，跟確切排程（B 層 =
// ScheduleVersion／ScheduledBlock）完全分離：
//   ・這裡只存「範圍目標＋期限」（plan_progress_segments），不建立任何 ScheduledBlock
//   ・完成度不寫這裡；GET 投影時才把 material_progress 的 CURRENT 完成事實疊上去
//   ・一個 Plan 可以只有進度安排、沒有每日精確排程——兩者可各自存在
//
// 契約重點：
//   ・不覆寫 production；純 additive。舊 Plan 沒有 segment＝尚未安排進度。
//   ・scope 的 content item 必須是自己的，否則會變成窺探別人資料的管道（fail-closed）。

const router = Router();
router.use(requireAuth);

const KINDS = ['study', 'review', 'exam'];
const validDate = x => x == null || x === '' || /^\d{4}-\d\d-\d\d$/.test(x);

// 已刪除的 Plan 對所有一般 API 一律不存在（沿用 plans 的慣例）。
const minePlan = (planId, userId) =>
  q.get("SELECT * FROM plans WHERE id=? AND user_id=? AND status<>'deleted'", [planId, userId]);

// scope（content_item_id 陣列）正規化＋擁有權驗證。回傳 { ids, error }。
async function normalizeScope(scope, userId) {
  if (scope == null) return { ids: [], error: null };
  if (!Array.isArray(scope)) return { ids: null, error: '範圍格式不正確' };
  const ids = [...new Set(scope.map(Number).filter(Number.isInteger))];
  if (!ids.length) return { ids: [], error: null };
  const placeholders = ids.map(() => '?').join(',');
  const rows = await q.all(
    `SELECT id FROM material_content_items WHERE user_id=? AND id IN (${placeholders})`,
    [userId, ...ids]);
  if (rows.length !== ids.length) return { ids: null, error: '範圍內有不存在或不屬於你的教材內容' };
  return { ids, error: null };
}

// 把一批 segment row 的 scope_json 解析出來，並補上科目名稱。
function parseSegRows(rows, subjectsById) {
  return rows.map(r => {
    let scope = [];
    try { const p = JSON.parse(r.scope_json || '[]'); if (Array.isArray(p)) scope = p.map(Number).filter(Number.isFinite); } catch {}
    return {
      ...r,
      scope,
      subject_name: r.subject_list_id != null ? (subjectsById.get(Number(r.subject_list_id)) || null) : null,
    };
  });
}

// 讀 Plan 的 segment rows + 完成度，回傳投影。共用給 GET 與寫入後回傳。
async function projectPlan(planId, userId) {
  const rows = await q.all(
    'SELECT * FROM plan_progress_segments WHERE user_id=? AND plan_id=? ORDER BY order_index,end_date,id',
    [userId, planId]);
  const lists = await q.all('SELECT id,name FROM lists WHERE user_id=?', [userId]);
  const subjectsById = new Map(lists.map(l => [Number(l.id), l.name]));
  const segs = parseSegRows(rows, subjectsById);

  // 完成度：只查 scope 內的 content item（CURRENT 完成事實，不臆測）。
  const scopeIds = [...new Set(segs.flatMap(s => s.scope))];
  let completed = new Set();
  if (scopeIds.length) {
    const placeholders = scopeIds.map(() => '?').join(',');
    const done = await q.all(
      `SELECT content_item_id FROM material_progress
        WHERE user_id=? AND completed=1 AND content_item_id IN (${placeholders})`,
      [userId, ...scopeIds]);
    completed = new Set(done.map(r => Number(r.content_item_id)));
  }
  return buildPlanProgress({ segments: segs, completedItemIds: completed, today: todayTW() });
}

// GET：Plan 的進度安排投影（段考進度）。
router.get('/plans/:planId/progress-segments', async (req, res) => {
  const plan = await minePlan(req.params.planId, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到計畫' });
  res.json(await projectPlan(plan.id, req.userId));
});

// 建立／修改共用的欄位驗證。回傳錯誤字串或 null。
async function validateBody(b, userId) {
  if (!String(b.title || '').trim()) return '請輸入這一段的名稱';
  if (b.end_date != null && !validDate(b.end_date)) return '結束日期不正確';
  if (b.start_date != null && !validDate(b.start_date)) return '開始日期不正確';
  if (b.start_date && b.end_date && b.end_date < b.start_date) return '結束日期不能早於開始日期';
  if (b.kind != null && !KINDS.includes(b.kind)) return '進度類型不正確';
  if (b.subject_list_id != null && b.subject_list_id !== '') {
    const l = await q.get('SELECT id FROM lists WHERE id=? AND user_id=?', [b.subject_list_id, userId]);
    if (!l) return '找不到這個科目';
  }
  return null;
}

// POST：新增一段進度安排。
router.post('/plans/:planId/progress-segments', async (req, res) => {
  const plan = await minePlan(req.params.planId, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到計畫' });
  const b = req.body || {};
  if (!b.end_date) return res.status(400).json({ error: '請輸入結束日期' });
  const err = await validateBody(b, req.userId);
  if (err) return res.status(400).json({ error: err });
  const { ids, error } = await normalizeScope(b.scope, req.userId);
  if (error) return res.status(400).json({ error });
  // order_index：沒指定就接在最後。
  const maxRow = await q.get('SELECT MAX(order_index) m FROM plan_progress_segments WHERE user_id=? AND plan_id=?', [req.userId, plan.id]);
  const orderIndex = Number.isInteger(b.order_index) ? b.order_index : (Number(maxRow?.m ?? -1) + 1);
  await q.run(
    `INSERT INTO plan_progress_segments
       (user_id,plan_id,start_date,end_date,subject_list_id,title,scope_json,kind,order_index)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.userId, plan.id, b.start_date || null, b.end_date, b.subject_list_id || null,
      String(b.title).trim(), JSON.stringify(ids), b.kind || 'study', orderIndex]);
  res.status(201).json(await projectPlan(plan.id, req.userId));
});

// PATCH：修改一段。只更新有帶的欄位。
router.patch('/plans/:planId/progress-segments/:id', async (req, res) => {
  const plan = await minePlan(req.params.planId, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到計畫' });
  const seg = await q.get('SELECT * FROM plan_progress_segments WHERE id=? AND user_id=? AND plan_id=?',
    [req.params.id, req.userId, plan.id]);
  if (!seg) return res.status(404).json({ error: '找不到這段進度' });
  const b = req.body || {};
  const merged = {
    title: b.title == null ? seg.title : b.title,
    start_date: b.start_date === undefined ? seg.start_date : b.start_date,
    end_date: b.end_date == null ? seg.end_date : b.end_date,
    kind: b.kind == null ? seg.kind : b.kind,
    subject_list_id: b.subject_list_id === undefined ? seg.subject_list_id : b.subject_list_id,
  };
  const err = await validateBody(merged, req.userId);
  if (err) return res.status(400).json({ error: err });
  let scopeJson = seg.scope_json;
  if (b.scope !== undefined) {
    const { ids, error } = await normalizeScope(b.scope, req.userId);
    if (error) return res.status(400).json({ error });
    scopeJson = JSON.stringify(ids);
  }
  const orderIndex = Number.isInteger(b.order_index) ? b.order_index : seg.order_index;
  await q.run(
    `UPDATE plan_progress_segments SET
       title=?, start_date=?, end_date=?, subject_list_id=?, scope_json=?, kind=?, order_index=?,
       updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND user_id=?`,
    [String(merged.title).trim(), merged.start_date || null, merged.end_date,
      merged.subject_list_id || null, scopeJson, merged.kind || 'study', orderIndex,
      seg.id, req.userId]);
  res.json(await projectPlan(plan.id, req.userId));
});

// DELETE：刪除一段。progress segment 只是學習意圖的紀錄，沒有下游歷史引用
//（不像 Plan／Task），所以直接刪除是安全的，不需要 tombstone。
router.delete('/plans/:planId/progress-segments/:id', async (req, res) => {
  const plan = await minePlan(req.params.planId, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到計畫' });
  const seg = await q.get('SELECT id FROM plan_progress_segments WHERE id=? AND user_id=? AND plan_id=?',
    [req.params.id, req.userId, plan.id]);
  if (!seg) return res.status(404).json({ error: '找不到這段進度' });
  await q.run('DELETE FROM plan_progress_segments WHERE id=? AND user_id=?', [seg.id, req.userId]);
  res.json(await projectPlan(plan.id, req.userId));
});

export default router;
