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
async function mkPlan(userId, status = 'active', target_date = null) {
  const p = await q.run('INSERT INTO plans (user_id,name,status,target_date) VALUES (?,?,?,?)', [userId, `計畫${userId}`, status, target_date]);
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
    const planId = await mkPlan(u, 'active', D(30)); const list = await mkList(u);   // 段考日期已知 → Plan target_date
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
    const planId = await mkPlan(u, 'active', D(30)); const list = await mkList(u);
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
    const planId = await mkPlan(u, 'active', D(30)); const list = await mkList(u);
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
    const planId = await mkPlan(u, 'active', D(30)); const list = await mkList(u);
    const tToday = await mkTask(u, planId, list, { title: '今天', est: 60 });
    await seedVersion(u, [{ task_id: tToday, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const strict = await runRollingPreview(u, { plan_id: planId });
    assert.equal(strict.body.frozen.length, 1);
    const relaxed = await runRollingPreview(u, { plan_id: planId, freeze: { override: { mode: 'relax_freeze' } } });
    assert.equal(relaxed.body.frozen.length, 0, 'RELAX_FREEZE 後不再有凍結 pin');
  });
  test('SELECT_MOVABLE_BLOCKS：只有被選的 frozen 變可移動，其餘仍凍結', async () => {
    const u = nextUser(); await mkUser(u);
    const planId = await mkPlan(u, 'active', D(30)); const list = await mkList(u);
    const tA = await mkTask(u, planId, list, { title: 'A', est: 60 });
    const tB = await mkTask(u, planId, list, { title: 'B', est: 60 });   // 段考日期已知
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

/* ================= K. Phase 1 backend correctness ================= */
describe('K. Phase 1 backend correctness', () => {
  test('K1 跨 Plan carry-forward：其他 Plan 的 block 進 candidate_blocks 且 diff=unchanged，不被誤判 removed', async () => {
    const u = nextUser(); await mkUser(u);
    const planA = await mkPlan(u, 'active', D(30)); const planB = await mkPlan(u);   // 當前 Plan 有段考日期
    const listA = await mkList(u, '數學'); const listB = await mkList(u, '物理');
    const tA = await mkTask(u, planA, listA, { est: 60 });
    const tB = await mkTask(u, planB, listB, { est: 60 });
    await seedVersion(u, [
      { task_id: tA, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: tB, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
    ]);
    const r = await runRollingPreview(u, { plan_id: planA });
    assert.equal(r.status, 200);
    assert.ok(r.body.candidate_blocks.some(b => Number(b.task_id) === tB && b.date === D(3)), 'candidate_blocks 應含其他 Plan 的 block');
    assert.ok(!r.body.blocks.some(b => Number(b.task_id) === tB), 'blocks 只含 current Plan');
    const bItem = r.body.diff.items.find(it => Number(it.task_id) === tB);
    assert.ok(bItem, '其他 Plan 應出現在 diff');
    assert.equal(bItem.type, 'unchanged', '其他 Plan 的 block 必須 unchanged，不得 removed');
  });

  test('K2 frozen 以 CURRENT deadline 重驗：凍結 block 超過現行 deadline_time → deadline_violation + infeasible', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const t = await mkTask(u, plan, list, { est: 60, deadline_date: D(0), deadline_time: '18:00' });
    await seedVersion(u, [{ task_id: t, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.ok(r.body.infeasible, '凍結 block 違反現行 deadline 應 infeasible');
    assert.ok(r.body.infeasible.deadline_violations.some(v => Number(v.task_id) === t),
      'frozen block 必須以 CURRENT deadline 重驗、列入 deadline_violations');
  });

  test('K3 缺 estimate fail closed：回 MISSING_ESTIMATE 與 task ids，不產生 candidate', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const tHas = await mkTask(u, plan, list, { est: 60 });
    const tNull = (await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,estimated_minutes) VALUES (?,?,?,?,?)',
      [u, list, '缺估', plan, null])).lastInsertRowid;
    await seedVersion(u, [{ task_id: tHas, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.equal(r.body.code, 'MISSING_ESTIMATE');
    assert.ok(r.body.missing_estimate_task_ids.includes(Number(tNull)), '應列出缺估的 task id');
    assert.equal(r.body.blocks, null, '缺估時不得產生可確認 candidate');
    assert.equal(r.body.candidate_blocks, null);
  });

  test('K3b 缺 estimate 但今天已有 frozen block：仍須 fail closed，不得用 frozen 時數暗自推定已排完', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    // tNull 缺 estimate，但今天（freeze 窗內）已有一個 block。舊漏洞會因 frozenMin>0 跳過。
    const tNull = (await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,estimated_minutes) VALUES (?,?,?,?,?)',
      [u, list, '缺估但今天已排', plan, null])).lastInsertRowid;
    await seedVersion(u, [{ task_id: tNull, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.equal(r.body.code, 'MISSING_ESTIMATE', '缺估即使有 frozen block 仍須 MISSING_ESTIMATE');
    assert.ok(r.body.missing_estimate_task_ids.includes(Number(tNull)), '缺估 task 必須被列出，不得被 frozen 掩蓋');
    assert.equal(r.body.blocks, null, '缺估時不得產生可確認 candidate');
  });

  test('K4 TASK_INFEASIBLE：某 task deadline 太近、freeze 下排不進 → task_infeasible 列出該 task', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const t = await mkTask(u, plan, list, { est: 60, deadline_date: D(1) });
    const t2 = await mkTask(u, plan, list, { est: 60, deadline_date: D(10) });
    await seedVersion(u, [{ task_id: t2, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.ok(r.body.infeasible, '應 infeasible');
    assert.ok(r.body.infeasible.task_infeasible.some(x => Number(x.task_id) === t),
      'task_infeasible 應含 deadline 排不進的該 task');
  });

  // 使用者作息 23:00–07:00 → 每天可排 07:00–23:00 = 960 分。以合法估時（1–1440）
  // 與短期限製造真正的 capacity gap，證明 production 可達輸入即可觸發 PLAN_CAPACITY_GAP。
  const DAY_CAPACITY = 960;

  test('K5 PLAN_CAPACITY_GAP（合法估時）：Task deadline 綁定視窗內需求 > 容量 → gap 含 requested/available/gap', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    // 4 份合法估時 800 分（<1440），皆 deadline D(3)。視窗 rolling_start=D(2)~D(3)=2 天≈1920 分，
    // 需求 3200 分 > 容量 → gap>0。每份 <每日容量，避免單份超日造成的放置雜訊。
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await mkTask(u, plan, list, { est: 800, deadline_date: D(3), title: `K5-${i}` }));
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.ok(r.body.infeasible, '應 infeasible');
    assert.ok(r.body.infeasible.plan_capacity_gap, '應回 PLAN_CAPACITY_GAP');
    assert.ok(r.body.infeasible.plan_capacity_gap.gap_minutes > 0, 'gap_minutes 應 > 0');
    assert.equal(r.body.infeasible.requested_minutes, 3200, 'requested 應為全部 tail 合法估時總和');
    assert.ok(typeof r.body.infeasible.available_minutes === 'number', '應回 available_minutes');
    assert.ok(r.body.infeasible.available_minutes <= 2 * DAY_CAPACITY + 1, '容量須以 deadline 綁定的 2 天視窗量測，不是 180 天');
    assert.notEqual(r.body.code, 'MISSING_PLANNING_HORIZON', 'Task 皆有 deadline → 視窗封閉，不得 fail closed');
  });

  test('K5b Task 無 deadline、由 Plan target_date 收緊 → 觸發 gap（否則 180 天永遠夠）', async () => {
    const u = nextUser();
    await mkUser(u);
    // Plan target_date = D(2)（＝rolling_start），視窗僅 1 天 960 分。
    const plan = await mkPlan(u, 'active', D(2)); const list = await mkList(u);
    // 兩份合法估時 800、皆無自身 deadline。需求 1600 > 960 → 只有靠 Plan target_date 收緊才有 gap。
    await mkTask(u, plan, list, { est: 800, title: 'nb-1' });
    await mkTask(u, plan, list, { est: 800, title: 'nb-2' });
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.code, 'MISSING_PLANNING_HORIZON', 'Plan target_date 提供上界 → 不得 fail closed');
    assert.ok(r.body.infeasible?.plan_capacity_gap, 'Plan target_date 收緊後應觸發 PLAN_CAPACITY_GAP');
    assert.ok(r.body.infeasible.plan_capacity_gap.gap_minutes > 0);
    assert.ok(r.body.infeasible.available_minutes <= DAY_CAPACITY + 1, '視窗須收到 Plan target_date（1 天），不是 180 天');
  });

  test('K5c Task deadline 早於 Plan target_date → 以「較早」的 Task deadline 為上限', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(10)); const list = await mkList(u);   // Plan target 很遠
    // 兩份 800、Task deadline D(2)（早於 Plan target D(10)）。若誤用較晚者，視窗 9 天容量足、無 gap。
    await mkTask(u, plan, list, { est: 800, deadline_date: D(2), title: 'ed-1' });
    await mkTask(u, plan, list, { est: 800, deadline_date: D(2), title: 'ed-2' });
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.ok(r.body.infeasible?.plan_capacity_gap, '以較早的 Task deadline 為界時視窗僅 1 天 → 應有 gap');
    assert.ok(r.body.infeasible.plan_capacity_gap.gap_minutes > 0);
    assert.ok(r.body.infeasible.available_minutes <= DAY_CAPACITY + 1, '上限須取較早的 Task deadline，不得被 Plan target_date 放寬');
  });

  test('K5d School Assignment deadline 不被 Plan target_date 放寬（hard upper bound）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(10)); const list = await mkList(u);   // Plan target 較晚
    // School Assignment 形狀：deadline_date + deadline_time，且早於 Plan target。
    const sa1 = await mkTask(u, plan, list, { est: 800, deadline_date: D(2), deadline_time: '18:00', title: 'SA-1' });
    const sa2 = await mkTask(u, plan, list, { est: 800, deadline_date: D(2), deadline_time: '18:00', title: 'SA-2' });
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    // 上限＝School Assignment deadline D(2)：視窗 1 天 → 需求 1600 > 960 → gap（證明未被 target 放寬到 D(10)）。
    assert.ok(r.body.infeasible?.plan_capacity_gap, 'School Assignment deadline 為 hard 上限 → 應有 gap');
    assert.ok(r.body.infeasible.available_minutes <= DAY_CAPACITY + 1, 'Plan target_date 不得把 School Assignment deadline 放寬到更晚');
    // 任何可套用 candidate 都不得晚於 School Assignment deadline：跨日不行，同日超過 deadline_time 也不行。
    for (const b of (r.body.candidate_blocks || [])) {
      if (Number(b.task_id) === Number(sa1) || Number(b.task_id) === Number(sa2)) {
        assert.ok(b.date <= D(2), 'School Assignment block 不得排到其 deadline 之後（日期）');
        if (b.date === D(2) && b.end_time) assert.ok(b.end_time <= '18:00', 'School Assignment block 同日不得晚於 deadline_time');
      }
    }
  });

  test('K5e School Assignment deadline_time：同日超時 block → TASK_INFEASIBLE 且不可確認；未超時 → 允許', async () => {
    // 未超時：frozen block 16:00–17:00，deadline_time 18:00 → 允許、可確認。
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(20)); const list = await mkList(u);
    const ok = await mkTask(u, plan, list, { est: 60, deadline_date: D(0), deadline_time: '18:00', title: 'SA-ok' });
    await seedVersion(u, [{ task_id: ok, date: D(0), start_time: '16:00', end_time: '17:00', planned_minutes: 60 }]);
    const r1 = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r1.status, 200);
    assert.ok(!(r1.body.infeasible?.deadline_violations || []).some(v => Number(v.task_id) === Number(ok)), '未超時不得違反');
    assert.ok(r1.body.candidate_blocks.some(b => Number(b.task_id) === Number(ok) && b.date === D(0)), '未超時 block 保留、可確認');

    // 超時：frozen block 18:30–19:30，deadline_time 18:00 同日 → deadline violation + TASK_INFEASIBLE。
    const u2 = nextUser(); await mkUser(u2);
    const plan2 = await mkPlan(u2, 'active', D(20)); const list2 = await mkList(u2);
    const bad = await mkTask(u2, plan2, list2, { est: 60, deadline_date: D(0), deadline_time: '18:00', title: 'SA-bad' });
    await seedVersion(u2, [{ task_id: bad, date: D(0), start_time: '18:30', end_time: '19:30', planned_minutes: 60 }]);
    const r2 = await runRollingPreview(u2, { plan_id: plan2 });
    assert.equal(r2.status, 200);
    assert.ok(r2.body.infeasible, '同日超過 deadline_time → infeasible（不可確認）');
    assert.ok(r2.body.infeasible.deadline_violations.some(v => Number(v.task_id) === Number(bad)), '同日超時應列 deadline violation（需比對 end_time，不只日期）');
    assert.ok(r2.body.infeasible.task_infeasible.some(x => Number(x.task_id) === Number(bad)), '同日超時應映射為 TASK_INFEASIBLE');
  });

  test('K8 所有 unplaced Task（含非 trigger、原屬 Plan、部分排入、多個）都映射成 TASK_INFEASIBLE', async () => {
    const u = nextUser(); await mkUser(u);
    // Plan target D(2)：視窗僅 1 天 960 分，塞不下多份 800 分的作業。
    const plan = await mkPlan(u, 'active', D(2)); const list = await mkList(u);
    const tA = await mkTask(u, plan, list, { est: 800, deadline_date: D(2), title: 'U-A' });
    const tB = await mkTask(u, plan, list, { est: 800, deadline_date: D(2), title: 'U-B' });
    const tC = await mkTask(u, plan, list, { est: 800, deadline_date: D(2), title: 'U-C' });
    // 期限早於 rolling_start → 完全排不進（scheduled 0），不是 deadline-violation block 而是純 unplaced。
    const tGone = await mkTask(u, plan, list, { est: 800, deadline_date: D(1), title: 'U-gone' });
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.ok(r.body.infeasible, '容量不足 → infeasible');
    const inf = r.body.infeasible.task_infeasible || [];
    const byId = new Map(inf.map(x => [Number(x.task_id), x]));
    // 每個排不進的 task_id 都必須出現在 task_infeasible（不能只回 boolean）。
    for (const id of [tA, tB, tC, tGone]) assert.ok(byId.has(Number(id)), `task_infeasible 必須含 ${id}`);
    // 結構化欄位：required/scheduled/missing。
    for (const id of [tA, tB, tC, tGone]) {
      const x = byId.get(Number(id));
      assert.equal(x.required_minutes, 800, 'required_minutes 應為該 task 的需求');
      assert.ok(x.missing_minutes > 0, 'missing_minutes 應 > 0');
      assert.ok(x.scheduled_minutes >= 0 && x.scheduled_minutes < 800, 'scheduled_minutes 介於 0 與需求之間');
    }
    // 完全排不進：tGone scheduled 0。部分排入：至少一個 0<scheduled<800。
    assert.equal(byId.get(Number(tGone)).scheduled_minutes, 0, 'deadline 早於視窗的 task 應完全排不進');
    assert.ok([tA, tB, tC].some(id => byId.get(Number(id)).scheduled_minutes > 0), '至少一個 task 應為部分排入');
  });

  test('K7 Task 與 Plan 皆無期限 → fail closed（MISSING_PLANNING_HORIZON、不可確認、不用 FAR 假造）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);   // Plan 無 target_date
    const t = await mkTask(u, plan, list, { est: 800, title: '無期限' });   // Task 無 deadline
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.equal(r.body.code, 'MISSING_PLANNING_HORIZON', '兩者皆無 → 必須 fail closed');
    assert.ok(r.body.missing_horizon_task_ids.includes(Number(t)), '應列出無上界的 task');
    // 不得產生可確認 candidate：blocks / candidate_blocks 皆為 null（前端 canConfirm 無法成立）。
    assert.equal(r.body.blocks, null, '不得產生可套用 blocks');
    assert.equal(r.body.candidate_blocks, null, '不得產生可套用 candidate_blocks');
    assert.equal(r.body.infeasible, null);
  });

  test('K6 mutation probe：Stability override（relax_freeze）不得解開 Lock', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(30)); const list = await mkList(u);   // 段考日期已知
    const t = await mkTask(u, plan, list, { est: 60 });
    await seedVersion(u, [{ task_id: t, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    await q.run('INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,?,?)', [u, 'task', t]);
    const r = await runRollingPreview(u, { plan_id: plan, freeze: { override: { mode: 'relax_freeze' } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.frozen.length, 0, 'relax_freeze 後不再有 freeze pin');
    const held = r.body.candidate_blocks.some(b => Number(b.task_id) === t && b.date === D(0) && b.start_time === '19:00');
    assert.ok(held, 'Lock 不得被 Stability override 解開，block 仍應鎖在原位');
    assert.ok(!r.body.candidate_blocks.some(b => Number(b.task_id) === t && b.date >= win.rolling_start),
      'Lock 的 task 不得被移進 rolling window');
  });
});

/* ================= L. effective upper bound（Task deadline × Plan target_date）DiD ================= */
describe('L. effective upper bound defence-in-depth', () => {
  // preview：tail 一律被 preview window 收在有效上限內，唯一能自然越界的是 freeze 窗內的既有 block。
  // Task 無 deadline、段考就在今天（Plan target=D(0)）、明天仍有 frozen block（D(1)>D(0)）→ infeasible。
  test('L1 preview：Task 無 deadline、frozen block 晚於 Plan target_date → infeasible（plan_target 違反）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(0)); const list = await mkList(u);
    const t = await mkTask(u, plan, list, { est: 60 });   // 無 deadline
    await seedVersion(u, [{ task_id: t, date: D(1), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const r = await runRollingPreview(u, { plan_id: plan });
    assert.equal(r.status, 200);
    assert.ok(r.body.infeasible, 'block 晚於 Plan target_date 應 infeasible');
    assert.ok(r.body.infeasible.deadline_violations.some(v => Number(v.task_id) === Number(t) && v.type === 'plan_target'),
      '應以 Plan target_date 判為越界（即使 Task 無 deadline）');
  });

  // apply 端 helper：期望整筆被拒（DEADLINE_VIOLATION）且不建立新版本。
  const applyRejectsNoVersion = async (u, plan, baseV, blocks) => {
    const before = await sched.getActiveVersionId(u);
    await assert.rejects(() => sched.applySchedule(u, { planId: plan, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks, expectedBaseVersionId: baseV, enforceDeadlines: true }),
      e => e.code === 'DEADLINE_VIOLATION' && e.status === 409);
    assert.equal(await sched.getActiveVersionId(u), before, 'apply 被拒後不得建立新版本');
  };

  test('L2 apply：Task 無 deadline、Plan target=D(3)、block=D(4) 繞過 preview → 拒絕、不建版', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(3)); const list = await mkList(u);
    const t = await mkTask(u, plan, list, { est: 60 });   // 無 deadline
    const v = await seedVersion(u, [{ task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    await applyRejectsNoVersion(u, plan, v, [{ task_id: t, date: D(4), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
  });

  test('L3 apply：Task deadline=D(5)、Plan target=D(3)、block=D(4) → 取較早者 D(3) 拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(3)); const list = await mkList(u);
    const t = await mkTask(u, plan, list, { est: 60, deadline_date: D(5) });
    const v = await seedVersion(u, [{ task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    await applyRejectsNoVersion(u, plan, v, [{ task_id: t, date: D(4), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
  });

  test('L4 apply：Task deadline=D(2)、Plan target=D(5)、block=D(3) → 取較早者 D(2) 拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(5)); const list = await mkList(u);
    const t = await mkTask(u, plan, list, { est: 60, deadline_date: D(2) });
    const v = await seedVersion(u, [{ task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    await applyRejectsNoVersion(u, plan, v, [{ task_id: t, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
  });

  test('L5 apply 重讀 CURRENT Plan target：更新 target_date 後用舊 preview candidate apply → 拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(5)); const list = await mkList(u);
    const t = await mkTask(u, plan, list, { est: 60 });   // 無 deadline
    const v = await seedVersion(u, [{ task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    // 舊 preview 在 target=D(5) 下 D(4) 合法；把 target 收緊到 D(3) 後，apply 必須以 CURRENT target 重驗。
    await q.run('UPDATE plans SET target_date=? WHERE id=? AND user_id=?', [D(3), plan, u]);
    await applyRejectsNoVersion(u, plan, v, [{ task_id: t, date: D(4), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
  });

  test('L6 apply：其他 Plan carry-forward block 超過該 Plan CURRENT target_date → 不得靜默寫入新版', async () => {
    const u = nextUser(); await mkUser(u);
    const planA = await mkPlan(u, 'active', D(30)); const planB = await mkPlan(u, 'active', D(3));
    const listA = await mkList(u, '數'); const listB = await mkList(u, '理');
    const tA = await mkTask(u, planA, listA, { est: 60 });
    const tB = await mkTask(u, planB, listB, { est: 60 });   // planB 無 task deadline，靠 planB target D(3)
    // planB 既有 active block 在 D(4)（> planB target D(3)）。
    const v = await seedVersion(u, [
      { task_id: tA, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: tB, date: D(4), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
    ]);
    const before = await sched.getActiveVersionId(u);
    // 對 planA 做一次本身合法的 rolling apply；carry-forward 會帶入 planB 的 D(4) 越界 block → 整筆拒絕。
    await assert.rejects(() => sched.applySchedule(u, { planId: planA, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks: [{ task_id: tA, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
      expectedBaseVersionId: v, enforceDeadlines: true }),
      e => e.code === 'DEADLINE_VIOLATION');
    assert.equal(await sched.getActiveVersionId(u), before, '不得寫入含越界 carry-forward 的新版');
  });
});
