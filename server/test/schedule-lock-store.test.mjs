import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'schedule-locks-')), 'test.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema, ensureScheduleLockLiveIndexes } = await import('../src/db/init.js');
const { createScheduleLock, releaseScheduleLock } = await import('../src/schedule/lock-store.js');

const USER = 1;
let taskId;

before(async () => {
  await initSchema();
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER, 'locks@test', 'x']);
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [2, 'other@test', 'x']);
  const plan = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [USER, 'Plan', 'active']);
  const task = await q.run('INSERT INTO tasks (user_id,title,plan_id,due_date) VALUES (?,?,?,?)',
    [USER, '排定任務', plan.lastInsertRowid, '2030-09-01']);
  taskId = Number(task.lastInsertRowid);
  const version = await q.run(
    'INSERT INTO schedule_versions (user_id,version_no,source,effective_from,block_count) VALUES (?,?,?,?,?)',
    [USER, 1, 'initial', '2030-08-01', 1]);
  await q.run('INSERT INTO scheduled_blocks (user_id,schedule_version_id,task_id,date,start_time,end_time,planned_minutes) VALUES (?,?,?,?,?,?,?)',
    [USER, version.lastInsertRowid, taskId, '2030-08-15', '19:00', '20:00', 60]);
  await q.run('INSERT INTO user_schedule_state (user_id,active_version_id) VALUES (?,?)',
    [USER, version.lastInsertRowid]);
});

describe('schedule lock idempotent store', () => {
  test('解除鎖定 owner-scoped 且冪等，保留 released history', async () => {
    const created = await createScheduleLock(USER, { type: 'day', date: '2030-08-18' });
    assert.deepEqual(await releaseScheduleLock(USER, created.lock.id), { ok: true, existing: false });
    const released = await q.get('SELECT released_at,release_reason FROM schedule_locks WHERE id=?', [created.lock.id]);
    assert.ok(released.released_at);
    assert.equal(released.release_reason, 'user');
    assert.deepEqual(await releaseScheduleLock(USER, created.lock.id), { ok: true, existing: true });
    await assert.rejects(() => releaseScheduleLock(2, created.lock.id), error => error.status === 404);
    await assert.rejects(() => releaseScheduleLock(USER, 987654321), error => error.status === 404);
    assert.deepEqual(await q.get('SELECT released_at,release_reason FROM schedule_locks WHERE id=?', [created.lock.id]), released);
  });

  test('task/day/time 重複建立都回傳同一筆 live lock', async () => {
    const cases = [
      { type: 'task', task_id: taskId },
      { type: 'day', date: '2030-08-20' },
      { type: 'time', date: '2030-08-21', start_time: '18:00', end_time: '19:00' },
    ];
    for (const body of cases) {
      const first = await createScheduleLock(USER, body);
      const again = await createScheduleLock(USER, body);
      assert.equal(first.created, true);
      assert.equal(again.created, false);
      assert.equal(again.lock.id, first.lock.id);
    }
    assert.equal((await q.get(
      'SELECT COUNT(*) c FROM schedule_locks WHERE user_id=? AND released_at IS NULL', [USER])).c, 3);
  });

  test('release 後可建立新 lock，且保留 released history', async () => {
    const first = await createScheduleLock(USER, { type: 'day', date: '2030-08-22' });
    await q.run("UPDATE schedule_locks SET released_at=CURRENT_TIMESTAMP,release_reason='user' WHERE id=? AND user_id=?",
      [first.lock.id, USER]);
    const next = await createScheduleLock(USER, { type: 'day', date: '2030-08-22' });
    assert.equal(next.created, true);
    assert.notEqual(next.lock.id, first.lock.id);
    const rows = await q.all("SELECT released_at,release_reason FROM schedule_locks WHERE user_id=? AND type='day' AND date=? ORDER BY id",
      [USER, '2030-08-22']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].release_reason, 'user');
    assert.equal(rows[1].released_at, null);
  });

  test('Task Lock 僅接受擁有且在自己 active schedule 的任務', async () => {
    await assert.rejects(
      () => createScheduleLock(2, { type: 'task', task_id: taskId }),
      error => error.status === 400 && /尚未排入時間/.test(error.message),
    );
    assert.equal((await q.get(
      'SELECT COUNT(*) c FROM schedule_locks WHERE user_id=2 AND released_at IS NULL')).c, 0);
  });

  test('拒絕非 canonical identity，不留下半套資料', async () => {
    for (const body of [
      { type: 'day', date: '2030-02-30' },
      { type: 'time', date: '2030-08-23', start_time: '20:00', end_time: '19:00' },
      { type: 'task', task_id: taskId, date: '2030-08-23' },
    ]) {
      await assert.rejects(() => createScheduleLock(USER, body), error => error.status === 400);
    }
    assert.equal((await q.get(
      "SELECT COUNT(*) c FROM schedule_locks WHERE user_id=? AND (date='2030-02-30' OR date='2030-08-23')",
      [USER])).c, 0);
  });
});

describe('schedule lock live identity migration', () => {
  test('保留最早 live row，後續重複只 soft-release，歷史列不改寫', async () => {
    await q.run('DROP INDEX idx_locks_task_one');
    await q.run('DROP INDEX idx_locks_day_one');
    await q.run('DROP INDEX idx_locks_time_one');
    const ids = [];
    for (const values of [
      [USER, 'day', null, '2031-01-01', null, null, null, null],
      [USER, 'day', null, '2031-01-01', null, null, null, null],
      [USER, 'time', null, '2031-01-02', '10:00', '11:00', null, null],
      [USER, 'time', null, '2031-01-02', '10:00', '11:00', null, null],
      [USER, 'task', 987654, null, null, null, null, null],
      [USER, 'task', 987654, null, null, null, null, null],
      [USER, 'day', null, '2031-01-01', null, null, '2029-01-01', 'user'],
    ]) {
      const row = await q.run('INSERT INTO schedule_locks (user_id,type,task_id,date,start_time,end_time,released_at,release_reason) VALUES (?,?,?,?,?,?,?,?)',
        values);
      ids.push(Number(row.lastInsertRowid));
    }

    const result = await ensureScheduleLockLiveIndexes();
    assert.equal(result.cleaned, 3);
    const rows = await q.all('SELECT id,released_at,release_reason FROM schedule_locks WHERE id>=? ORDER BY id',
      [ids[0]]);
    for (const offset of [0, 2, 4]) assert.equal(rows[offset].released_at, null);
    for (const offset of [1, 3, 5]) {
      assert.ok(rows[offset].released_at);
      assert.equal(rows[offset].release_reason, 'duplicate_cleanup');
    }
    assert.equal(rows[6].released_at, '2029-01-01');
    assert.equal(rows[6].release_reason, 'user');

    const indexes = await q.all(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_locks_%_one' ORDER BY name");
    assert.deepEqual(indexes.map(row => row.name), [
      'idx_locks_day_one',
      'idx_locks_task_one',
      'idx_locks_time_one',
    ]);
    await assert.rejects(() => q.run(
      "INSERT INTO schedule_locks (user_id,type,date) VALUES (?,'day',?)", [USER, '2031-01-01']),
    /unique/i);
    await assert.rejects(() => q.run(
      "INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,'task',?)", [USER, 987654]),
    /unique/i);
    await assert.rejects(() => q.run(
      "INSERT INTO schedule_locks (user_id,type,date,start_time,end_time) VALUES (?,'time',?,?,?)",
      [USER, '2031-01-02', '10:00', '11:00']),
    /unique/i);
    assert.equal((await ensureScheduleLockLiveIndexes()).cleaned, 0);
  });
});
