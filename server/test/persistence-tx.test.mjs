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

const { q, initSchema } = await import('../src/db/init.js');
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
        { task_id: taskA, date: '2026-09-10', start_time: '19:00' },
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
