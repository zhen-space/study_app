import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { classifyScheduleHealth } from '../schedule/health.js';
import { todayTW } from '../util/date.js';

// Plan＝有目標、範圍、期限與生命週期的工作單位。
// 契約見 docs/phase2-plan-domain.md，動之前先讀。重點：
//   - Plan ≠ 科目。一個科目可以有多個 Plan，一個 Plan 也可以跨科目
//   - primary_list_id 只是主要分類／顯示用，不是 Plan 的身分
//   - 進度不存在 plans 表，一律從底下的 tasks 算，免得兩邊不同步
//   - 封存不等於刪除。Phase 2A 不提供刪除 Plan

const router = Router();
router.use(requireAuth);

const STATUS = ['draft', 'active', 'completed', 'archived'];
const SOURCE = ['manual', 'ai', 'legacy_migration', 'import'];
const now = () => new Date().toISOString();

const mine = (id, userId) => q.get('SELECT * FROM plans WHERE id=? AND user_id=?', [id, userId]);

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
            SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) completed_task_count
     FROM tasks WHERE user_id=? AND plan_id IS NOT NULL AND COALESCE(deleted,0)=0
     GROUP BY plan_id`, [userId]);
  const m = new Map(stats.map(s => [s.plan_id, s]));
  return rows.map(p => ({
    ...p,
    task_count: m.get(p.id)?.task_count ?? 0,
    completed_task_count: m.get(p.id)?.completed_task_count ?? 0,
  }));
}

// GET /api/plans?status=active&includeArchived=1
router.get('/plans', async (req, res) => {
  const args = [req.userId];
  let sql = 'SELECT * FROM plans WHERE user_id=?';
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
      remaining_tasks: tasks.filter(t => !t.completed).length,
      overdue_tasks: tasks.filter(t => !t.completed && t.due_date && t.due_date < today).length,
    },
  });
});

// A2：Today／Replan 的正式 health model。只讀 active ScheduleVersion，不改任何安排。
router.get('/plans/:id/health', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  const today = todayTW();
  const [tasks, state, locks] = await Promise.all([
    q.all('SELECT id,due_date,completed,deleted FROM tasks WHERE user_id=? AND plan_id=?', [req.userId, plan.id]),
    q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [req.userId]),
    q.get('SELECT COUNT(*) c FROM schedule_locks WHERE user_id=? AND released_at IS NULL', [req.userId]),
  ]);
  const pending = tasks.filter(t => !t.completed && !t.deleted);
  const blockIds = state?.active_version_id == null ? new Set() : new Set((await q.all(
    'SELECT b.task_id FROM scheduled_blocks b WHERE b.user_id=? AND b.schedule_version_id=?', [req.userId, state.active_version_id]))
    .map(b => Number(b.task_id)));
  const overdue = pending.filter(t => t.due_date && t.due_date < today).length;
  const unplaced = state?.active_version_id == null ? pending.filter(t => !t.due_date).length : pending.filter(t => !blockIds.has(Number(t.id))).length;
  const lateTarget = plan.target_date ? pending.filter(t => t.due_date && t.due_date > plan.target_date).length : 0;
  res.json({ plan_id: plan.id, ...classifyScheduleHealth({ pending: pending.length, overdue, unplaced, lateTarget, locked: locks?.c || 0 }) });
});

// POST /api/plans
router.post('/plans', async (req, res) => {
  const b = req.body || {};
  const err = await validate(b, req.userId);
  if (err) return res.status(400).json({ error: err });
  const status = b.status || 'draft';
  const r = await q.run(
    `INSERT INTO plans (user_id,name,description,goal_id,primary_list_id,start_date,target_date,status,source,created_at,updated_at,completed_at,archived_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.userId, String(b.name).trim(), b.description || '', b.goal_id ?? null, b.primary_list_id ?? null,
      b.start_date || null, b.target_date || null, status, b.source || 'manual',
      now(), now(), status === 'completed' ? now() : null, status === 'archived' ? now() : null]);
  res.json(await q.get('SELECT * FROM plans WHERE id=?', [r.lastInsertRowid]));
});

// PATCH /api/plans/:id
// user_id / created_at / updated_at / completed_at / archived_at / source 由伺服器決定，
// 客戶端送了也不算數。
const PATCHABLE = ['name', 'description', 'goal_id', 'primary_list_id', 'start_date', 'target_date', 'status'];
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
  // 狀態轉換時同步時間戳：進入該狀態就記時間，離開就清掉
  if ('status' in patch) {
    sets.push('completed_at=?'); args.push(patch.status === 'completed' ? (plan.completed_at || now()) : null);
    sets.push('archived_at=?'); args.push(patch.status === 'archived' ? (plan.archived_at || now()) : null);
  }
  sets.push('updated_at=?'); args.push(now());
  args.push(plan.id);
  await q.run(`UPDATE plans SET ${sets.join(',')} WHERE id=?`, args);
  res.json(await q.get('SELECT * FROM plans WHERE id=?', [plan.id]));
});

// 只改狀態的小工具（下面三個語意化端點共用）
async function setStatus(plan, status) {
  await q.run('UPDATE plans SET status=?, completed_at=?, archived_at=?, updated_at=? WHERE id=?', [
    status,
    status === 'completed' ? (plan.completed_at || now()) : null,
    status === 'archived' ? (plan.archived_at || now()) : null,
    now(), plan.id,
  ]);
  return q.get('SELECT * FROM plans WHERE id=?', [plan.id]);
}

// POST /api/plans/:id/complete
// 計畫完成不等於底下每一項都打勾——可能有被取消或跳過的。
// 所以把還沒解決的項目回給前端，讓使用者自己確認；帶 force=1 才真的完成。
router.post('/plans/:id/complete', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  const unresolved = await q.all(
    'SELECT id, title, due_date FROM tasks WHERE user_id=? AND plan_id=? AND completed=0 AND COALESCE(deleted,0)=0 ORDER BY due_date, id',
    [req.userId, plan.id]);
  if (unresolved.length && !req.body?.force) {
    return res.json({ plan, unresolved, needs_confirm: true });
  }
  res.json({ plan: await setStatus(plan, 'completed'), unresolved: [], needs_confirm: false });
});

// POST /api/plans/:id/archive —— 封存不刪任何 Task
router.post('/plans/:id/archive', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  res.json(await setStatus(plan, 'archived'));
});

// POST /api/plans/:id/restore —— 封存的計畫拉回進行中
router.post('/plans/:id/restore', async (req, res) => {
  const plan = await mine(req.params.id, req.userId);
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  if (plan.status !== 'archived') return res.status(400).json({ error: '只有封存的計畫可以恢復' });
  res.json(await setStatus(plan, 'active'));
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
    'UPDATE tasks SET deleted=1 WHERE user_id=? AND plan_id=? AND completed=0 AND COALESCE(deleted,0)=0',
    [req.userId, plan.id]);
  res.json({ removed: r.changes ?? 0 });
});

export default router;
