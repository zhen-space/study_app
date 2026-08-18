// Phase 2C-P1：交易邊界與版本號併發。
//
// 這一支直接呼叫 persistence service（不走 HTTP），因為要**故意讓中途失敗**
// 才驗得到 rollback。契約 §7.1：絕不能留下 version 沒 blocks、blocks 寫一半、
// active 指到半套版本、或 mirror 跟 active 不一致。

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'tx-')), 'tx.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema, repairScheduledBlockTiming } = await import('../src/db/init.js');
const sched = await import('../src/schedule/persistence.js');

const USER = 1;
let planId, taskA, taskB;
let looseTask, deletedTask, completedTask, otherUserTask;

before(async () => {
  await initSchema();
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER, 'tx@test', 'x']);
  const l = await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [USER, '數學']);
  const p = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [USER, '計畫', 'active']);
  planId = p.lastInsertRowid;
  const a = await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id) VALUES (?,?,?,?)',
    [USER, l.lastInsertRowid, '任務A', planId]);
  const b = await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id) VALUES (?,?,?,?)',
    [USER, l.lastInsertRowid, '任務B', planId]);
  taskA = a.lastInsertRowid; taskB = b.lastInsertRowid;
  const loose = await q.run('INSERT INTO tasks (user_id,title) VALUES (?,?)', [USER, '一般待辦']);
  looseTask = loose.lastInsertRowid;
  const deleted = await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,deleted) VALUES (?,?,?,?,1)',
    [USER, l.lastInsertRowid, '已刪除任務', planId]);
  deletedTask = deleted.lastInsertRowid;
  const completed = await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,completed) VALUES (?,?,?,?,1)',
    [USER, l.lastInsertRowid, '已完成任務', planId]);
  completedTask = completed.lastInsertRowid;
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [2, 'other@test', 'x']);
  const other = await q.run('INSERT INTO tasks (user_id,title,plan_id) VALUES (?,?,?)', [2, '別人的任務', planId]);
  otherUserTask = other.lastInsertRowid;
});

const counts = async () => ({
  versions: (await q.get('SELECT COUNT(*) c FROM schedule_versions'))?.c,
  blocks: (await q.get('SELECT COUNT(*) c FROM scheduled_blocks'))?.c,
  activeId: await sched.getActiveVersionId(USER),
});

// 直接 INSERT 是刻意的：這些是 PR #23 之前已落庫的 ScheduledBlock shape，不能
// 假裝它們會經過新的 write gate。每個 user 獨立，讓 legacy runtime 測試互不干擾。
async function seedLegacyVersion(userId, shapes) {
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, `legacy${userId}@test`, 'x']);
  const plan = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, `legacy ${userId}`, 'active']);
  const tasks = [];
  for (const shape of shapes) {
    const task = await q.run('INSERT INTO tasks (user_id,title,plan_id,estimated_minutes) VALUES (?,?,?,?)',
      [userId, shape.title || 'legacy task', plan.lastInsertRowid, shape.estimated_minutes || null]);
    tasks.push(task.lastInsertRowid);
  }
  const version = await q.run(`INSERT INTO schedule_versions (user_id,version_no,source,effective_from,block_count)
    VALUES (?,?,?,?,?)`, [userId, 1, 'initial', '2026-09-01', shapes.length]);
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    await q.run(`INSERT INTO scheduled_blocks (user_id,schedule_version_id,task_id,date,start_time,end_time,planned_minutes)
      VALUES (?,?,?,?,?,?,?)`, [userId, version.lastInsertRowid, tasks[i], s.date || '2026-09-10',
      s.start_time ?? null, s.end_time ?? null, s.planned_minutes ?? null]);
  }
  await q.run('INSERT INTO user_schedule_state (user_id,active_version_id) VALUES (?,?)', [userId, version.lastInsertRowid]);
  const blocks = await q.all('SELECT * FROM scheduled_blocks WHERE schedule_version_id=? ORDER BY id', [version.lastInsertRowid]);
  return { planId: plan.lastInsertRowid, taskIds: tasks, versionId: version.lastInsertRowid, blocks };
}

describe('Round-3：pre-PR ScheduledBlock canonical repair 與 runtime 相容', () => {
  test('Class B Task Lock baseline 與 manual candidate 同形，不移動 locked block 也不會假衝突', async () => {
    const legacy = await seedLegacyVersion(31, [
      { title: 'Class B 鎖定', date: '2026-09-10', start_time: '19:00', end_time: '20:00', planned_minutes: null },
      { title: '要手動搬動', date: '2026-09-11', start_time: '14:00', end_time: '15:00', planned_minutes: 60 },
    ]);
    await q.run(`INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,?,?)`, [31, 'task', legacy.taskIds[0]]);
    const result = await sched.applyManualAdjustment(31, {
      baseVersionId: legacy.versionId,
      moves: [{ block_id: legacy.blocks[1].id, date: '2026-09-12', start_time: '15:00', end_time: '16:00' }],
    });
    assert.equal(result.ok, true, '移除 Lock baseline canonicalization 後此處會誤報 LOCKED_TASK_MOVED');
    const active = await sched.getActiveSchedule(31);
    const locked = active.blocks.find(b => b.task_id === legacy.taskIds[0]);
    assert.deepEqual([locked.start_time, locked.end_time, locked.planned_minutes], ['19:00', '20:00', 60]);
  });

  test('Class B 沒有 Lock 時仍可走完整 manual API path，且新版本帶回真實分鐘數', async () => {
    const legacy = await seedLegacyVersion(32, [
      { title: 'Class B', date: '2026-09-10', start_time: '18:00', end_time: '19:30', planned_minutes: null },
      { title: '要搬', date: '2026-09-11' },
    ]);
    const result = await sched.applyManualAdjustment(32, {
      baseVersionId: legacy.versionId, moves: [{ block_id: legacy.blocks[1].id, date: '2026-09-13' }],
    });
    assert.equal(result.ok, true);
    const active = await sched.getActiveSchedule(32);
    assert.equal(active.blocks.find(b => b.task_id === legacy.taskIds[0]).planned_minutes, 90);
  });

  test('Class A half-timed row 在 manual dry-run / apply 保守降成 date-only，不 poison 整份排程', async () => {
    const legacy = await seedLegacyVersion(33, [
      { title: 'Class A', date: '2026-09-10', start_time: '19:00', end_time: null, planned_minutes: null },
      { title: '正常任務', date: '2026-09-11' },
    ]);
    const move = { block_id: legacy.blocks[1].id, date: '2026-09-12' };
    const dry = await sched.applyManualAdjustment(33, { baseVersionId: legacy.versionId, moves: [move], dryRun: true });
    assert.equal(dry.ok, true);
    assert.deepEqual([dry.blocks[0].start_time, dry.blocks[0].end_time, dry.blocks[0].planned_minutes], [null, null, null]);
    assert.equal((await sched.applyManualAdjustment(33, { baseVersionId: legacy.versionId, moves: [move] })).ok, true);
  });

  test('stored-data repair backfill Class B、demote Class A/invalid，重跑不 double count', async () => {
    const legacy = await seedLegacyVersion(34, [
      { title: 'Class B repair', start_time: '18:30', end_time: '20:00', planned_minutes: null },
      { title: 'Class A repair', start_time: '21:00', end_time: null, planned_minutes: null },
      { title: 'invalid repair', start_time: '20:00', end_time: '19:00', planned_minutes: null },
    ]);
    const first = await repairScheduledBlockTiming();
    assert.ok(first.backfilled >= 1 && first.demoted >= 2,
      '移除 Class-B backfill 或 Class-A demote 後此 mutation guard 必紅');
    const rows = await q.all('SELECT start_time,end_time,planned_minutes FROM scheduled_blocks WHERE schedule_version_id=? ORDER BY id', [legacy.versionId]);
    assert.deepEqual(rows, [
      { start_time: '18:30', end_time: '20:00', planned_minutes: 90 },
      { start_time: null, end_time: null, planned_minutes: null },
      { start_time: null, end_time: null, planned_minutes: null },
    ]);
    assert.deepEqual(await repairScheduledBlockTiming(), { backfilled: 0, demoted: 0 }, 'repair 必須 idempotent，不能重複加分鐘');
  });
});

describe('交易邊界：全有或全無', () => {
  test('非法 block task 一律拒絕，且 version、block、active、mirror 全部不變', async () => {
    const before = await counts();
    const dueBefore = await q.get('SELECT due_date FROM tasks WHERE id=?', [taskA]);
    for (const taskId of [999999, otherUserTask, looseTask, deletedTask, completedTask]) {
      await assert.rejects(() => sched.createScheduleVersion(USER, {
        source: sched.SOURCE.MANUAL,
        blocks: [{ task_id: taskA, date: '2026-09-01' }, { task_id: taskId, date: '2026-09-02' }],
      }), /排程任務/);
      assert.deepEqual(await counts(), before, `task ${taskId} 不得留下半套 version`);
      assert.equal((await q.get('SELECT due_date FROM tasks WHERE id=?', [taskA])).due_date, dueBefore.due_date,
        '失敗不得改動既有 due mirror');
    }
  });

  test('blocks 寫到一半失敗 → 版本、blocks、active、mirror 全部回滾', async () => {
    const v1 = await sched.createScheduleVersion(USER, {
      source: sched.SOURCE.MANUAL, effectiveFrom: '2026-09-01',
      blocks: [{ task_id: taskA, date: '2026-09-02' }],
    });
    const good = await counts();
    assert.equal(good.activeId, v1.version_id);

    // 第二個 block 的 date 是 NULL → NOT NULL 違反，在迴圈中途炸掉
    await assert.rejects(() => sched.createScheduleVersion(USER, {
      source: sched.SOURCE.AI_REPLAN, effectiveFrom: '2026-09-01',
      blocks: [
        { task_id: taskA, date: '2026-09-05' },
        { task_id: taskB, date: null },
      ],
    }));

    const after = await counts();
    assert.equal(after.versions, good.versions, '★ 失敗的版本不得留下 metadata');
    assert.equal(after.blocks, good.blocks, '★ 已經寫進去的 block 必須回滾');
    assert.equal(after.activeId, good.activeId, '★ active 不得指向半套版本');

    const t = await q.get('SELECT due_date FROM tasks WHERE id=?', [taskA]);
    assert.equal(t.due_date, '2026-09-02', '★ mirror 必須跟仍然生效的那一版一致');
  });

  test('成功的版本才會切 active，並同步 mirror', async () => {
    const v = await sched.createScheduleVersion(USER, {
      source: sched.SOURCE.AI_REPLAN, effectiveFrom: '2026-09-01',
      blocks: [
        { task_id: taskA, date: '2026-09-10', start_time: '19:00', end_time: '20:00' },
        { task_id: taskB, date: '2026-09-11' },
      ],
    });
    assert.equal(await sched.getActiveVersionId(USER), v.version_id);
    const a = await q.get('SELECT due_date, due_time FROM tasks WHERE id=?', [taskA]);
    assert.equal(a.due_date, '2026-09-10');
    assert.equal(a.due_time, '19:00');
  });

  test('舊版的 blocks 不因為新版建立而改變', async () => {
    const list = await sched.listVersions(USER);
    const oldest = list[list.length - 1];
    const blocks = await sched.getBlocks(USER, oldest.id);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].date, '2026-09-02', '★ immutable snapshot');
  });

  test('這一版沒有 block 的 Plan Task → due_date 清成 NULL', async () => {
    await sched.createScheduleVersion(USER, {
      source: sched.SOURCE.MANUAL, effectiveFrom: '2026-09-01',
      blocks: [{ task_id: taskA, date: '2026-09-20' }],
    });
    const b = await q.get('SELECT due_date, due_time FROM tasks WHERE id=?', [taskB]);
    assert.equal(b.due_date, null, '★ unplaced 是正式狀態，不得留著舊日期');
    assert.equal(b.due_time, null);
  });
});

describe('version_no 併發', () => {
  test('同時 bootstrap 最終只會有一份 V1，兩個 caller 都看同一個 active', async () => {
    const [a, b] = await Promise.all([
      sched.bootstrapScheduleIfNeeded(2, '2026-09-01'),
      sched.bootstrapScheduleIfNeeded(2, '2026-09-01'),
    ]);
    const active = await sched.getActiveVersionId(2);
    assert.ok(active, '必須建立 active version');
    assert.ok([a.version_id, b.version_id].includes(active), '兩個 caller 必須收斂到同一份 active');
    const versions = await q.all('SELECT id FROM schedule_versions WHERE user_id=? AND source=?', [2, 'bootstrap']);
    assert.equal(versions.length, 1, '★ bootstrap 不是 version_no retry，永遠只能有一份');
  });

  test('連續建立的版本號遞增且唯一', async () => {
    const before = (await sched.listVersions(USER))[0].version_no;
    await sched.createScheduleVersion(USER, { source: sched.SOURCE.MANUAL, blocks: [] });
    await sched.createScheduleVersion(USER, { source: sched.SOURCE.MANUAL, blocks: [] });
    const list = await sched.listVersions(USER);
    assert.equal(list[0].version_no, before + 2);
    const nos = list.map(v => v.version_no);
    assert.equal(new Set(nos).size, nos.length, '★ 版本號不得重複');
  });

  test('同時建立多個版本不會撞號（bounded retry 生效）', async () => {
    const n = 5;
    await Promise.all(Array.from({ length: n }, () =>
      sched.createScheduleVersion(USER, { source: sched.SOURCE.MANUAL, blocks: [] })));
    const list = await sched.listVersions(USER, 100);
    const nos = list.map(v => v.version_no);
    assert.equal(new Set(nos).size, nos.length, '★ 併發建立後版本號仍然唯一');
  });

  test('只有 version_no 衝突會重試，其他例外原樣往上拋', async () => {
    // task_id 不存在不會讓 block 插入失敗（沒有 FK 約束），
    // 但 date NOT NULL 會 —— 這種例外必須直接拋出，不得被 retry 吞掉
    let attempts = 0;
    const orig = q.tx.bind(q);
    q.tx = async fn => { attempts++; return orig(fn); };
    try {
      await assert.rejects(() => sched.createScheduleVersion(USER, {
        source: sched.SOURCE.MANUAL, blocks: [{ task_id: taskA, date: null }],
      }));
      assert.equal(attempts, 1, '★ 非版本號衝突不得重試');
    } finally { q.tx = orig; }
  });
});

describe('active version 沒有 fallback 推導', () => {
  test('user_schedule_state 被清掉時就是沒有 active，不會退回 MAX(version_no)', async () => {
    const had = await sched.getActiveVersionId(USER);
    assert.ok(had);
    await q.run('UPDATE user_schedule_state SET active_version_id=NULL WHERE user_id=?', [USER]);
    assert.equal(await sched.getActiveVersionId(USER), null,
      '★ 有版本存在也不代表有 active —— restore 之後最大號不等於生效中那一版');
    const s = await sched.getActiveSchedule(USER);
    assert.equal(s.active, false);
    await q.run('UPDATE user_schedule_state SET active_version_id=? WHERE user_id=?', [had, USER]);
  });
});

describe('P2 Wizard／Replan 套用交易', () => {
  test('新任務、ScheduledBlock、active 與 due mirror 只會一起成功', async () => {
    const userId = 3;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'p2@test', 'x']);
    const p = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, 'P2 計畫', 'active']);
    const r = await sched.applySchedule(userId, {
      planId: p.lastInsertRowid,
      source: sched.SOURCE.INITIAL,
      taskCreates: [{ client_key: 'new-a', title: '新任務' }],
      blocks: [{ client_key: 'new-a', date: '2026-09-15', start_time: '19:00', end_time: '20:00' }],
    });
    const taskId = r.created[0].id;
    const task = await q.get('SELECT due_date,due_time FROM tasks WHERE id=?', [taskId]);
    assert.equal(task.due_date, '2026-09-15');
    assert.equal(task.due_time, '19:00');
    assert.equal(await sched.getActiveVersionId(userId), r.version_id);

    const before = await countsFor(userId);
    await assert.rejects(() => sched.applySchedule(userId, {
      planId: p.lastInsertRowid,
      source: sched.SOURCE.AI_REPLAN,
      taskCreates: [{ client_key: 'rollback', title: '不該留下' }],
      blocks: [{ client_key: 'missing', date: '2026-09-16' }],
    }), /找不到對應任務/);
    assert.deepEqual(await countsFor(userId), before, '失敗不可留下 Task 或 version');
  });

  // 這是全域 snapshot 的 mutation guard：若移除 applySchedule 內的
  // carryForwardBlocks，Plan B 會從新版消失、due_date 被 mirror 清空，本測試必紅。
  test('重排 Plan A 必須完整保留 Plan B 的 active blocks 與 due mirror', async () => {
    const userId = 4;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'global@test', 'x']);
    const pa = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, 'Plan A', 'active']);
    const pb = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, 'Plan B', 'active']);

    const a1 = await sched.applySchedule(userId, {
      planId: pa.lastInsertRowid, source: sched.SOURCE.INITIAL,
      taskCreates: [{ client_key: 'a', title: 'A 任務' }],
      blocks: [{ client_key: 'a', date: '2026-09-10', start_time: '18:00', end_time: '19:00' }],
    });
    const aTask = a1.created[0].id;
    const b1 = await sched.applySchedule(userId, {
      planId: pb.lastInsertRowid, source: sched.SOURCE.INITIAL,
      taskCreates: [{ client_key: 'b', title: 'B 任務' }],
      blocks: [{ client_key: 'b', date: '2026-09-11', start_time: '19:00', end_time: '20:00' }],
    });
    const bTask = b1.created[0].id;
    const before = await sched.getVersionWithBlocks(userId, b1.version_id);

    const replan = await sched.applySchedule(userId, {
      planId: pa.lastInsertRowid, source: sched.SOURCE.AI_REPLAN,
      taskUpdates: [{ task_id: aTask, notes: '新版安排' }],
      blocks: [{ task_id: aTask, date: '2026-09-12', start_time: '20:00', end_time: '21:00' }],
    });
    const now = await sched.getVersionWithBlocks(userId, replan.version_id);
    assert.equal(now.version.parent_version_id, b1.version_id);
    assert.deepEqual(now.blocks.map(b => [b.task_id, b.date, b.start_time]), [
      [bTask, '2026-09-11', '19:00'],
      [aTask, '2026-09-12', '20:00'],
    ]);
    assert.equal((await q.get('SELECT due_date FROM tasks WHERE id=?', [bTask])).due_date, '2026-09-11',
      '★ Plan B 不能因為重排 A 被 mirror 清成 unplaced');
    assert.deepEqual((await sched.getVersionWithBlocks(userId, b1.version_id)).blocks, before.blocks,
      '★ 舊版必須 immutable');

    // mutation guard：若移除 apply 的 overlap validator，這筆會把 A 新 block 與
    // carry-forward 的 B block 一起寫進全域 version，測試必紅。
    const beforeCollision = await countsFor(userId);
    await assert.rejects(() => sched.applySchedule(userId, {
      planId: pa.lastInsertRowid, source: sched.SOURCE.AI_REPLAN,
      taskCreates: [{ client_key: 'collision', title: '撞時段任務' }],
      blocks: [{ client_key: 'collision', date: '2026-09-11', start_time: '19:00', end_time: '20:00' }],
    }), /時段重疊/);
    assert.deepEqual(await countsFor(userId), beforeCollision,
      '★ 撞時段時 Task、version、active 都必須 rollback');
    assert.equal((await q.get('SELECT due_date FROM tasks WHERE id=?', [bTask])).due_date, '2026-09-11',
      '★ rollback 後其他 Plan 的 mirror 不得改變');
  });

  test('同一天的兩個 untimed block 合法，不可誤判為時段重疊', async () => {
    const userId = 5;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'untimed@test', 'x']);
    const a = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, '未計時 A', 'active']);
    const b = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, '未計時 B', 'active']);
    await sched.applySchedule(userId, {
      planId: a.lastInsertRowid, source: sched.SOURCE.INITIAL,
      taskCreates: [{ client_key: 'a', title: 'A' }], blocks: [{ client_key: 'a', date: '2026-09-20' }],
    });
    const r = await sched.applySchedule(userId, {
      planId: b.lastInsertRowid, source: sched.SOURCE.INITIAL,
      taskCreates: [{ client_key: 'b', title: 'B' }], blocks: [{ client_key: 'b', date: '2026-09-20' }],
    });
    assert.equal(r.block_count, 2);
  });
});

async function countsFor(userId) {
  return {
    tasks: (await q.get('SELECT COUNT(*) c FROM tasks WHERE user_id=?', [userId])).c,
    versions: (await q.get('SELECT COUNT(*) c FROM schedule_versions WHERE user_id=?', [userId])).c,
    activeId: await sched.getActiveVersionId(userId),
  };
}

describe('P4 Lock integration：preview/apply/restore 共用 hard constraint', () => {
  test('Task Lock 移動或 unplaced 都 rollback；完成後暫停、取消完成後自動恢復', async () => {
    const userId = 10;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'lock@test', 'x']);
    const p = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, '鎖定計畫', 'active']);
    const first = await sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.INITIAL, taskCreates:[{client_key:'a',title:'鎖住'}], blocks:[{client_key:'a',date:'2099-08-01',start_time:'19:00',end_time:'20:00'}] });
    const taskId = first.created[0].id;
    await q.run("INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,?,?)", [userId,'task',taskId]);
    const before = await countsFor(userId);
    await assert.rejects(() => sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.AI_REPLAN, blocks:[{task_id:taskId,date:'2099-08-02',start_time:'19:00',end_time:'20:00'}] }), e => e.status===409 && /鎖定/.test(e.message));
    assert.deepEqual(await countsFor(userId), before, '★ locked move 必須整筆 rollback');
    await assert.rejects(() => sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.AI_REPLAN, blocks:[] }), e => e.status===409);
    await q.run('UPDATE tasks SET completed=1 WHERE id=?', [taskId]);
    const ok = await sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.AI_REPLAN, blocks:[] });
    assert.ok(ok.version_id, '完成的 Task Lock 不得卡住未來排程');
    await q.run('UPDATE tasks SET completed=0 WHERE id=?', [taskId]);
    await assert.rejects(() => sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.AI_REPLAN, blocks:[] }), e => e.status===409, '取消完成後同一列 lock 必須恢復效力');
    await q.run('UPDATE tasks SET deleted=1 WHERE id=?', [taskId]);
    await sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.AI_REPLAN, blocks:[] });
    await q.run('UPDATE tasks SET deleted=0 WHERE id=?', [taskId]);
    await assert.rejects(() => sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.AI_REPLAN, blocks:[] }), e => e.status===409, '恢復 soft-deleted Task 後同一列 lock 必須恢復效力');
    assert.equal((await q.get('SELECT released_at FROM schedule_locks WHERE task_id=?', [taskId])).released_at, null);
  });

  test('Time/Day Lock freeze 空白空間；restore 使用現在的 Lock', async () => {
    const userId = 11;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'slice@test', 'x']);
    const p = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, '空間鎖', 'active']);
    const seed = await sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.INITIAL, taskCreates:[{client_key:'a',title:'A'}], blocks:[{client_key:'a',date:'2099-09-01',start_time:'18:00',end_time:'19:00'}] });
    const taskId=seed.created[0].id;
    await q.run("INSERT INTO schedule_locks (user_id,type,date,start_time,end_time) VALUES (?,?,?,?,?)",[userId,'time','2099-09-01','19:00','20:00']);
    await q.run("INSERT INTO schedule_locks (user_id,type,date) VALUES (?,?,?)",[userId,'day','2099-09-02']);
    await q.run("INSERT INTO schedule_locks (user_id,type,date) VALUES (?,?,?)",[userId,'day','2099-09-01']);
    const before=await countsFor(userId);
    await assert.rejects(()=>sched.applySchedule(userId,{planId:p.lastInsertRowid,source:sched.SOURCE.AI_REPLAN,blocks:[{task_id:taskId,date:'2099-09-01',start_time:'19:00',end_time:'20:00'}]}),e=>e.status===409);
    await assert.rejects(()=>sched.applySchedule(userId,{planId:p.lastInsertRowid,source:sched.SOURCE.AI_REPLAN,blocks:[{task_id:taskId,date:'2099-09-02'}]}),e=>e.status===409);
    assert.deepEqual(await countsFor(userId),before,'★ slice/day conflict 不得留下 version');
    // 恢復「跟現在完全一樣的位置」不是變更，不可以報成違反鎖定。
    // （舊實作把整列 row 拿去 JSON 比對，restorable block 多帶 id／snapshot
    //  欄位就被判成 LOCKED_DAY_CHANGED——測試因此在錯誤的理由下通過。）
    const noop=await sched.getRestorePreview(userId,seed.version_id);
    assert.equal(noop.conflicts.filter(c=>String(c.type).startsWith('LOCKED_')).length,0,
      '★ 位置沒變就不該報鎖定衝突，不能靠欄位形狀差異誤判');

    // 真的違反鎖定的情境：把 A 搬到別的日子並鎖住那一天，
    // 這時恢復舊版會把 A 從鎖定的那天搬走，必須擋下來。
    await q.run("UPDATE schedule_locks SET released_at=CURRENT_TIMESTAMP WHERE user_id=? AND type='day' AND date='2099-09-01'",[userId]);
    await sched.applySchedule(userId,{planId:p.lastInsertRowid,source:sched.SOURCE.AI_REPLAN,blocks:[{task_id:taskId,date:'2099-09-05',start_time:'18:00',end_time:'19:00'}]});
    await q.run("INSERT INTO schedule_locks (user_id,type,date) VALUES (?,?,?)",[userId,'day','2099-09-05']);
    const preview=await sched.getRestorePreview(userId,seed.version_id);
    assert.ok(preview.conflicts.some(c=>String(c.type).startsWith('LOCKED_')),'restore 必須使用現在的 Lock');
  });

  // mutation guard：若 Restore 遇到 Task Lock 時只是丟掉 source block，
  // 這個測試會讓 Task 變 unplaced；正確行為是帶入目前 active 的鎖定 placement。
  test('Restore 遇到 Task Lock 時保留 active block set，不能把任務變 unplaced', async () => {
    const userId = 12;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'restore-lock@test', 'x']);
    const p = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, '恢復鎖定', 'active']);
    const source = await sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.INITIAL,
      taskCreates:[{client_key:'a',title:'A'}], blocks:[{client_key:'a',date:'2099-10-01',start_time:'18:00',end_time:'19:00'}] });
    const taskId = source.created[0].id;
    const active = await sched.applySchedule(userId, { planId:p.lastInsertRowid, source:sched.SOURCE.AI_REPLAN,
      blocks:[{task_id:taskId,date:'2099-10-01',start_time:'19:00',end_time:'20:00'}] });
    await q.run("INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,?,?)", [userId, 'task', taskId]);
    const preview = await sched.getRestorePreview(userId, source.version_id);
    assert.equal(preview.status, 'partial');
    assert.ok(preview.conflicts.some(c => c.type === 'LOCKED_TASK_MOVED'));
    assert.deepEqual(preview.restorable_blocks.map(b => [b.task_id,b.start_time,b.end_time]), [[taskId,'19:00','20:00']],
      '★ lock 使 restore 保留目前 active placement，而不是 unplaced');
    assert.deepEqual(preview.unplaced_task_ids, []);
    const restored = await sched.applyRestore(userId, source.version_id, { baseVersionId: active.version_id, confirmPartial:true });
    assert.equal(restored.applied, true);
    assert.deepEqual((await sched.getBlocks(userId, restored.version.version_id)).map(b => [b.task_id,b.start_time,b.end_time]), [[taskId,'19:00','20:00']]);
  });
});

describe('P3 Restore：版本是 template，套用永遠建立新版本', () => {
  test('full restore 建立新版本、保留舊版 immutable，且不在 template 的新 Task 變 unplaced', async () => {
    const userId = 6;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'restore-full@test', 'x']);
    const plan = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, '恢復計畫', 'active']);
    const task = await q.run('INSERT INTO tasks (user_id,title,plan_id) VALUES (?,?,?)', [userId, '原任務', plan.lastInsertRowid]);
    const original = await sched.createScheduleVersion(userId, {
      source: sched.SOURCE.INITIAL, effectiveFrom: '2099-01-01',
      blocks: [{ task_id: task.lastInsertRowid, date: '2099-02-01', start_time: '19:00', end_time: '20:00' }],
    });
    const later = await q.run('INSERT INTO tasks (user_id,title,plan_id,due_date) VALUES (?,?,?,?)',
      [userId, '後來新增', plan.lastInsertRowid, '2099-02-03']);
    const current = await sched.createScheduleVersion(userId, {
      source: sched.SOURCE.AI_REPLAN, effectiveFrom: '2099-01-01',
      parentVersionId: original.version_id,
      blocks: [{ task_id: task.lastInsertRowid, date: '2099-02-02', start_time: '19:00', end_time: '20:00' }, { task_id: later.lastInsertRowid, date: '2099-02-03' }],
    });
    const preview = await sched.getRestorePreview(userId, original.version_id);
    assert.equal(preview.status, 'full');
    assert.equal(preview.base_version_id, current.version_id);
    assert.deepEqual(preview.unplaced_task_ids, [later.lastInsertRowid]);
    const restored = await sched.applyRestore(userId, original.version_id, { baseVersionId: preview.base_version_id });
    assert.equal(restored.applied, true);
    const restoredVersion = await sched.getVersionWithBlocks(userId, restored.version.version_id);
    assert.equal(restoredVersion.version.source, 'restore');
    assert.equal(restoredVersion.version.parent_version_id, current.version_id);
    assert.equal(restoredVersion.version.restored_from_version_id, original.version_id);
    assert.deepEqual(restoredVersion.blocks.map(b => [b.task_id, b.date]), [[task.lastInsertRowid, '2099-02-01']]);
    assert.equal((await q.get('SELECT due_date FROM tasks WHERE id=?', [later.lastInsertRowid])).due_date, null,
      '★ template 內不存在的 live Plan Task 必須正式變 unplaced');
    assert.equal((await sched.getBlocks(userId, original.version_id))[0].date, '2099-02-01', '★ template 不可被修改');
  });

  test('partial restore 需要明確確認；固定行程衝突的任務留 unplaced', async () => {
    const userId = 7;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'restore-partial@test', 'x']);
    const plan = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, '部分恢復', 'active']);
    const a = await q.run('INSERT INTO tasks (user_id,title,plan_id) VALUES (?,?,?)', [userId, '可恢復', plan.lastInsertRowid]);
    const b = await q.run('INSERT INTO tasks (user_id,title,plan_id) VALUES (?,?,?)', [userId, '撞固定行程', plan.lastInsertRowid]);
    const source = await sched.createScheduleVersion(userId, { source: sched.SOURCE.INITIAL, effectiveFrom: '2099-01-01', blocks: [
      { task_id: a.lastInsertRowid, date: '2099-03-01', start_time: '18:00', end_time: '19:00' },
      { task_id: b.lastInsertRowid, date: '2099-03-01', start_time: '19:00', end_time: '20:00' },
    ] });
    const active = await sched.createScheduleVersion(userId, { source: sched.SOURCE.AI_REPLAN, effectiveFrom: '2099-01-01', parentVersionId: source.version_id, blocks: [] });
    await q.run('INSERT INTO fixed_events (user_id,title,date,start_time,end_time) VALUES (?,?,?,?,?)',
      [userId, '社團', '2099-03-01', '19:00', '20:00']);
    const preview = await sched.getRestorePreview(userId, source.version_id);
    assert.equal(preview.status, 'partial');
    assert.equal(preview.conflicts[0].type, 'fixed_event');
    const before = await countsFor(userId);
    await assert.rejects(() => sched.applyRestore(userId, source.version_id, { baseVersionId: active.version_id }), /確認/);
    assert.deepEqual(await countsFor(userId), before, '★ 未確認 partial 不得建立版本');
    const applied = await sched.applyRestore(userId, source.version_id, { baseVersionId: active.version_id, confirmPartial: true });
    assert.equal(applied.applied, true);
    assert.deepEqual((await sched.getBlocks(userId, applied.version.version_id)).map(b => b.task_id), [a.lastInsertRowid]);
    assert.equal((await q.get('SELECT due_date FROM tasks WHERE id=?', [b.lastInsertRowid])).due_date, null);
  });

  test('過期 preview 回 409，且不留下新版或 mirror 變動', async () => {
    const userId = 8;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'restore-stale@test', 'x']);
    const plan = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, '過期預覽', 'active']);
    const task = await q.run('INSERT INTO tasks (user_id,title,plan_id) VALUES (?,?,?)', [userId, '任務', plan.lastInsertRowid]);
    const source = await sched.createScheduleVersion(userId, { source: sched.SOURCE.INITIAL, effectiveFrom: '2099-01-01', blocks: [{ task_id: task.lastInsertRowid, date: '2099-04-01' }] });
    const preview = await sched.getRestorePreview(userId, source.version_id);
    await sched.createScheduleVersion(userId, { source: sched.SOURCE.MANUAL, effectiveFrom: '2099-01-01', parentVersionId: source.version_id, blocks: [{ task_id: task.lastInsertRowid, date: '2099-04-02' }] });
    const before = await countsFor(userId);
    await assert.rejects(() => sched.applyRestore(userId, source.version_id, { baseVersionId: preview.base_version_id }), err => err.status === 409);
    assert.deepEqual(await countsFor(userId), before, '★ stale 不得重試或另建 restore version');
    assert.equal((await q.get('SELECT due_date FROM tasks WHERE id=?', [task.lastInsertRowid])).due_date, '2099-04-02');
  });

  test('impossible 與 nothing_to_restore 都不建立新版本', async () => {
    const userId = 9;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'restore-none@test', 'x']);
    const plan = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, '無法恢復', 'active']);
    const past = await q.run('INSERT INTO tasks (user_id,title,plan_id) VALUES (?,?,?)', [userId, '過去任務', plan.lastInsertRowid]);
    const vPast = await sched.createScheduleVersion(userId, { source: sched.SOURCE.INITIAL, effectiveFrom: '2000-01-01', blocks: [{ task_id: past.lastInsertRowid, date: '2000-01-02' }] });
    const impossible = await sched.getRestorePreview(userId, vPast.version_id);
    assert.equal(impossible.status, 'impossible');
    const beforeImpossible = await countsFor(userId);
    assert.equal((await sched.applyRestore(userId, vPast.version_id, { baseVersionId: impossible.base_version_id })).applied, false);
    assert.deepEqual(await countsFor(userId), beforeImpossible);

    const future = await q.run('INSERT INTO tasks (user_id,title,plan_id) VALUES (?,?,?)', [userId, '已完成任務', plan.lastInsertRowid]);
    const vDone = await sched.createScheduleVersion(userId, { source: sched.SOURCE.MANUAL, effectiveFrom: '2099-01-01', blocks: [{ task_id: future.lastInsertRowid, date: '2099-05-01' }] });
    await q.run('UPDATE tasks SET completed=1 WHERE id=?', [future.lastInsertRowid]);
    const nothing = await sched.getRestorePreview(userId, vDone.version_id);
    assert.equal(nothing.status, 'nothing_to_restore');
    const beforeNothing = await countsFor(userId);
    assert.equal((await sched.applyRestore(userId, vDone.version_id, { baseVersionId: nothing.base_version_id })).applied, false);
    assert.deepEqual(await countsFor(userId), beforeNothing);
  });
});

describe('P5 歷史 diff：immutable version 即時計算', () => {
  test('child 對 parent 比較；restore 一律比較 restore 前 active，不比較 template', async () => {
    const userId = 13;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'diff@test', 'x']);
    const plan = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, 'Diff 計畫', 'active']);
    const task = await q.run('INSERT INTO tasks (user_id,title,plan_id) VALUES (?,?,?)', [userId, '變動任務', plan.lastInsertRowid]);
    const initial = await sched.createScheduleVersion(userId, {
      source: sched.SOURCE.INITIAL, effectiveFrom: '2099-01-01',
      blocks: [{ task_id: task.lastInsertRowid, date: '2099-01-10', start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    });
    const initialDiff = await sched.getVersionDiff(userId, initial.version_id);
    assert.equal(initialDiff.is_initial, true);
    assert.deepEqual(initialDiff.items, []);
    const moved = await sched.createScheduleVersion(userId, {
      source: sched.SOURCE.AI_REPLAN, effectiveFrom: '2099-01-01', parentVersionId: initial.version_id,
      blocks: [{ task_id: task.lastInsertRowid, date: '2099-01-11', start_time: '20:00', end_time: '21:00', planned_minutes: 60 }],
    });
    const movedDiff = await sched.getVersionDiff(userId, moved.version_id, { includeUnchanged: false });
    assert.equal(movedDiff.base_version_id, initial.version_id);
    assert.deepEqual(movedDiff.items.map(x => x.type), ['moved']);
    const restored = await sched.applyRestore(userId, initial.version_id, { baseVersionId: moved.version_id });
    const restoreDiff = await sched.getVersionDiff(userId, restored.version.version_id);
    assert.equal(restoreDiff.base_version_id, moved.version_id, '★ restore diff base 必須是 restore 前 active');
    assert.equal(restoreDiff.candidate_version_id, restored.version.version_id);
    assert.deepEqual(restoreDiff.items.map(x => x.type), ['moved']);
  });
});
