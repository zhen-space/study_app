import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let S;
before(async () => { S = await startServer(); });
after(() => S?.stop());
async function api(path, opts = {}) {
  const r = await fetch(S.base + path, { ...opts, headers: S.H, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, body: await r.json() };
}

test('Master B：routine 與 exception 是使用者可管理、可重用的結構化資料', async () => {
  const r = await api('/routines', { method: 'POST', body: { type: 'availability', title: '晚自習', weekdays: [1,2,3,4,5], start_time: '19:00', end_time: '21:00' } });
  assert.equal(r.status, 201);
  const e = await api('/routine-exceptions', { method: 'POST', body: { routine_id: r.body.id, date: '2099-01-01', kind: 'cancel' } });
  assert.equal(e.status, 201);
  assert.equal((await api('/routines')).body.some(x => x.id === r.body.id), true);
});

test('Master H：Goal 是 Plan 的 optional 上層，不取代 Plan', async () => {
  const goal = await api('/goals', { method: 'POST', body: { name: '段考目標', target_date: '2099-01-01' } });
  const plan = await api('/plans', { method: 'POST', body: { name: '數學複習', goal_id: goal.body.id } });
  const detail = await api(`/goals/${goal.body.id}`);
  assert.equal(plan.status, 200);
  assert.equal(detail.body.plans.some(x => x.id === plan.body.id), true);
});

test('Master F：StudySession 綁 Task，不改動 ScheduledBlock', async () => {
  const plan = await api('/plans', { method: 'POST', body: { name: '讀書紀錄' } });
  const task = await api('/tasks', { method: 'POST', body: { title: '讀一章', plan_id: plan.body.id } });
  const session = await api('/study-sessions', { method: 'POST', body: { task_id: task.body.id } });
  assert.equal(session.status, 201);
  const paused = await api(`/study-sessions/${session.body.id}`, { method: 'PATCH', body: { status: 'paused' } });
  assert.equal(paused.body.status, 'paused');
  const resumed = await api(`/study-sessions/${session.body.id}`, { method: 'PATCH', body: { status: 'running' } });
  assert.equal(resumed.body.status, 'running');
  const done = await api(`/study-sessions/${session.body.id}`, { method: 'PATCH', body: { status: 'completed', actual_minutes: 25 } });
  assert.equal(done.body.actual_minutes, 25);
  assert.equal(done.body.status, 'completed');
  const stats = await api('/tstats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.byPlan['讀書紀錄'], 25);
  assert.equal(stats.body.actualTotal >= 25, true);
  assert.equal(typeof stats.body.movedLast30, 'number');
  assert.equal(typeof stats.body.plannedByPlan, 'object');
});

test('Master C：只有確認後的 supported constraint 會保存，unsupported 不可 silently ignore', async () => {
  const plan = await api('/plans', { method: 'POST', body: { name: '條件計畫' } });
  const saved = await api(`/plans/${plan.body.id}/constraints`, { method: 'PUT', body: { intent: { exclude_weekdays: [3], strict_dependency: [{ before: 'A', after: 'B' }] } } });
  assert.deepEqual(saved.body.supported, { exclude_weekdays: [3] });
  assert.equal(saved.body.unsupported[0].key, 'strict_dependency');
});

test('Master C：確認過的 date_window 是 scheduler 的 hard window，不會覆寫 task deadline', async () => {
  const plan = await api('/plans', { method: 'POST', body: { name: '日期窗計畫' } });
  const saved = await api(`/plans/${plan.body.id}/constraints`, { method: 'PUT', body: { intent: { date_window: { start_date: '2099-01-12', end_date: '2099-01-14' } } } });
  assert.deepEqual(saved.body.supported.date_window, { start_date: '2099-01-12', end_date: '2099-01-14' });
  const preview = await api('/schedule/preview', { method: 'POST', body: {
    plan_id: plan.body.id, timed: false, perDay: 3, startDate: '2099-01-01', endDate: '2099-01-20',
    items: [{ subject_id: 1, title: '日期窗任務', spread: false, start: '2099-01-01', end: '2099-01-13' }],
  } });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.blocks.length, JSON.stringify(preview.body));
  assert.equal(preview.body.blocks[0].date >= '2099-01-12' && preview.body.blocks[0].date <= '2099-01-13', true);
});

test('Master A：Plan Task 的明確工作量會進入正式 health gap，舊資料不猜分鐘', async () => {
  const plan = await api('/plans', { method: 'POST', body: { name: '工作量計畫' } });
  const task = await api('/tasks', { method: 'POST', body: { title: '需要兩小時', plan_id: plan.body.id, estimated_minutes: 120 } });
  assert.equal(task.status, 200);
  const health = await api(`/plans/${plan.body.id}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.body.estimated_workload_minutes, 120);
  assert.equal(health.body.capacity_gap_minutes, 120);
  assert.equal(health.body.reasons.some(r => r.type === 'capacity_gap'), true);
});
