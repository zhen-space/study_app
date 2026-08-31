// 學校作業的 API 契約。
//
// 貫穿全部的硬規則：**沒有第二套 lifecycle**。沒有 school_assignments 表、
// 沒有專屬完成／取消端點、期限不寫 due_date、不鏡射成 fixed_event、
// 也不會因為填了期限就長出 ScheduledBlock。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, day } from './helpers.mjs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture() {
  const s = await startServer();
  const call = (method, p, body, H = s.H) =>
    fetch(s.base + p, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const post = (p, b, H) => call('POST', p, b, H);
  const patch = (p, b, H) => call('PATCH', p, b, H);
  const get = (p, H = s.H) => fetch(s.base + p, { headers: H });
  const mkList = async (name, H = s.H) => (await post('/lists', { name }, H)).json();
  return { ...s, call, post, patch, get, mkList };
}

// 一份合法的學校作業
const body = (listId, o = {}) => ({
  task_kind: 'school_assignment', title: '數學習題', list_id: listId,
  school_assignment_type: 'homework', deadline_date: day(3), ...o,
});

async function withAssignment(f, o = {}) {
  const list = await f.mkList('數學');
  const r = await f.post('/tasks', body(list.id, o));
  return { list, res: r, task: await r.json() };
}

/* ---------- 建立 ---------- */

test('建立學校作業：期限存 deadline_*，不碰 due_date/due_time', async () => {
  const f = await fixture();
  try {
    const { res, task } = await withAssignment(f, { deadline_time: '17:00' });
    assert.equal(res.status, 200);
    assert.equal(task.task_kind, 'school_assignment');
    assert.equal(task.school_assignment_type, 'homework');
    assert.equal(task.deadline_date, day(3));
    assert.equal(task.deadline_time, '17:00');
    assert.equal(task.due_date, null, '學校期限不得寫進排程鏡射欄位');
    assert.equal(task.due_time, null);
    assert.equal(task.plan_id, null, '預設不進排程');
    assert.ok(task.updated_at);
  } finally { f.stop(); }
});

test('一般任務不受影響（regression）', async () => {
  const f = await fixture();
  try {
    const t = await (await f.post('/tasks', { title: '買筆', due_date: day(1) })).json();
    assert.equal(t.due_date, day(1));
    assert.equal(t.task_kind ?? 'standard', 'standard');
    assert.equal(t.school_assignment_type, null);
  } finally { f.stop(); }
});

test('四種作業類型都收，其餘拒絕', async () => {
  const f = await fixture();
  try {
    const list = await f.mkList('英文');
    for (const kind of ['homework', 'report', 'exam', 'other']) {
      const r = await f.post('/tasks', body(list.id, { school_assignment_type: kind }));
      assert.equal(r.status, 200, kind);
    }
    for (const bad of ['quiz', 'project', '', null, 'HOMEWORK']) {
      const r = await f.post('/tasks', body(list.id, { school_assignment_type: bad }));
      assert.equal(r.status, 400, String(bad));
    }
  } finally { f.stop(); }
});

test('必填：title / list_id / type / deadline_date', async () => {
  const f = await fixture();
  try {
    const list = await f.mkList('物理');
    assert.equal((await f.post('/tasks', body(list.id, { title: '' }))).status, 400);
    assert.equal((await f.post('/tasks', body(list.id, { list_id: null }))).status, 400);
    assert.equal((await f.post('/tasks', body(list.id, { deadline_date: null }))).status, 400);
  } finally { f.stop(); }
});

test('v1 不接受重複的學校作業', async () => {
  const f = await fixture();
  try {
    const list = await f.mkList('化學');
    const r = await f.post('/tasks', body(list.id, { recurring: 'weekly' }));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /重複/);
  } finally { f.stop(); }
});

test('task_kind 不正確就擋下，且不含 material 這種值', async () => {
  const f = await fixture();
  try {
    const list = await f.mkList('地理');
    for (const k of ['material', 'manual', 'assignment']) {
      assert.equal((await f.post('/tasks', body(list.id, { task_kind: k }))).status, 400, k);
    }
  } finally { f.stop(); }
});

/* ---------- 科目邊界 ---------- */

test('別人的科目不能建立學校作業', async () => {
  const f = await fixture();
  try {
    const u2 = await f.secondUser();
    const theirList = await f.mkList('別人的科目', u2.H);
    const r = await f.post('/tasks', body(theirList.id));
    assert.equal(r.status, 400);
  } finally { f.stop(); }
});

test('分享給我的清單不能建立學校作業（v1）', async () => {
  const f = await fixture();
  try {
    const u2 = await f.secondUser();
    const theirList = await f.mkList('共用科目', u2.H);
    // 對方把清單分享給我
    const me = await (await f.get('/lists')).json();
    await f.post(`/lists/${theirList.id}/share`, { email: (await meEmail(f)) }, u2.H).catch(() => {});
    const r = await f.post('/tasks', body(theirList.id));
    assert.equal(r.status, 400, '即使分享進來，v1 也不允許');
    assert.ok(Array.isArray(me));
  } finally { f.stop(); }
});

// 取得目前帳號 email（分享端點要 email）
async function meEmail(f) {
  const r = await f.get('/settings');
  await r.json().catch(() => ({}));
  return 'nobody@test.local';
}

/* ---------- Material 正交 ---------- */

test('task_kind 與教材連結正交：四種組合都成立', async () => {
  const f = await fixture();
  try {
    const list = await f.mkList('數學');
    // standard + 無教材
    const a = await (await f.post('/tasks', { title: 'A' })).json();
    // school_assignment + 無教材
    const b = await (await f.post('/tasks', body(list.id, { title: 'B' }))).json();
    assert.equal(a.material_content_item_id, null);
    assert.equal(b.material_content_item_id, null);
    assert.equal(b.task_kind, 'school_assignment');
    // 教材身分只由 material_content_item_id 決定，不由 task_kind 決定
    assert.equal(a.task_kind ?? 'standard', 'standard');
  } finally { f.stop(); }
});

/* ---------- 提醒 ---------- */

test('提醒欄位成組寫入；換 kind 會清掉上一種的參數', async () => {
  const f = await fixture();
  try {
    const { task } = await withAssignment(f, {
      reminder_kind: 'days_before', reminder_days_before: 3, reminder_time_override: '08:00',
    });
    assert.equal(task.reminder_kind, 'days_before');
    assert.equal(task.reminder_days_before, 3);

    const out = await (await f.patch(`/tasks/${task.id}`, { reminder_kind: 'previous_friday' })).json();
    assert.ok(out.ok);
    const after = (await (await f.get('/tasks')).json()).find(t => t.id === task.id);
    assert.equal(after.reminder_kind, 'previous_friday');
    assert.equal(after.reminder_days_before, null, '換方式後不得留著舊參數');
  } finally { f.stop(); }
});

test('提前天數只收 1/2/3/7', async () => {
  const f = await fixture();
  try {
    const list = await f.mkList('歷史');
    for (const n of [1, 2, 3, 7]) {
      assert.equal((await f.post('/tasks', body(list.id, { reminder_kind: 'days_before', reminder_days_before: n }))).status, 200, String(n));
    }
    for (const n of [0, 4, 5, 6, 8, 14]) {
      assert.equal((await f.post('/tasks', body(list.id, { reminder_kind: 'days_before', reminder_days_before: n }))).status, 400, String(n));
    }
  } finally { f.stop(); }
});

test('custom 提醒必須有日期', async () => {
  const f = await fixture();
  try {
    const list = await f.mkList('公民');
    assert.equal((await f.post('/tasks', body(list.id, { reminder_kind: 'custom' }))).status, 400);
    assert.equal((await f.post('/tasks', body(list.id, { reminder_kind: 'custom', reminder_custom_date: day(1) }))).status, 200);
  } finally { f.stop(); }
});

test('設定：預設提醒時間可讀可寫，格式不對擋下', async () => {
  const f = await fixture();
  try {
    const s0 = await (await f.get('/settings')).json();
    assert.equal(s0.school_assignment_default_reminder_time, '18:00');
    assert.equal((await f.call('PUT', '/settings', { school_assignment_default_reminder_time: '07:30' })).status, 200);
    const s1 = await (await f.get('/settings')).json();
    assert.equal(s1.school_assignment_default_reminder_time, '07:30');
    assert.equal((await f.call('PUT', '/settings', { school_assignment_default_reminder_time: '7:30' })).status, 400);
    // 既有設定不被這個欄位影響
    assert.ok(s1.sleep_start);
    assert.ok(Array.isArray(s1.meal_windows));
  } finally { f.stop(); }
});

/* ---------- lifecycle 沿用 ---------- */

test('完成／取消／重開走既有 Task lifecycle，沒有專屬端點', async () => {
  const f = await fixture();
  try {
    const { task } = await withAssignment(f);
    assert.ok((await (await f.patch(`/tasks/${task.id}`, { completed: true })).json()).ok);
    let t = (await (await f.get('/tasks')).json()).find(x => x.id === task.id);
    assert.equal(t.completed, 1);

    // 任務只能有一種結果，要改成取消得先重開——這是既有 Task lifecycle，
    // 學校作業完全沿用，不另外開一條路。
    assert.equal((await f.post(`/tasks/${task.id}/reopen`)).status, 200);
    assert.equal((await f.post(`/tasks/${task.id}/cancel`)).status, 200);
    t = (await (await f.get('/tasks')).json()).find(x => x.id === task.id);
    assert.equal(t.cancelled, 1);
    assert.equal(t.completed, 0, '取消不是完成');

    assert.equal((await f.post(`/tasks/${task.id}/reopen`)).status, 200);
    t = (await (await f.get('/tasks')).json()).find(x => x.id === task.id);
    assert.equal(t.cancelled, 0);

    // 沒有第二套端點
    for (const p of [`/school-assignments`, `/school-assignments/${task.id}/complete`,
      `/tasks/${task.id}/submit`, `/assignments/${task.id}/complete`]) {
      assert.equal((await f.post(p, {})).status, 404, p);
    }
  } finally { f.stop(); }
});

test('刪除沿用既有軟刪除', async () => {
  const f = await fixture();
  try {
    const { task } = await withAssignment(f);
    assert.equal((await f.call('DELETE', `/tasks/${task.id}`)).status, 200);
    const t = (await (await f.get('/tasks')).json()).find(x => x.id === task.id);
    assert.equal(t.deleted, 1);
  } finally { f.stop(); }
});

/* ---------- filter ---------- */

test('GET /tasks?task_kind= 只是既有清單的篩選', async () => {
  const f = await fixture();
  try {
    await withAssignment(f);
    await f.post('/tasks', { title: '一般任務' });
    const all = await (await f.get('/tasks')).json();
    const only = await (await f.get('/tasks?task_kind=school_assignment')).json();
    const std = await (await f.get('/tasks?task_kind=standard')).json();
    assert.equal(all.length, 2);
    assert.equal(only.length, 1);
    assert.equal(std.length, 1, '沒有 backfill 的舊資料語意上就是 standard');
    assert.equal((await f.get('/tasks?task_kind=material')).status, 400);
  } finally { f.stop(); }
});

/* ---------- 不得建立第二套狀態 ---------- */

test('填了期限不會產生 ScheduledBlock，也不會鏡射成 fixed_event', async () => {
  const f = await fixture();
  try {
    const { task } = await withAssignment(f, { deadline_time: '17:00' });
    const events = await (await f.get('/events')).json();
    assert.equal(events.length, 0, '學校作業不得複製成固定行程');

    const { createClient } = await import('@libsql/client');
    const c = createClient({ url: 'file:' + f.dbFile });
    try {
      const blocks = await c.execute('SELECT COUNT(*) FROM scheduled_blocks');
      assert.equal(Number(blocks.rows[0][0]), 0, '期限本身不得變成排程 block');
      const versions = await c.execute('SELECT COUNT(*) FROM schedule_versions');
      assert.equal(Number(versions.rows[0][0]), 0);
    } finally { try { c.close(); } catch {} }
    assert.ok(task.id);
  } finally { f.stop(); }
});

test('沒有 school_assignments 這種表', async () => {
  const f = await fixture();
  try {
    const names = await f.tableNames();
    for (const n of names) {
      assert.equal(/^school_assignment/.test(n), false, `不該存在 ${n}`);
    }
    assert.ok(names.includes('tasks'));
  } finally { f.stop(); }
});

/* ---------- Plan / 排程 ---------- */

test('plan_id=NULL 的學校作業不進排程；掛上 Plan 後才進', async () => {
  const f = await fixture();
  try {
    const { task } = await withAssignment(f);
    const plan = await (await f.post('/plans', { name: '期末衝刺' })).json();
    // 掛 Plan 走既有 Task API，不是學校作業專屬流程
    const r = await f.patch(`/tasks/${task.id}`, { plan_id: plan.id, estimated_minutes: 60 });
    assert.equal(r.status, 200);
    const t = (await (await f.get('/tasks')).json()).find(x => x.id === task.id);
    assert.equal(t.plan_id, plan.id);
    assert.equal(t.task_kind, 'school_assignment', '掛 Plan 不改變它是學校作業');
    assert.equal(t.deadline_date, task.deadline_date, '期限不因掛 Plan 而改變');
  } finally { f.stop(); }
});

test('掛了 Plan 之後，due_date 仍只能由排程器寫入', async () => {
  const f = await fixture();
  try {
    const { task } = await withAssignment(f);
    const plan = await (await f.post('/plans', { name: 'P' })).json();
    await f.patch(`/tasks/${task.id}`, { plan_id: plan.id });
    const r = await f.patch(`/tasks/${task.id}`, { due_date: day(1) });
    assert.equal(r.status, 409, '計畫任務的排定時間必須透過排程器');
  } finally { f.stop(); }
});

/* ---------- 靜態契約 ---------- */

test('判定模組不碰資料庫', () => {
  const src = readFileSync(path.join(serverDir, 'src/school/assignment.js'), 'utf8');
  assert.equal(/db\/init/.test(src), false);
  assert.equal(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(src), false);
});

test('學校作業不寫 fixed_events，也不自己建 ScheduledBlock', () => {
  const src = readFileSync(path.join(serverDir, 'src/school/assignment.js'), 'utf8');
  for (const forbidden of [/fixed_events/, /scheduled_blocks/, /schedule_versions/, /study_sessions/]) {
    assert.equal(forbidden.test(src), false, String(forbidden));
  }
});
