import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { classifyScheduleHealth } from '../schedule/health.js';
import { todayTW } from '../util/date.js';
import { findSelfCollisions } from '../schedule/feasibility.js';
import { transitionPlanLifecycle } from '../schedule/persistence.js';
import { parseRetainChoice } from '../schedule/plan-cleanup.js';

// Plan＝有目標、範圍、期限與生命週期的工作單位。
// 契約見 docs/phase2-plan-domain.md，動之前先讀。重點：
//   - Plan ≠ 科目。一個科目可以有多個 Plan，一個 Plan 也可以跨科目
//   - primary_list_id 只是主要分類／顯示用，不是 Plan 的身分
//   - 進度不存在 plans 表，一律從底下的 tasks 算，免得兩邊不同步
//   - 封存不等於刪除。Phase 2A 不提供刪除 Plan

const router = Router();
router.use(requireAuth);

// 可查詢／可指定的狀態。'deleted' 刻意不在裡面：它是 tombstone，一般 UI 完全
// 看不到，也不能被 ?status= 撈出來，否則「刪除」就只是換個分頁而已。
const STATUS = ['draft', 'active', 'paused', 'completed', 'ended', 'archived'];
const SOURCE = ['manual', 'ai', 'legacy_migration', 'import'];
const now = () => new Date().toISOString();

// 已刪除的計畫對所有一般 API 一律不存在（404），不是「找得到但標成已刪除」。
const mine = (id, userId) =>
  q.get("SELECT * FROM plans WHERE id=? AND user_id=? AND status<>'deleted'", [id, userId]);

// 建立／修改共用的欄位檢查。回傳錯誤訊息字串，沒問題回 null。
async function validate(body, userId, base = {}) {
  const v = { ...base, ...body };
  if (!String(v.name || '').trim()) return '請輸入計畫名稱';
  if (v.status != null && !STATUS.includes(v.status)) return '計畫狀態不正確';
  if (v.source != null && !SOURCE.includes(v.source)) return '計畫來源不正確';
  if (v.start_date && v.target_date && v.target_date < v.start_date) return '結束日期不能早於開始日期';
  // 引用的科目／目標必須是自己的，不然就能藉此窺探別人的資料
  if (v.primary_list_id != null) {
    const l = await q.get('SELECT id FROM lists WHERE id=? AND user_id=?', [v.primary_list_id, userId]);
    if (!l) return '找不到這個科目';
  }
  if (v.goal_id != null) {
    const goal = await q.get('SELECT id FROM goals WHERE id=? AND user_id=?', [v.goal_id, userId]);
    if (!goal) return '找不到這個目標';
  }
  return null;
}

// 進度一律現算：一次 LEFT JOIN 帶出所有 Plan 的任務數，不要一個 Plan 打一次 DB
async function withCounts(rows, userId) {
  if (!rows.length) return [];
  const stats = await q.all(
    `SELECT plan_id,
            COUNT(*) task_count,
            SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) completed_task_count,
            SUM(CASE WHEN COALESCE(cancelled,0)=1 THEN 1 ELSE 0 END) cancelled_task_count
     FROM tasks WHERE user_id=? AND plan_id IS NOT NULL AND COALESCE(deleted,0)=0
     GROUP BY plan_id`, [userId]);
  const m = new Map(stats.map(s => [s.plan_id, s]));
  return rows.map(p => ({
    ...p,
    task_count: m.get(p.id)?.task_count ?? 0,
    completed_task_count: m.get(p.id)?.completed_task_count ?? 0,
    cancelled_task_count: m.get(p.id)?.cancelled_task_count ?? 0,
  }));
}

// GET /api/plans?status=active&includeArchived=1
router.get('/plans', async (req, res) => {
  const args = [req.userId];
  // tombstone 一律不出現，includeArchived 也撈不出來
  let sql = "SELECT * FROM plans WHERE user_id=? AND status<>'deleted'";
  if (req.query.status) {
    if (!STATUS.includes(req.query.status)) return res.status(400).json({ error: '計畫狀態不正確' });
    sql += ' AND status=?';
    args.push(req.query.status);
  } else if (!req.query.includeArchived) {
    sql += " AND status<>'archived'";       // 封存的預設不出現在一般清單
  }
  sql += ' ORDER BY COALESCE(start_date, created_at), id';
  res.json(await withCounts(await q.all(sql, args), req.userId));
});

// GET /api/plans/:id → { plan, tasks, summary }
router.get('/plans/:id', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  const tasks = await q.all(
    'SELECT * FROM tasks WHERE user_id=? AND plan_id=? AND COALESCE(deleted,0)=0 ORDER BY due_date, id',
    [req.userId, plan.id]);
  const today = todayTW();
  res.json({
    plan,
    tasks,
    summary: {
      total_tasks: tasks.length,
      completed_tasks: tasks.filter(t => t.completed).length,
      cancelled_tasks: tasks.filter(t => t.cancelled).length,
      remaining_tasks: tasks.filter(t => !t.completed && !t.cancelled).length,
      overdue_tasks: tasks.filter(t => !t.completed && !t.cancelled && t.due_date && t.due_date < today).length,
    },
  });
});

// A2：Today／Replan 的正式 health model。只讀 active ScheduleVersion，不改任何安排。
router.get('/plans/:id/health', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  const today = todayTW();
  const [tasks, state] = await Promise.all([
    q.all('SELECT id,due_date,completed,cancelled,deleted,estimated_minutes FROM tasks WHERE user_id=? AND plan_id=?', [req.userId, plan.id]),
    q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [req.userId]),
  ]);
  // paused／completed／ended／archived Plan 是管理中的資料，不是未來排程工作量；
  // health 不能因此把 Today 誤標成「需要調整」。
  const scheduleParticipates = ['draft', 'active'].includes(plan.status);
  const pending = scheduleParticipates ? tasks.filter(t => !t.completed && !t.cancelled && !t.deleted) : [];
  const activeBlocks = state?.active_version_id == null ? [] : await q.all(
    'SELECT b.*, t.plan_id,t.deadline_date,t.deleted,t.completed,t.cancelled FROM scheduled_blocks b JOIN tasks t ON t.id=b.task_id AND t.user_id=b.user_id WHERE b.user_id=? AND b.schedule_version_id=?', [req.userId, state.active_version_id]);
  const planBlocks = scheduleParticipates
    ? activeBlocks.filter(b => Number(b.plan_id) === Number(plan.id) && !b.deleted && !b.completed && !b.cancelled)
    : [];
  const blockIds = new Set(planBlocks.map(b => Number(b.task_id)));
  const overdue = pending.filter(t => t.due_date && t.due_date < today).length;
  const unplaced = state?.active_version_id == null ? pending.filter(t => !t.due_date).length : pending.filter(t => !blockIds.has(Number(t.id))).length;
  const lateTarget = plan.target_date ? pending.filter(t => t.due_date && t.due_date > plan.target_date).length : 0;
  const deadlineViolation = activeBlocks.filter(b => Number(b.plan_id) === Number(plan.id) && b.deadline_date && b.date > b.deadline_date).length;
  const collision = findSelfCollisions(planBlocks.filter(b => !b.deleted && !b.completed && !b.cancelled)).size > 0;
  const estimatedWorkload = pending.reduce((total, task) => total + (Number(task.estimated_minutes) || 0), 0);
  const timedBlocks = planBlocks.filter(b => b.start_time && b.end_time);
  const timedTaskIds = new Set(timedBlocks.map(b => Number(b.task_id)));
  const timedEstimated = pending.filter(t => timedTaskIds.has(Number(t.id))).reduce((total, task) => total + (Number(task.estimated_minutes) || 0), 0);
  const scheduledMinutes = timedBlocks.reduce((total, block) => total + (Number(block.planned_minutes) || 0), 0);
  // 沒有估計時間的舊任務不猜分鐘；有明確 estimate 卻尚未得到同等未來 placement
  // 時，這個 gap 才是 deterministic 的。完整「可用時段不足」仍由 preview 的
  // feasibility response 計算，兩種數字不能混在一起。
  const capacityGap = timedBlocks.length ? Math.max(0, timedEstimated - scheduledMinutes) : 0;
  // Lock 必須是 plan-scoped：Task lock 直接看 task；Time/Day lock 則僅在它碰到
  // 此 Plan 現有 placement 時才影響此 Plan 的 health。
  const locks = await q.all('SELECT * FROM schedule_locks WHERE user_id=? AND released_at IS NULL', [req.userId]);
  const planTaskIds = new Set(tasks.map(t => Number(t.id)));
  const relevantLocks = locks.filter(lock => {
    if (lock.type === 'task') return planTaskIds.has(Number(lock.task_id));
    return planBlocks.some(block => lock.type === 'day'
      ? block.date === lock.date
      : block.date === lock.date && block.start_time && block.end_time && block.start_time < lock.end_time && lock.start_time < block.end_time);
  });
  res.json({ plan_id: plan.id, estimated_workload_minutes: estimatedWorkload, scheduled_minutes: scheduledMinutes,
    ...classifyScheduleHealth({ pending: pending.length, overdue, unplaced, lateTarget, deadlineViolation, collision, locked: relevantLocks.length, capacityGap }) });
});

// POST /api/plans
router.post('/plans', async (req, res) => {
  const b = req.body || {};
  const err = await validate(b, req.userId);
  if (err) return res.status(400).json({ error: err });
  const status = b.status || 'draft';
  // 新計畫只能從可工作的起點建立；其餘狀態必須經 lifecycle endpoint，
  // 才能同時守住確認、版本與 mirror 的交易邊界。
  if (!['draft', 'active'].includes(status)) return res.status(400).json({ error: '新計畫只能建立為草稿或進行中' });
  const r = await q.run(
    `INSERT INTO plans (user_id,name,description,goal_id,primary_list_id,start_date,target_date,status,source,created_at,updated_at,completed_at,archived_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.userId, String(b.name).trim(), b.description || '', b.goal_id ?? null, b.primary_list_id ?? null,
      b.start_date || null, b.target_date || null, status, b.source || 'manual',
      now(), now(), null, null]);
  res.json(await q.get('SELECT * FROM plans WHERE id=?', [r.lastInsertRowid]));
});

// PATCH /api/plans/:id
// user_id / created_at / updated_at / completed_at / archived_at / source 由伺服器決定，
// 客戶端送了也不算數。
const PATCHABLE = ['name', 'description', 'goal_id', 'primary_list_id', 'start_date', 'target_date'];
router.patch('/plans/:id', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  const patch = {};
  for (const k of PATCHABLE) if (k in (req.body || {})) patch[k] = req.body[k];
  if (!Object.keys(patch).length) return res.json(plan);
  const err = await validate(patch, req.userId, plan);
  if (err) return res.status(400).json({ error: err });

  const sets = [], args = [];
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k}=?`); args.push(v === '' ? null : v); }
  sets.push('updated_at=?'); args.push(now());
  args.push(plan.id);
  await q.run(`UPDATE plans SET ${sets.join(',')} WHERE id=?`, args);
  res.json(await q.get('SELECT * FROM plans WHERE id=?', [plan.id]));
});

async function lifecycle(req, res, nextStatus, options = {}) {
  try {
    const out = await transitionPlanLifecycle(req.userId, Number(req.params.id), {
      nextStatus,
      endReason: options.endReason,
      baseVersionId: req.body?.base_version_id,
      cleanupAction: options.cleanupAction ?? null,
      retainIncompleteTasks: options.retainIncompleteTasks,
    });
    // 保留舊 caller 直接讀 plan 欄位的相容性，同時提供明確的 plan/version shape。
    res.json({ ...out.plan, plan: out.plan, schedule_version: out.version });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code, unresolved: err.unresolved, conflicts: err.conflicts });
  }
}

// POST /api/plans/:id/complete
// 完成只代表所有 Task 都已有結果（completed/cancelled）。未解決時不可 force，
// 使用者若不再繼續必須走 ended，不能污染完成率。
router.post('/plans/:id/complete', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  return lifecycle(req, res, 'completed');
});

// POST /api/plans/:id/pause  { retain_incomplete_tasks: true|false }
//
// 暫停後計畫仍在，只是完全退出排程：不參與新排程、不出現在 Today 的執行推薦、
// 不能在 Study 開始讀書、不列入 unplaced。之後可以 resume。
// retain_incomplete_tasks 必填且必須是 boolean——見 plan-cleanup.js。
router.post('/plans/:id/pause', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  const choice = parseRetainChoice(req.body);
  if (!choice.ok) return res.status(400).json({ error: choice.message, code: choice.code });
  return lifecycle(req, res, 'paused', { cleanupAction: 'pause', retainIncompleteTasks: choice.value });
});

// 恢復：未完成 Task 重新取得排程資格，但不會自動恢復舊 ScheduledBlocks
// （新版本只是不再把這個 Plan 排除，block 要重新排才會有）。
// 當初選了不保留的那些 Task 已經是 deleted=1，這裡也不會讓它們復活。
// resume／restart 也要先確認計畫存在。少了這一步，對已刪除的計畫呼叫會拿到
// 400「已經刪除」——那等於告訴呼叫端「這個 id 是有東西的」，跟其他 endpoint
// 一律回 404 的說法也不一致。
router.post('/plans/:id/resume', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  return lifecycle(req, res, 'active');
});
router.post('/plans/:id/restart', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  return lifecycle(req, res, 'active');
});
router.post('/plans/:id/end', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  const unresolved = await q.all('SELECT id,title,due_date FROM tasks WHERE user_id=? AND plan_id=? AND completed=0 AND COALESCE(cancelled,0)=0 AND COALESCE(deleted,0)=0 ORDER BY due_date,id', [req.userId, plan.id]);
  if (unresolved.length && !req.body?.confirm) return res.status(409).json({ error: '結束計畫會保留未完成任務，請明確確認', code: 'end_confirmation_required', plan, unresolved });
  return lifecycle(req, res, 'ended', { endReason: req.body?.reason });
});

// POST /api/plans/:id/archive —— 封存不刪任何 Task
router.post('/plans/:id/archive', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  if (plan.status === 'archived') return res.status(400).json({ error: '計畫已封存' });
  return lifecycle(req, res, 'archived');
});

// POST /api/plans/:id/restore —— 必須回到封存前的 lifecycle，不能一律 active。
router.post('/plans/:id/restore', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  if (plan.status !== 'archived') return res.status(400).json({ error: '只有封存的計畫可以恢復' });
  return lifecycle(req, res, plan.archived_from_status || 'active');
});

// POST /api/plans/:id/delete
//
// soft-delete／tombstone：Plan 與其中**所有** Task（含已完成、已取消）一律
// soft-delete，從一般 UI 完全消失，但底層一列都不刪。硬刪會讓 tasks.plan_id、
// StudySession 與 immutable 的歷史 ScheduledBlock 全部指向不存在的計畫，而歷史
// 版本事後補不回來。soft-delete 也不撤銷既有的 material completion。
//
// 沒有 retain_incomplete_tasks 選擇：產品規格已定案為「整個計畫連同任務都移除」。
// 想保留任務與目前進度但不再繼續，正確操作是「結束計畫」（POST /end）。
//
// 刪除之後不可恢復。本輪刻意不提供 restore contract。
router.post('/plans/:id/delete', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  return lifecycle(req, res, 'deleted', { cleanupAction: 'delete' });
});

// DELETE /api/plans/:id/tasks?incomplete=1
// 重新排程用：只清掉「這個計畫」自己還沒做完的任務。
// 舊的 DELETE /plan-tasks 是照標題/標籤全域猜，正式 Plan 上線後會跨計畫誤刪，
// 所以新流程一律走這支。已完成的一律保留當紀錄。
router.delete('/plans/:id/tasks', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  if (!req.query.incomplete) {
    return res.status(400).json({ error: '目前只支援 ?incomplete=1（只刪未完成的）' });
  }
  // 2C 前置條件（契約 §5.2／§5.3）：一律軟刪除，不得 hard delete。
  //
  // 硬刪除會讓歷史 ScheduleVersion 裡的 block 指向一個不存在的 task，
  // 變成 orphan——而 ScheduledBlock 是 immutable snapshot，事後補不回來。
  // 軟刪除同時保住「垃圾桶救得回來」與「歷史版本仍看得懂」兩件事。
  const r = await q.run(
    'UPDATE tasks SET deleted=1 WHERE user_id=? AND plan_id=? AND completed=0 AND COALESCE(cancelled,0)=0 AND COALESCE(deleted,0)=0',
    [req.userId, plan.id]);
  res.json({ removed: r.changes ?? 0 });
});

export default router;
