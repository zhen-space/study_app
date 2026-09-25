// 持續型段考 Plan Phase 2：Atomic Content Attachment（backend/domain）迴歸。
//
// 擴充 /api/schedule/rolling/preview 與 /apply：在不先改 production state 的前提下
// 預覽並「原子」加入 (1) 多個 existing standalone Task (2) 多個 School Assignment
// (3) Material content item selection (4) Material selection 所需的新 Task。
//
// 直接呼叫 engine（runRollingPreview / applySchedule），才驗得到 transaction 內的
// defence-in-depth 與 rollback。三時區各跑一次。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'attach-')), 'attach.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const sched = await import('../src/schedule/persistence.js');
const { runRollingPreview } = await import('../src/routes/schedule.js');
const { signMaterialSnapshotToken } = await import('../src/schedule/material-token.js');
const { todayTW, addDays } = await import('../src/util/date.js');

const TODAY = todayTW();
const D = n => addDays(TODAY, n);

let uid = 5000;
const nextUser = () => ++uid;

async function mkUser(id) {
  await q.run('INSERT INTO users (id,email,password_hash,sleep_start,sleep_end,meal_windows) VALUES (?,?,?,?,?,?)',
    [id, `att${id}@t`, 'x', '23:00', '07:00', '[]']);
}
async function mkPlan(userId, status = 'active', target_date = D(30)) {
  const p = await q.run('INSERT INTO plans (user_id,name,status,target_date) VALUES (?,?,?,?)', [userId, `計畫${userId}`, status, target_date]);
  return p.lastInsertRowid;
}
async function mkList(userId, name = '數學') {
  const l = await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [userId, name]);
  return l.lastInsertRowid;
}
// standalone Task（plan_id=NULL）；o.kind='school_assignment' + deadline 就是 School Assignment。
const estOf = o => (Object.prototype.hasOwnProperty.call(o, 'est') ? o.est : 60);   // 允許顯式 null
async function mkStandalone(userId, listId, o = {}) {
  const r = await q.run(
    `INSERT INTO tasks (user_id,list_id,title,plan_id,estimated_minutes,deadline_date,deadline_time,task_kind,school_assignment_type)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [userId, listId, o.title || '待辦', o.plan_id ?? null, estOf(o), o.deadline_date ?? null, o.deadline_time ?? null,
      o.kind || 'standard', o.school_assignment_type ?? null]);
  return r.lastInsertRowid;
}
async function mkPlanTask(userId, planId, listId, o = {}) {
  return mkStandalone(userId, listId, { ...o, plan_id: planId });
}
async function seedVersion(userId, blocks) {
  const v = await sched.createScheduleVersion(userId, { source: sched.SOURCE.INITIAL, effectiveFrom: D(0), blocks });
  return v.version_id;
}
async function mkBook(userId, listId) {
  const b = await q.run('INSERT INTO material_books (user_id,title,subject_list_id) VALUES (?,?,?)', [userId, '教材', listId]);
  return b.lastInsertRowid;
}
async function mkNode(userId, bookId) {
  const n = await q.run('INSERT INTO material_nodes (user_id,book_id,parent_id,kind,title) VALUES (?,?,?,?,?)', [userId, bookId, null, 'chapter', '章']);
  return n.lastInsertRowid;
}
async function mkContentItem(userId, bookId, nodeId, o = {}) {
  const r = await q.run(
    'INSERT INTO material_content_items (user_id,book_id,node_id,kind,title,estimated_minutes) VALUES (?,?,?,?,?,?)',
    [userId, bookId, nodeId, o.kind || 'reading', o.title || '內容', estOf(o)]);
  return r.lastInsertRowid;
}
// 一次做好一本書＋一個章＋一份內容，回傳 content_item_id。
async function mkMaterialItem(userId, listId, o = {}) {
  const book = await mkBook(userId, listId);
  const node = await mkNode(userId, book);
  return mkContentItem(userId, book, node, o);
}

const countTasks = u => q.get('SELECT COUNT(*) c FROM tasks WHERE user_id=?', [u]).then(r => r.c);
const countPMI = u => q.get('SELECT COUNT(*) c FROM plan_material_items WHERE user_id=?', [u]).then(r => r.c);
const countProgress = u => q.get('SELECT COUNT(*) c FROM material_progress WHERE user_id=?', [u]).then(r => r.c);
const countVersions = u => q.get('SELECT COUNT(*) c FROM schedule_versions WHERE user_id=?', [u]).then(r => r.c);
const countSessions = u => q.get('SELECT COUNT(*) c FROM study_sessions WHERE user_id=?', [u]).then(r => r.c);
const countPMISel = u => q.get('SELECT COUNT(*) c FROM plan_material_items WHERE user_id=?', [u]).then(r => r.c);

// 產生一個「與 CURRENT material 一致」的合法簽章 token（測試模擬 preview 端）。
async function tokenFor(u, planId, cid, clientKey, baseVersion = null) {
  const mi = await q.get(
    `SELECT i.id,i.book_id,i.title,i.estimated_minutes,b.subject_list_id
       FROM material_content_items i LEFT JOIN material_books b ON b.id=i.book_id AND b.user_id=i.user_id
      WHERE i.id=? AND i.user_id=?`, [cid, u]);
  return signMaterialSnapshotToken({
    user_id: u, plan_id: planId, base_version_id: baseVersion, client_key: clientKey, content_item_id: cid,
    title: mi.title ?? null, estimated_minutes: mi.estimated_minutes ?? null,
    material_book_id: mi.book_id ?? null, subject_list_id: mi.subject_list_id ?? null,
  });
}

// 把一次 preview 的結果原封不動送進 apply（模擬真實 client round-trip）。
async function applyFromPreview(u, planId, pv, extra = {}) {
  const b = pv.body;
  return sched.applySchedule(u, {
    planId, source: sched.SOURCE.AI_REPLAN, reason: 'phase2',
    effectiveFrom: b.window.freeze_start,
    blocks: b.blocks || [],
    expectedBaseVersionId: b.base_version_id ?? null,
    attachTaskIds: b.attach_task_ids || [],
    taskCreates: b.task_creates || [],
    freezeBlocks: (b.frozen && b.frozen.length)
      ? b.frozen.map(f => ({ task_id: f.task_id, date: f.date, start_time: f.start_time, end_time: f.end_time, planned_minutes: f.planned_minutes }))
      : null,
    enforceDeadlines: true,
    rollingStrict: true,                    // 與正式 rolling/apply route 一致
    ...extra,
  });
}

before(async () => { await initSchema(); });

describe('Phase 2. Atomic Content Attachment', () => {
  test('P1 preview 零 DB mutation（attach + material selection 都不寫任何表）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const t1 = await mkStandalone(u, list, { est: 60 });
    const cid = await mkMaterialItem(u, list, { est: 90 });
    const before = { tasks: await countTasks(u), pmi: await countPMI(u), prog: await countProgress(u), ver: await countVersions(u) };
    const r = await runRollingPreview(u, { plan_id: plan, add_task_ids: [t1], material_selections: [{ content_item_id: cid, client_key: 'k1' }] });
    assert.equal(r.status, 200);
    assert.equal(await countTasks(u), before.tasks, 'preview 不得建立 Task');
    assert.equal(await countPMI(u), before.pmi, 'preview 不得寫 plan_material_items');
    assert.equal(await countProgress(u), before.prog, 'preview 不得寫 material_progress');
    assert.equal(await countVersions(u), before.ver, 'preview 不得建立 ScheduleVersion');
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [t1])).plan_id, null, 'preview 不得 PATCH tasks.plan_id');
  });

  test('P2 批次 existing Task attach：多個 standalone Task 進 attach_task_ids 與 candidate', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await mkStandalone(u, list, { est: 60, title: `T${i}` }));
    const r = await runRollingPreview(u, { plan_id: plan, add_task_ids: ids });
    assert.equal(r.status, 200);
    for (const id of ids) assert.ok(r.body.attach_task_ids.includes(Number(id)), `attach_task_ids 應含 ${id}`);
    assert.deepEqual([...r.body.pending_changes.attach_task_ids].sort(), [...ids].sort());
    for (const id of ids) assert.ok(r.body.candidate_blocks.some(b => Number(b.task_id) === Number(id)), `candidate 應排入 ${id}`);
  });

  test('P3 批次 School Assignment attach + P4 deadline 完整保留（apply 後不被覆寫）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const sa1 = await mkStandalone(u, list, { est: 60, kind: 'school_assignment', school_assignment_type: 'homework', deadline_date: D(4), deadline_time: '18:00', title: 'SA1' });
    const sa2 = await mkStandalone(u, list, { est: 60, kind: 'school_assignment', school_assignment_type: 'report', deadline_date: D(6), title: 'SA2' });
    const pv = await runRollingPreview(u, { plan_id: plan, add_task_ids: [sa1, sa2] });
    assert.equal(pv.status, 200);
    assert.ok(pv.body.attach_task_ids.includes(Number(sa1)) && pv.body.attach_task_ids.includes(Number(sa2)));
    // School Assignment 的 candidate block 不得晚於其 deadline（日期＋同日 deadline_time）。
    for (const b of pv.body.candidate_blocks) {
      if (Number(b.task_id) === Number(sa1)) { assert.ok(b.date <= D(4), 'SA1 不得排到 deadline 後'); if (b.date === D(4) && b.end_time) assert.ok(b.end_time <= '18:00'); }
      if (Number(b.task_id) === Number(sa2)) assert.ok(b.date <= D(6), 'SA2 不得排到 deadline 後');
    }
    const res = await applyFromPreview(u, plan, pv);
    assert.ok(res.version_id);
    // deadline_date/deadline_time 一字不動（mirror 只寫 due_date/due_time）。
    const a1 = await q.get('SELECT plan_id,deadline_date,deadline_time FROM tasks WHERE id=?', [sa1]);
    assert.equal(a1.plan_id, plan, 'School Assignment 已掛入本計畫');
    assert.equal(a1.deadline_date, D(4), 'deadline_date 不得被覆寫');
    assert.equal(a1.deadline_time, '18:00', 'deadline_time 不得被覆寫');
    assert.equal((await q.get('SELECT deadline_date FROM tasks WHERE id=?', [sa2])).deadline_date, D(6));
  });

  test('P5 Material selection + Task create 原子成功（建立 Task、寫 selection、排入 block）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est: 90, title: '第一章閱讀' });
    const pv = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm1' }] });
    assert.equal(pv.status, 200);
    assert.equal(pv.body.task_creates.length, 1, 'material selection → 一個待建立 Task');
    assert.equal(pv.body.task_creates[0].content_item_id, cid);
    assert.ok(pv.body.candidate_blocks.some(b => b.client_key === 'm1'), 'candidate 用 client_key 佔位（尚無 task_id）');
    const versBefore = await countVersions(u);
    const res = await applyFromPreview(u, plan, pv);
    assert.ok(res.version_id);
    // 新 Task 建立、指向 material item、掛在本計畫。
    const task = await q.get('SELECT id,plan_id,material_content_item_id,estimated_minutes FROM tasks WHERE user_id=? AND material_content_item_id=?', [u, cid]);
    assert.ok(task, '應建立對應 Material 的新 Task');
    assert.equal(task.plan_id, plan);
    assert.equal(task.estimated_minutes, 90, 'estimated_minutes 以 CURRENT material item 為準');
    // plan_material_items selection 列（selected=1、指向新 Task）。
    const pmi = await q.get('SELECT selected,task_id,removed_at FROM plan_material_items WHERE user_id=? AND plan_id=? AND content_item_id=?', [u, plan, cid]);
    assert.ok(pmi, '應寫入 plan_material_items selection');
    assert.equal(pmi.selected, 1);
    assert.equal(Number(pmi.task_id), Number(task.id));
    assert.equal(pmi.removed_at, null);
    // block 進入新版本。
    assert.ok(await q.get('SELECT 1 FROM scheduled_blocks WHERE schedule_version_id=? AND task_id=?', [res.version_id, task.id]), 'Material Task 應有排定 block');
    assert.equal(await countVersions(u), versBefore + 1, '只建立一個新 ScheduleVersion');
  });

  test('P6 Material completion 不被修改（selection ≠ completion）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est: 60 });
    const progBefore = await countProgress(u);
    const pv = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm1' }] });
    await applyFromPreview(u, plan, pv);
    assert.equal(await countProgress(u), progBefore, 'apply 不得寫 material_progress（完成度）');
    const prog = await q.get('SELECT completed FROM material_progress WHERE user_id=? AND content_item_id=?', [u, cid]);
    assert.equal(prog, undefined, '沒有任何 completion 列被建立');
  });

  test('P7 inactive Plan 拒絕（preview + apply）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'paused'); const list = await mkList(u);
    const t = await mkStandalone(u, list, { est: 60 });
    const r = await runRollingPreview(u, { plan_id: plan, add_task_ids: [t] });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PLAN_NOT_ROLLING_ELIGIBLE');
    await assert.rejects(() => sched.applySchedule(u, { planId: plan, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0), blocks: [], attachTaskIds: [t], enforceDeadlines: true }));
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [t])).plan_id, null, 'inactive plan 不得掛入 Task');
  });

  test('P8 cross-user 拒絕（別人的 Task / material item）', async () => {
    const owner = nextUser(); await mkUser(owner);
    const other = nextUser(); await mkUser(other);
    const listO = await mkList(other);
    const foreignTask = await mkStandalone(other, listO, { est: 60 });
    const foreignItem = await mkMaterialItem(other, listO, { est: 60 });
    const plan = await mkPlan(owner); await mkList(owner);
    const r1 = await runRollingPreview(owner, { plan_id: plan, add_task_ids: [foreignTask] });
    assert.equal(r1.body.code, 'ADD_VALIDATION_FAILED');
    assert.ok(r1.body.add_errors.some(e => e.kind === 'task' && Number(e.id) === Number(foreignTask) && e.reason === 'not_found'));
    const r2 = await runRollingPreview(owner, { plan_id: plan, material_selections: [{ content_item_id: foreignItem, client_key: 'x' }] });
    assert.equal(r2.body.code, 'ADD_VALIDATION_FAILED');
    assert.ok(r2.body.add_errors.some(e => e.kind === 'material' && Number(e.id) === Number(foreignItem) && e.reason === 'not_found'));
    // apply 端同樣擋下（owner-scoped）。
    await assert.rejects(() => sched.applySchedule(owner, { planId: plan, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0), blocks: [], attachTaskIds: [foreignTask], enforceDeadlines: true }));
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [foreignTask])).plan_id, null);
  });

  test('P9 already-attached / attached-to-other-plan 拒絕（preview + apply）', async () => {
    const u = nextUser(); await mkUser(u);
    const planA = await mkPlan(u); const planB = await mkPlan(u); const list = await mkList(u);
    const inThis = await mkPlanTask(u, planA, list, { est: 60 });        // 已在 planA
    const inOther = await mkPlanTask(u, planB, list, { est: 60 });       // 在 planB
    const r1 = await runRollingPreview(u, { plan_id: planA, add_task_ids: [inThis] });
    assert.equal(r1.body.code, 'ADD_VALIDATION_FAILED');
    assert.ok(r1.body.add_errors.some(e => Number(e.id) === Number(inThis) && e.reason === 'already_attached'));
    const r2 = await runRollingPreview(u, { plan_id: planA, add_task_ids: [inOther] });
    assert.ok(r2.body.add_errors.some(e => Number(e.id) === Number(inOther) && e.reason === 'attached_to_other_plan'));
    // apply：把 planB 的 Task 掛到 planA 一律拒絕。
    await assert.rejects(() => sched.applySchedule(u, { planId: planA, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0), blocks: [], attachTaskIds: [inOther], enforceDeadlines: true }));
    assert.equal(Number((await q.get('SELECT plan_id FROM tasks WHERE id=?', [inOther])).plan_id), Number(planB), 'planB Task 仍屬 planB');
  });

  test('P10 missing estimate fail closed（existing Task 與 material item）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const noEst = await mkStandalone(u, list, { est: null });
    const r1 = await runRollingPreview(u, { plan_id: plan, add_task_ids: [noEst] });
    assert.equal(r1.body.code, 'MISSING_ESTIMATE');
    assert.ok(r1.body.missing_estimate_task_ids.includes(Number(noEst)));
    assert.equal(r1.body.blocks, null);
    const cidNoEst = await mkMaterialItem(u, list, { est: null });
    const r2 = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cidNoEst, client_key: 'mm' }] });
    assert.equal(r2.body.code, 'MISSING_ESTIMATE');
    assert.ok(r2.body.missing_estimate_material_keys.includes('mm'));
    assert.equal(r2.body.candidate_blocks, null);
  });

  test('P11 already-completed material 拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est: 60 });
    await q.run('INSERT INTO material_progress (user_id,content_item_id,completed,completed_at) VALUES (?,?,1,?)', [u, cid, D(0)]);
    const r = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'c' }] });
    assert.equal(r.body.code, 'ADD_VALIDATION_FAILED');
    assert.ok(r.body.add_errors.some(e => e.kind === 'material' && Number(e.id) === Number(cid) && e.reason === 'already_completed'));
  });

  test('P12 stale preview → rollback（attach / create / version 都不留下）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const seedTask = await mkPlanTask(u, plan, list, { est: 60 });
    const v = await seedVersion(u, [{ task_id: seedTask, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const attach = await mkStandalone(u, list, { est: 60 });
    const cid = await mkMaterialItem(u, list, { est: 60 });
    const tasksBefore = await countTasks(u); const pmiBefore = await countPMI(u); const verBefore = await countVersions(u);
    await assert.rejects(() => sched.applySchedule(u, {
      planId: plan, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks: [{ task_id: seedTask, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
        { client_key: 'm', date: D(3), start_time: '20:10', end_time: '21:10', planned_minutes: 60 }],
      expectedBaseVersionId: v - 999,               // 過時 → STALE
      attachTaskIds: [attach], taskCreates: [{ client_key: 'm', title: 'M', material_content_item_id: cid }],
      enforceDeadlines: true,
    }), e => e.code === 'STALE_SCHEDULE_PREVIEW');
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [attach])).plan_id, null, 'attach 已 rollback');
    assert.equal(await countTasks(u), tasksBefore, 'task create 已 rollback');
    assert.equal(await countPMI(u), pmiBefore, 'selection 已 rollback');
    assert.equal(await countVersions(u), verBefore, '未建立新版本');
  });

  test('P13 deadline/target 違反 → 整筆 rollback（含 attach、material create、selection）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active', D(3)); const list = await mkList(u);   // Plan target D(3)
    const seedTask = await mkPlanTask(u, plan, list, { est: 60 });
    const v = await seedVersion(u, [{ task_id: seedTask, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const attach = await mkStandalone(u, list, { est: 60 });
    const cid = await mkMaterialItem(u, list, { est: 60 });
    const tasksBefore = await countTasks(u); const pmiBefore = await countPMI(u); const verBefore = await countVersions(u);
    // material create 的 block 排在 D(4) > Plan target D(3) → DEADLINE_VIOLATION → 全 rollback。
    await assert.rejects(() => sched.applySchedule(u, {
      planId: plan, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks: [{ task_id: seedTask, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
        { client_key: 'm', date: D(4), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
      expectedBaseVersionId: v, attachTaskIds: [attach],
      taskCreates: [{ client_key: 'm', title: 'M', material_content_item_id: cid }],
      enforceDeadlines: true,
    }), e => e.code === 'DEADLINE_VIOLATION');
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [attach])).plan_id, null, 'attach rollback');
    assert.equal(await countTasks(u), tasksBefore, 'material task create rollback');
    assert.equal(await countPMI(u), pmiBefore, 'selection rollback');
    assert.equal(await countVersions(u), verBefore, '未建立新版本');
  });

  test('P14 Lock 違反 → rollback', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const locked = await mkPlanTask(u, plan, list, { est: 60 });
    const v = await seedVersion(u, [{ task_id: locked, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    await q.run('INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,?,?)', [u, 'task', locked]);
    const attach = await mkStandalone(u, list, { est: 60 });
    const tasksBefore = await countTasks(u);
    // candidate 少了被鎖的 block（把它移走）→ assertCandidateLocks 應炸。
    await assert.rejects(() => sched.applySchedule(u, {
      planId: plan, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks: [{ task_id: locked, date: D(5), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
      expectedBaseVersionId: v, attachTaskIds: [attach], enforceDeadlines: true,
    }));
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [attach])).plan_id, null, 'lock 違反 → attach rollback');
    assert.equal(await countTasks(u), tasksBefore);
  });

  test('P15 freeze 違反 → rollback', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const frozen = await mkPlanTask(u, plan, list, { est: 60 });
    const v = await seedVersion(u, [{ task_id: frozen, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const attach = await mkStandalone(u, list, { est: 60 });
    await assert.rejects(() => sched.applySchedule(u, {
      planId: plan, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0),
      blocks: [{ task_id: frozen, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],  // 把凍結 block 搬走
      expectedBaseVersionId: v, attachTaskIds: [attach],
      freezeBlocks: [{ task_id: frozen, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
      enforceDeadlines: true,
    }), e => e.code === 'FREEZE_VIOLATION');
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [attach])).plan_id, null, 'freeze 違反 → attach rollback');
  });

  test('P16 成功套用：只建立一個新版本 + 其他 Plan blocks 完整 carry-forward + StudySession 不受影響', async () => {
    const u = nextUser(); await mkUser(u);
    const planA = await mkPlan(u); const planB = await mkPlan(u);
    const listA = await mkList(u, '數'); const listB = await mkList(u, '理');
    const tA = await mkPlanTask(u, planA, listA, { est: 60 });
    const tB = await mkPlanTask(u, planB, listB, { est: 60 });
    const v = await seedVersion(u, [
      { task_id: tA, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: tB, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
    ]);
    // 一筆既有 StudySession，套用後必須完全不動。
    await q.run('INSERT INTO study_sessions (user_id,task_id,started_at,actual_minutes,status,source) VALUES (?,?,?,?,?,?)',
      [u, tA, `${D(0)}T10:00:00`, 25, 'completed', 'manual']);
    const attach = await mkStandalone(u, listA, { est: 60 });
    const sessBefore = await countSessions(u); const verBefore = await countVersions(u);
    const pv = await runRollingPreview(u, { plan_id: planA, add_task_ids: [attach] });
    assert.equal(pv.status, 200);
    const res = await applyFromPreview(u, planA, pv);
    assert.ok(res.version_id);
    assert.equal(await countVersions(u), verBefore + 1, '成功只建立一個新版本');
    // planB 的 block 完整 carry-forward 進新版本。
    assert.ok(await q.get('SELECT 1 FROM scheduled_blocks WHERE schedule_version_id=? AND task_id=?', [res.version_id, tB]), '其他 Plan block 應 carry-forward');
    assert.equal(await countSessions(u), sessBefore, 'StudySession 完全不受影響');
  });
});

/* ===== Phase 2 final audit：strict rolling apply、CURRENT material、client_key、
        duplicate selection、active-only、candidate presence、synthetic id 清除 ===== */
describe('Phase 2 audit. strict rolling atomic attachment', () => {
  // 直接對 applySchedule 送 rolling strict 請求（＝正式 rolling/apply route）。
  const strictApply = (u, planId, o) => sched.applySchedule(u, {
    planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0), enforceDeadlines: true, rollingStrict: true, ...o,
  });

  test('A1 rolling apply 拒絕任意非 Material task_create（零寫入）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); await mkList(u);
    const before = { t: await countTasks(u), v: await countVersions(u) };
    await assert.rejects(() => strictApply(u, plan, {
      taskCreates: [{ client_key: 'x', title: '任意任務', estimated_minutes: 60 }],
      blocks: [{ client_key: 'x', date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    }), e => e.code === 'ROLLING_STRICT_TASK_CREATE');
    assert.equal(await countTasks(u), before.t, '不得建立任何 Task');
    assert.equal(await countVersions(u), before.v, '不得建立版本');
  });

  test('A2 preview 後 CURRENT material estimate 變 null → apply fail closed + 全 rollback', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est: 90 });
    const pv = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm' }] });
    assert.equal(pv.status, 200);
    await q.run('UPDATE material_content_items SET estimated_minutes=NULL WHERE id=? AND user_id=?', [cid, u]);
    const before = { t: await countTasks(u), p: await countPMI(u), v: await countVersions(u) };
    await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_ESTIMATE_MISSING');
    assert.equal(await countTasks(u), before.t, 'task create rollback');
    assert.equal(await countPMI(u), before.p, 'selection rollback');
    assert.equal(await countVersions(u), before.v, '無新版本');
  });

  test('A3 client 偽造 title/list_id/estimate → apply 一律用 CURRENT material 值', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const realList = await mkList(u, '真科目'); const bogusList = await mkList(u, '假科目');
    const cid = await mkMaterialItem(u, realList, { est: 90, title: '真標題' });
    const pv = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm' }] });
    // 竄改 client 傳回的 task_create（模擬惡意 client）。
    pv.body.task_creates = pv.body.task_creates.map(tc => ({ ...tc, title: '假標題', list_id: bogusList, estimated_minutes: 5, material_book_id: 999999 }));
    const res = await applyFromPreview(u, plan, pv);
    assert.ok(res.version_id);
    const task = await q.get('SELECT title,list_id,estimated_minutes FROM tasks WHERE user_id=? AND material_content_item_id=?', [u, cid]);
    assert.equal(task.title, '真標題', 'title 用 CURRENT material');
    assert.equal(Number(task.list_id), Number(realList), 'list_id 用 CURRENT material book subject');
    assert.equal(task.estimated_minutes, 90, 'estimated_minutes 用 CURRENT material');
  });

  test('A4 兩個 Material 共用同一 client_key → preview 與 apply 均拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const c1 = await mkMaterialItem(u, list, { est: 60 });
    const c2 = await mkMaterialItem(u, list, { est: 60 });
    const pv = await runRollingPreview(u, { plan_id: plan, material_selections: [
      { content_item_id: c1, client_key: 'dup' }, { content_item_id: c2, client_key: 'dup' }] });
    assert.equal(pv.body.code, 'ADD_VALIDATION_FAILED');
    assert.ok(pv.body.add_errors.some(e => e.reason === 'duplicate_client_key'));
    // apply 端亦拒絕（不以 Map overwrite 掩蓋）。兩個 create 都帶合法 token，確保是在 dup 守門被擋。
    const tkC1 = await tokenFor(u, plan, c1, 'dup');
    const tkC2 = await tokenFor(u, plan, c2, 'dup');
    await assert.rejects(() => strictApply(u, plan, {
      taskCreates: [
        { client_key: 'dup', material_content_item_id: c1, material_snapshot_token: tkC1 },
        { client_key: 'dup', material_content_item_id: c2, material_snapshot_token: tkC2 }],
      blocks: [{ client_key: 'dup', date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    }), e => e.code === 'DUPLICATE_CLIENT_KEY');
  });

  test('A5 同 Material 已 selected/已有 live Task → 不建重複 Task、不覆寫 linkage', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est: 60 });
    const pv1 = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm' }] });
    const res1 = await applyFromPreview(u, plan, pv1);
    assert.ok(res1.version_id);
    const firstTask = await q.get('SELECT id FROM tasks WHERE user_id=? AND material_content_item_id=?', [u, cid]);
    const firstPmi = await q.get('SELECT task_id FROM plan_material_items WHERE user_id=? AND plan_id=? AND content_item_id=?', [u, plan, cid]);
    // preview 再選一次同一 material → already_selected。
    const pv2 = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm2' }] });
    assert.equal(pv2.body.code, 'ADD_VALIDATION_FAILED');
    assert.ok(pv2.body.add_errors.some(e => e.reason === 'already_selected'));
    // apply 硬送第二次 → ALREADY_SELECTED，且不得覆寫原 linkage、不得建立第二個 Task。
    await assert.rejects(() => strictApply(u, plan, {
      taskCreates: [{ client_key: 'm2', material_content_item_id: cid }],
      blocks: [{ client_key: 'm2', date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    }), e => e.code === 'ALREADY_SELECTED');
    assert.equal((await q.get('SELECT COUNT(*) c FROM tasks WHERE user_id=? AND material_content_item_id=? AND COALESCE(deleted,0)=0', [u, cid])).c, 1, '仍只有一個 Task');
    assert.equal(Number((await q.get('SELECT task_id FROM plan_material_items WHERE user_id=? AND plan_id=? AND content_item_id=?', [u, plan, cid])).task_id), Number(firstPmi.task_id), 'linkage 未被覆寫');
    assert.ok(firstTask);
  });

  test('A6 draft Plan 的 preview attachment → 拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'draft'); const list = await mkList(u);
    const t = await mkStandalone(u, list, { est: 60 });
    const r = await runRollingPreview(u, { plan_id: plan, add_task_ids: [t] });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PLAN_NOT_ACTIVE_FOR_ATTACH');
  });

  test('A7 preview 後 Plan active→draft → apply 拒絕新增且 rollback（active-only）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'active'); const list = await mkList(u);
    const t = await mkStandalone(u, list, { est: 60 });
    const pv = await runRollingPreview(u, { plan_id: plan, add_task_ids: [t] });
    assert.equal(pv.status, 200);
    // draft 仍能滾動重排，但含新增內容時必須是 active → apply 應以 CURRENT status 拒絕。
    await q.run('UPDATE plans SET status=? WHERE id=? AND user_id=?', ['draft', plan, u]);
    await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'PLAN_NOT_ACTIVE_FOR_ATTACH');
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [t])).plan_id, null, 'attach rollback');
  });

  test('A8 attach_task_id 未出現在 blocks → apply 拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const t = await mkStandalone(u, list, { est: 60 });
    await assert.rejects(() => strictApply(u, plan, { attachTaskIds: [t], blocks: [] }),
      e => e.code === 'ATTACH_NOT_IN_CANDIDATE');
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [t])).plan_id, null, 'attach rollback');
  });

  test('A9 task_create client_key 未出現在 blocks → apply 拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est: 60 });
    const before = { t: await countTasks(u), v: await countVersions(u) };
    const tkA9 = await tokenFor(u, plan, cid, 'm');
    await assert.rejects(() => strictApply(u, plan, {
      taskCreates: [{ client_key: 'm', material_content_item_id: cid, material_snapshot_token: tkA9 }], blocks: [],
    }), e => e.code === 'CREATE_NOT_IN_CANDIDATE');
    assert.equal(await countTasks(u), before.t, '無 Task 殘留');
    assert.equal(await countVersions(u), before.v, '無新版本');
  });

  test('A10 block 使用未知 client_key → apply 拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); await mkList(u);
    await assert.rejects(() => strictApply(u, plan, {
      taskCreates: [], blocks: [{ client_key: 'ghost', date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    }), e => e.code === 'BLOCK_UNKNOWN_IDENTITY');
  });

  test('A11 preview response 深層結構完全沒有負數 synthetic task id', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const t = await mkStandalone(u, list, { est: 60 });
    const c1 = await mkMaterialItem(u, list, { est: 60 });
    const c2 = await mkMaterialItem(u, list, { est: 60 });
    const pv = await runRollingPreview(u, { plan_id: plan, add_task_ids: [t], material_selections: [
      { content_item_id: c1, client_key: 'a' }, { content_item_id: c2, client_key: 'b' }] });
    assert.equal(pv.status, 200);
    const json = JSON.stringify(pv.body);
    assert.ok(!/"task_id":\s*-\d/.test(json), 'response 不得殘留負數 synthetic task id');
    // material candidate block 一律 task_id:null + client_key。
    const matBlocks = (pv.body.candidate_blocks || []).filter(b => b.client_key);
    assert.ok(matBlocks.length >= 2 && matBlocks.every(b => b.task_id === null), 'material block 一律 {task_id:null, client_key}');
    // 遞迴掃描任何 task_id 欄位皆不得為負。
    const scan = o => { if (Array.isArray(o)) o.forEach(scan); else if (o && typeof o === 'object') { if ('task_id' in o && typeof o.task_id === 'number') assert.ok(o.task_id > 0, 'task_id 不得為負'); Object.values(o).forEach(scan); } };
    scan(pv.body);
  });

  test('A12 School Assignment deadline 於 strict apply 後仍完整保留', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const sa = await mkStandalone(u, list, { est: 60, kind: 'school_assignment', school_assignment_type: 'homework', deadline_date: D(4), deadline_time: '18:00' });
    const pv = await runRollingPreview(u, { plan_id: plan, add_task_ids: [sa] });
    await applyFromPreview(u, plan, pv);
    const a = await q.get('SELECT plan_id,deadline_date,deadline_time FROM tasks WHERE id=?', [sa]);
    assert.equal(Number(a.plan_id), Number(plan));
    assert.equal(a.deadline_date, D(4));
    assert.equal(a.deadline_time, '18:00');
  });
});

/* ===== Phase 2 audit round 2：hasAdditions 正整數、strict block identity、material stale ===== */
describe('Phase 2 audit r2. hasAdditions / block identity / material stale', () => {
  const strictApply = (u, planId, o) => sched.applySchedule(u, {
    planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0), enforceDeadlines: true, rollingStrict: true, ...o,
  });

  test('B1 hasAdditions：trigger_task_id 只有合法正整數才算新增（draft 無新增仍可用）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u, 'draft'); const list = await mkList(u);
    const pt = await mkPlanTask(u, plan, list, { est: 60 });
    await seedVersion(u, [{ task_id: pt, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    // 非新增值：omitted / null / '' / 0 / '0' → draft rolling replan 仍可用（不被 attach 擋）。
    for (const v of [undefined, null, '', 0, '0']) {
      const body = { plan_id: plan };
      if (v !== undefined) body.trigger_task_id = v;
      const r = await runRollingPreview(u, body);
      assert.equal(r.status, 200, `trigger_task_id=${JSON.stringify(v)} 不應算新增`);
      assert.notEqual(r.body.code, 'PLAN_NOT_ACTIVE_FOR_ATTACH');
    }
    // 正整數 / 正整數字串 → 算新增 → draft 拒絕。
    for (const v of [pt, String(pt)]) {
      const r = await runRollingPreview(u, { plan_id: plan, trigger_task_id: v });
      assert.equal(r.body.code, 'PLAN_NOT_ACTIVE_FOR_ATTACH', `trigger_task_id=${v} 應算新增`);
    }
    // draft + 真正的 add / material 也一律拒絕。
    const t2 = await mkStandalone(u, list, { est: 60 });
    assert.equal((await runRollingPreview(u, { plan_id: plan, add_task_ids: [t2] })).body.code, 'PLAN_NOT_ACTIVE_FOR_ATTACH');
    const cidD = await mkMaterialItem(u, list, { est: 60 });
    assert.equal((await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cidD, client_key: 'x' }] })).body.code, 'PLAN_NOT_ACTIVE_FOR_ATTACH');
  });

  test('B2 strict block identity：ambiguous / missing / blank / unknown 一律拒絕且零寫入', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const t = await mkStandalone(u, list, { est: 60 });
    const cid = await mkMaterialItem(u, list, { est: 60 });
    // ambiguous：block 同時帶 task_id 與 client_key（不得讓 task_id 掩蓋未知 key）。
    await assert.rejects(() => strictApply(u, plan, {
      attachTaskIds: [t],
      blocks: [{ task_id: t, client_key: 'ghost', date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    }), e => e.code === 'BLOCK_AMBIGUOUS_IDENTITY');
    assert.equal((await q.get('SELECT plan_id FROM tasks WHERE id=?', [t])).plan_id, null, 'ambiguous → rollback');
    // missing：block 兩者都沒有。
    await assert.rejects(() => strictApply(u, plan, {
      blocks: [{ date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    }), e => e.code === 'BLOCK_MISSING_IDENTITY');
    // blank client_key。
    const before = await countTasks(u);
    const tkB2 = await tokenFor(u, plan, cid, 'm');
    await assert.rejects(() => strictApply(u, plan, {
      taskCreates: [{ client_key: 'm', material_content_item_id: cid, material_snapshot_token: tkB2 }],
      blocks: [{ client_key: '   ', date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    }), e => e.code === 'BLOCK_BLANK_CLIENT_KEY');
    // unknown key（無對應 task_create）。
    await assert.rejects(() => strictApply(u, plan, {
      blocks: [{ client_key: 'nope', date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    }), e => e.code === 'BLOCK_UNKNOWN_IDENTITY');
    assert.equal(await countTasks(u), before, '全程零寫入');
  });

  // 建一份 material selection 的 preview，回 { u, plan, list, cid, pv }。
  const setupMat = async (est = 90, title = '原標題') => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est, title });
    const pv = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm' }] });
    assert.equal(pv.status, 200);
    return { u, plan, list, cid, pv };
  };

  test('B3 material stale：estimate / title / subject / book 改變 → apply 拒絕且零寫入；未變 → 成功', async () => {
    // estimate 90→120
    { const { u, plan, cid, pv } = await setupMat();
      await q.run('UPDATE material_content_items SET estimated_minutes=120 WHERE id=? AND user_id=?', [cid, u]);
      const b = { t: await countTasks(u), p: await countPMI(u), v: await countVersions(u) };
      await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_STALE');
      assert.equal(await countTasks(u), b.t); assert.equal(await countPMI(u), b.p); assert.equal(await countVersions(u), b.v);
    }
    // title 改變
    { const { u, plan, cid, pv } = await setupMat();
      await q.run('UPDATE material_content_items SET title=? WHERE id=? AND user_id=?', ['新標題', cid, u]);
      await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_STALE');
    }
    // subject/list 改變（book.subject_list_id）
    { const { u, plan, cid, pv } = await setupMat();
      const other = await mkList(u, '別科');
      await q.run('UPDATE material_books SET subject_list_id=? WHERE id=(SELECT book_id FROM material_content_items WHERE id=?) AND user_id=?', [other, cid, u]);
      await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_STALE');
    }
    // book 改變（把 content item 移到另一本書）
    { const { u, plan, list, cid, pv } = await setupMat();
      const book2 = await mkBook(u, list);
      await q.run('UPDATE material_content_items SET book_id=? WHERE id=? AND user_id=?', [book2, cid, u]);
      await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_STALE');
    }
    // 完全未變 → 成功
    { const { u, plan, pv } = await setupMat();
      const res = await applyFromPreview(u, plan, pv);
      assert.ok(res.version_id, '未變更應正常成功');
    }
  });

  test('B3b block 分鐘對帳（token 與 CURRENT 皆一致，但 candidate block 分鐘被竄改）仍被擋下', async () => {
    const { u, plan, pv } = await setupMat(90);
    // material 完全未變 → token 與 CURRENT 一致（不觸發 token/CURRENT 比較）；但把 Material Task 的
    // candidate block 分鐘竄改成 30 分（<估時 90）。只有 block-minutes 對帳這層能擋——用來守住這層。
    pv.body.blocks = pv.body.blocks.map(b => (b.client_key ? { ...b, start_time: '19:00', end_time: '19:30', planned_minutes: 30 } : b));
    const b = { t: await countTasks(u), v: await countVersions(u) };
    await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_STALE');
    assert.equal(await countTasks(u), b.t, '零寫入'); assert.equal(await countVersions(u), b.v);
  });
});

/* ===== Phase 2 audit round 3：material_snapshot_token（HMAC 簽章、client 無法偽造）===== */
describe('Phase 2 audit r3. signed material snapshot token', () => {
  const strictApply = (u, planId, o) => sched.applySchedule(u, {
    planId, source: sched.SOURCE.AI_REPLAN, effectiveFrom: D(0), enforceDeadlines: true, rollingStrict: true, ...o,
  });

  test('C1 token 被竄改 / 缺失 / 綁定不符（content/client_key/plan/user/base）一律拒絕且零寫入', async () => {
    const u = nextUser(); await mkUser(u);
    const u2 = nextUser(); await mkUser(u2);
    const plan = await mkPlan(u); const plan2 = await mkPlan(u);
    const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est: 60 });
    const cid2 = await mkMaterialItem(u, list, { est: 60 });
    const mi = await q.get(
      `SELECT i.id,i.book_id,i.title,i.estimated_minutes,b.subject_list_id
         FROM material_content_items i LEFT JOIN material_books b ON b.id=i.book_id AND b.user_id=i.user_id
        WHERE i.id=? AND i.user_id=?`, [cid, u]);
    const base = { user_id: u, plan_id: plan, base_version_id: null, client_key: 'm', content_item_id: cid,
      title: mi.title, estimated_minutes: mi.estimated_minutes, material_book_id: mi.book_id, subject_list_id: mi.subject_list_id };
    const sign = over => signMaterialSnapshotToken({ ...base, ...over });
    const block = { client_key: 'm', date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 };
    const reject = async (tok, code) => {
      const b = { t: await countTasks(u), p: await countPMISel(u), v: await countVersions(u) };
      const tc = tok === undefined ? { client_key: 'm', material_content_item_id: cid }
        : { client_key: 'm', material_content_item_id: cid, material_snapshot_token: tok };
      await assert.rejects(() => strictApply(u, plan, { taskCreates: [tc], blocks: [block] }), e => e.code === code);
      assert.equal(await countTasks(u), b.t, '零 Task'); assert.equal(await countPMISel(u), b.p, '零 selection'); assert.equal(await countVersions(u), b.v, '零 version');
    };
    const good = sign({});
    await reject(good.slice(0, -1) + (good.slice(-1) === 'A' ? 'B' : 'A'), 'MATERIAL_TOKEN_INVALID'); // 竄改一字元
    await reject(undefined, 'MATERIAL_TOKEN_MISSING');                    // 缺 token
    await reject('not-a-token', 'MATERIAL_TOKEN_INVALID');               // 格式錯誤
    await reject(sign({ content_item_id: cid2 }), 'MATERIAL_STALE');     // 另一 content item 的 token
    await reject(sign({ client_key: 'other' }), 'MATERIAL_STALE');       // 另一 client_key
    await reject(sign({ plan_id: plan2 }), 'MATERIAL_STALE');            // 另一 Plan
    await reject(sign({ user_id: u2 }), 'MATERIAL_STALE');               // 另一 user
    await reject(sign({ base_version_id: 999999 }), 'MATERIAL_STALE');   // 另一 base version
  });

  test('C2 title / subject_list_id / material_book_id 改變後偽造普通 snapshot 仍拒絕（token 為準）', async () => {
    const mk = async () => {
      const u = nextUser(); await mkUser(u);
      const plan = await mkPlan(u); const list = await mkList(u);
      const cid = await mkMaterialItem(u, list, { est: 90, title: '原' });
      const pv = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm' }] });
      // 模擬 client 偽造普通 snapshot（apply 已不採信這個欄位，只認 token）。
      pv.body.task_creates = pv.body.task_creates.map(tc => ({ ...tc, material_snapshot: { content_item_id: cid, title: '任意', estimated_minutes: 999, material_book_id: 1, subject_list_id: 1 } }));
      return { u, plan, list, cid, pv };
    };
    { const { u, plan, cid, pv } = await mk();
      await q.run('UPDATE material_content_items SET title=? WHERE id=? AND user_id=?', ['新標題', cid, u]);
      await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_STALE'); }
    { const { u, plan, cid, pv } = await mk();
      const other = await mkList(u, '別科');
      await q.run('UPDATE material_books SET subject_list_id=? WHERE id=(SELECT book_id FROM material_content_items WHERE id=?) AND user_id=?', [other, cid, u]);
      await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_STALE'); }
    { const { u, plan, list, cid, pv } = await mk();
      const book2 = await mkBook(u, list);
      await q.run('UPDATE material_content_items SET book_id=? WHERE id=? AND user_id=?', [book2, cid, u]);
      await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_STALE'); }
  });

  test('C3 合法未修改 token → 正常成功', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est: 90 });
    const pv = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm' }] });
    const res = await applyFromPreview(u, plan, pv);
    assert.ok(res.version_id);
    assert.ok(await q.get('SELECT 1 FROM tasks WHERE user_id=? AND material_content_item_id=?', [u, cid]), '合法 token 應成功建立 Task');
  });

  test('C4 estimate 改變且企圖偽造 token（簽章失效）仍拒絕', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const cid = await mkMaterialItem(u, list, { est: 90 });
    const pv = await runRollingPreview(u, { plan_id: plan, material_selections: [{ content_item_id: cid, client_key: 'm' }] });
    await q.run('UPDATE material_content_items SET estimated_minutes=120 WHERE id=? AND user_id=?', [cid, u]);
    // client 想把 token 內估時改成 120——但它沒有 secret，任何竄改都讓簽章失效。
    pv.body.task_creates = pv.body.task_creates.map(tc => {
      const t = tc.material_snapshot_token;
      return { ...tc, material_snapshot_token: t.slice(0, -2) + (t.slice(-2) === 'AA' ? 'BB' : 'AA') };
    });
    const b = { t: await countTasks(u), v: await countVersions(u) };
    await assert.rejects(() => applyFromPreview(u, plan, pv), e => e.code === 'MATERIAL_TOKEN_INVALID');
    assert.equal(await countTasks(u), b.t); assert.equal(await countVersions(u), b.v);
  });
});
