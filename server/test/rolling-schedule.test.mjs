// 段考滾動排程（Rolling Exam Schedule v1）後端 regression。
//
// 全部日期以 todayTW() 為基準的相對日期，永遠不會因牆上時間推進而失效
// （freeze 邊界本來就是 Asia/Taipei 的今天／明天）。直接呼叫 engine 函式
// （runRollingPreview / applySchedule），不走 HTTP，才驗得到 transaction 內的
// defence-in-depth。三時區各跑一次（npm test 的 TZ matrix）。
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'roll-')), 'roll.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const sched = await import('../src/schedule/persistence.js');
const { runRollingPreview } = await import('../src/routes/schedule.js');
const { freezeWindow, isFrozenDate, deadlineViolation, parseRollingPolicy } = await import('../src/schedule/rolling.js');
const { todayTW, addDays } = await import('../src/util/date.js');

const TODAY = todayTW();
const D = n => addDays(TODAY, n);           // 相對今天
const win = freezeWindow(TODAY, 2);          // freeze today+tomorrow, rolling_start = D(2)

let uid = 100;
const nextUser = () => ++uid;

async function mkUser(id) {
  await q.run('INSERT INTO users (id,email,password_hash,sleep_start,sleep_end,meal_windows) VALUES (?,?,?,?,?,?)',
    [id, `roll${id}@t`, 'x', '23:00', '07:00', '[]']);
}
async function mkPlan(userId, status = 'active') {
  const p = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, `計畫${userId}`, status]);
  return p.lastInsertRowid;
}
async function mkList(userId, name = '數學') {
  const l = await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [userId, name]);
  return l.lastInsertRowid;
}
async function mkTask(userId, planId, listId, o = {}) {
  const r = await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,estimated_minutes,deadline_date,deadline_time) VALUES (?,?,?,?,?,?,?)',
    [userId, listId, o.title || '任務', planId, o.est ?? 60, o.deadline_date ?? null, o.deadline_time ?? null]);
  return r.lastInsertRowid;
}
// 建一份 active version，帶指定 blocks（date/start/end/minutes/task_id）。
async function seedVersion(userId, blocks) {
  const v = await sched.createScheduleVersion(userId, { source: sched.SOURCE.INITIAL, effectiveFrom: D(0), blocks });
  return v.version_id;
}

before(async () => { await initSchema(); });

/* ================= pure helpers ================= */
describe('freeze window（Asia/Taipei 今天／明天）', () => {
  test('freeze_through = 明天、rolling_start = 後天', () => {
    assert.equal(win.freeze_start, TODAY);
    assert.equal(win.freeze_through, D(1));
    assert.equal(win.rolling_start, D(2));
  });
  test('isFrozenDate：今天／明天凍結，後天不凍結', () => {
    assert.equal(isFrozenDate(D(0), win), true);
    assert.equal(isFrozenDate(D(1), win), true);
    assert.equal(isFrozenDate(D(2), win), false);
  });
  test('parseRollingPolicy：structured、壞資料當未啟用', () => {
    assert.equal(parseRollingPolicy(JSON.stringify({ rolling_replan: { enabled: true, freeze_horizon_days: 3 } })).freeze_horizon_days, 3);
    assert.equal(parseRollingPolicy('{}').enabled, false);
    assert.equal(parseRollingPolicy('not json').enabled, false);
  });
  test('deadlineViolation：date 超過、同日超時、NULL=EOD', () => {
    assert.ok(deadlineViolation({ task_id: 1, date: D(5) }, { deadline_date: D(3) }));
    assert.ok(deadlineViolation({ task_id: 1, date: D(3), end_time: '20:00' }, { deadline_date: D(3), deadline_time: '18:00' }));
    assert.equal(deadlineViolation({ task_id: 1, date: D(3), end_time: '20:00' }, { deadline_date: D(3), deadline_time: null }), null);
    assert.equal(deadlineViolation({ task_id: 1, date: D(2) }, { deadline_date: D(3) }), null);
  });
});

/* ================= A. Freeze ================= */
describe('A. Freeze horizon', () => {
  test('今天／明天 exact unchanged；後天可重排；tail 不插進 freeze', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const tToday = await mkTask(u, planId, list, { title: '今天', est: 60 });
    const tTomorrow = await mkTask(u, planId, list, { title: '明天', est: 60 });
    const tLater = await mkTask(u, planId, list, { title: '後天', est: 60 });
    await seedVersion(u, [
      { task_id: tToday, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: tTomorrow, date: D(1), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: tLater, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
    ]);
    const r = await runRollingPreview(u, { plan_id: planId });
    assert.equal(r.status, 200);
    // frozen = 今天＋明天，exact placement
    const frozenTasks = r.body.frozen.map(b => Number(b.task_id)).sort();
    assert.deepEqual(frozenTasks, [tToday, tTomorrow].sort());
    // candidate 一定含今天／明天原封不動
    for (const fb of r.body.frozen) {
      assert.ok(r.body.blocks.some(b => Number(b.task_id) === Number(fb.task_id) && b.date === fb.date && b.start_time === fb.start_time),
        'frozen block 必須原位出現在 candidate');
    }
    // diff：frozen 今天／明天在 unchanged，不得 moved/removed
    const byTask = new Map(r.body.diff.items.map(it => [Number(it.task_id), it.type]));
    assert.notEqual(byTask.get(tToday), 'moved'); assert.notEqual(byTask.get(tToday), 'removed');
    assert.notEqual(byTask.get(tTomorrow), 'moved'); assert.notEqual(byTask.get(tTomorrow), 'removed');
    // tail 的所有非凍結 block 一律 >= rolling_start（後天），不插進 freeze
    for (const b of r.body.blocks) {
      if (frozenTasks.includes(Number(b.task_id))) continue;
      assert.ok(b.date >= win.rolling_start, `tail block 不得落在 freeze 窗內：${b.date}`);
    }
  });
});

/* ================= G. Stale + Freeze apply DiD ================= */
describe('G. stale preview + freeze apply defence-in-depth', () => {
  test('base_version 不符 → STALE_SCHEDULE_PREVIEW', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const t = await mkTask(u, planId, list, { est: 60 });
    const v = await seedVersion(u, [{ task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    await assert.rejects(
      () => sched.applySchedule(u, { planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
        blocks: [{ task_id: t, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
        expectedBaseVersionId: v - 999 }),
      e => e.code === 'STALE_SCHEDULE_PREVIEW' && e.status === 409);
  });
  test('凍結的 block 被移動 → FREEZE_VIOLATION（整筆拒絕）', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const tF = await mkTask(u, planId, list, { title: '凍結', est: 60 });
    const v = await seedVersion(u, [{ task_id: tF, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const frozen = [{ task_id: tF, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }];
    // candidate 把凍結 block 搬到後天 → 必須被 freeze DiD 擋下
    await assert.rejects(
      () => sched.applySchedule(u, { planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
        blocks: [{ task_id: tF, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
        expectedBaseVersionId: v, freezeBlocks: frozen }),
      e => e.code === 'FREEZE_VIOLATION' && e.status === 409);
  });
});

/* ================= C. Deadline apply DiD ================= */
describe('C. hard deadline apply defence-in-depth', () => {
  test('block 排到 deadline_date 之後 → DEADLINE_VIOLATION', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const t = await mkTask(u, planId, list, { est: 60, deadline_date: D(3) });
    const v = await seedVersion(u, [{ task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    await assert.rejects(
      () => sched.applySchedule(u, { planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
        blocks: [{ task_id: t, date: D(5), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
        expectedBaseVersionId: v, enforceDeadlines: true }),
      e => e.code === 'DEADLINE_VIOLATION' && e.status === 409);
  });
  test('deadline_time：同日超過結束時間 → 拒絕；未超過 → 允許', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const t = await mkTask(u, planId, list, { est: 60, deadline_date: D(3), deadline_time: '18:00' });
    const v = await seedVersion(u, [{ task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    await assert.rejects(
      () => sched.applySchedule(u, { planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
        blocks: [{ task_id: t, date: D(3), start_time: '18:30', end_time: '19:30', planned_minutes: 60 }],
        expectedBaseVersionId: v, enforceDeadlines: true }),
      e => e.code === 'DEADLINE_VIOLATION');
    const ok = await sched.applySchedule(u, { planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks: [{ task_id: t, date: D(3), start_time: '16:00', end_time: '17:00', planned_minutes: 60 }],
      expectedBaseVersionId: v, enforceDeadlines: true });
    assert.ok(ok.version_id);
  });
});

/* ================= F. Pending attachment ================= */
describe('F. pending attachment（plan_id=NULL 新作業）', () => {
  test('preview 零 DB mutation：trigger 的 plan_id 仍為 NULL', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const existing = await mkTask(u, planId, list, { est: 60 });
    await seedVersion(u, [{ task_id: existing, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    // 一般待辦 / 學校作業：plan_id = NULL
    const pend = (await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,estimated_minutes,deadline_date) VALUES (?,?,?,?,?,?)',
      [u, list, '新作業', null, 90, D(6)])).lastInsertRowid;
    const r = await runRollingPreview(u, { plan_id: planId, trigger_task_id: pend });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.attach_task_ids, [pend], 'preview 應標記要 attach 的 pending task');
    const after = await q.get('SELECT plan_id FROM tasks WHERE id=?', [pend]);
    assert.equal(after.plan_id, null, 'preview 不得寫入 plan_id');
  });
  test('apply 原子 attach + 建版；plan_id=NULL → planId', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const v = await seedVersion(u, [{ task_id: await mkTask(u, planId, list, { est: 60 }), date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const pend = (await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,estimated_minutes) VALUES (?,?,?,?,?)',
      [u, list, '待掛', null, 60])).lastInsertRowid;
    const res = await sched.applySchedule(u, { planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks: [{ task_id: pend, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
      expectedBaseVersionId: v, attachTaskIds: [pend] });
    assert.ok(res.version_id);
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [pend])).plan_id, planId);
  });
  test('apply 失敗 → attach 一起 rollback（plan_id 仍 NULL）', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const v = await seedVersion(u, [{ task_id: await mkTask(u, planId, list, { est: 60 }), date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const pend = (await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,estimated_minutes,deadline_date) VALUES (?,?,?,?,?,?)',
      [u, list, '待掛但超期', null, 60, D(3)])).lastInsertRowid;
    // deadline DiD 會炸（排到 deadline 後）→ 整筆 rollback，attach 不得留下
    await assert.rejects(() => sched.applySchedule(u, { planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks: [{ task_id: pend, date: D(9), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
      expectedBaseVersionId: v, attachTaskIds: [pend], enforceDeadlines: true }));
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [pend])).plan_id, null, 'rollback：plan_id 不得留下');
  });
});

/* ================= I. Lifecycle ================= */
describe('I. lifecycle：非 draft/active 一律拒絕', () => {
  for (const status of ['paused', 'ended', 'completed', 'deleted']) {
    test(`${status} 計畫不得 rolling preview`, async () => {
      const u = nextUser(); await mkUser(u);
      const planId = await mkPlan(u, status);
      const r = await runRollingPreview(u, { plan_id: planId });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'PLAN_NOT_ROLLING_ELIGIBLE');
    });
  }
});

/* ================= D. INFEASIBLE_WITH_FREEZE ================= */
describe('D. INFEASIBLE_WITH_FREEZE', () => {
  test('trigger 因 deadline 太近、freeze 下排不進 → 結構化 payload、不排到 deadline 後', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    await seedVersion(u, [{ task_id: await mkTask(u, planId, list, { est: 60 }), date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    // pending：deadline 就在明天（freeze 窗內），rolling_start 是後天 → 無合法未來位置
    const pend = (await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,estimated_minutes,deadline_date) VALUES (?,?,?,?,?,?)',
      [u, list, '急件', null, 120, D(1)])).lastInsertRowid;
    const r = await runRollingPreview(u, { plan_id: planId, trigger_task_id: pend });
    assert.equal(r.status, 200);
    assert.ok(r.body.infeasible, '應回報 INFEASIBLE_WITH_FREEZE');
    assert.equal(r.body.infeasible.code, 'INFEASIBLE_WITH_FREEZE');
    assert.equal(r.body.infeasible.trigger_task_id, pend);
    assert.equal(r.body.infeasible.deadline_date, D(1));
    assert.equal(r.body.infeasible.freeze_through, win.freeze_through);
    assert.deepEqual(r.body.infeasible.options, ['KEEP_CURRENT', 'RELAX_FREEZE', 'SELECT_MOVABLE_BLOCKS']);
    // 不得把 trigger 排到 deadline 之後（silent post-deadline placement）
    for (const b of r.body.blocks) {
      if (Number(b.task_id) === pend) assert.ok(b.date <= D(1), '不得排到 deadline 之後');
    }
  });
});

/* ================= E. Override ================= */
describe('E. override', () => {
  test('RELAX_FREEZE：放寬 freeze 後 today block 變成可移動（不在 frozen 內）', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const tToday = await mkTask(u, planId, list, { title: '今天', est: 60 });
    await seedVersion(u, [{ task_id: tToday, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const strict = await runRollingPreview(u, { plan_id: planId });
    assert.equal(strict.body.frozen.length, 1);
    const relaxed = await runRollingPreview(u, { plan_id: planId, freeze: { override: { mode: 'relax_freeze' } } });
    assert.equal(relaxed.body.frozen.length, 0, 'RELAX_FREEZE 後不再有凍結 pin');
  });
  test('SELECT_MOVABLE_BLOCKS：只有被選的 frozen 變可移動，其餘仍凍結', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const tA = await mkTask(u, planId, list, { title: 'A', est: 60 });
    const tB = await mkTask(u, planId, list, { title: 'B', est: 60 });
    const blocks = [
      { task_id: tA, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: tB, date: D(0), start_time: '20:10', end_time: '21:10', planned_minutes: 60 },
    ];
    await seedVersion(u, blocks);
    const strict = await runRollingPreview(u, { plan_id: planId });
    const movableId = strict.body.frozen.find(b => Number(b.task_id) === tA).id;
    const r = await runRollingPreview(u, { plan_id: planId, freeze: { override: { mode: 'select_movable', movable_block_ids: [movableId] } } });
    const frozenTasks = r.body.frozen.map(b => Number(b.task_id));
    assert.ok(!frozenTasks.includes(tA), '被選的 A 不再凍結');
    assert.ok(frozenTasks.includes(tB), '未被選的 B 仍凍結');
  });
});

/* ================= J. Material / StudySession no mutation ================= */
describe('J. rolling 不動 Material / StudySession', () => {
  test('rolling apply 不改 material_progress、不改 study_sessions', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u); const list = await mkList(u);
    const t = await mkTask(u, planId, list, { est: 60 });
    const v = await seedVersion(u, [{ task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const mpBefore = (await q.get('SELECT COUNT(*) c FROM material_progress WHERE user_id=?', [u])).c;
    const ssBefore = (await q.get('SELECT COUNT(*) c FROM study_sessions WHERE user_id=?', [u])).c;
    await sched.applySchedule(u, { planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks: [{ task_id: t, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
      expectedBaseVersionId: v, enforceDeadlines: true });
    assert.equal((await q.get('SELECT COUNT(*) c FROM material_progress WHERE user_id=?', [u])).c, mpBefore);
    assert.equal((await q.get('SELECT COUNT(*) c FROM study_sessions WHERE user_id=?', [u])).c, ssBefore);
  });
});
