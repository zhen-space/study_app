// §13 Restore current-world overlay：舊版是「套在現在世界上的 placement template」。
// template 沒有、但目前 active schedule 有 placement 的 live Task，restore 後必須沿用
// 現在的 placement（而不是變 unplaced）；每一筆仍要通過現在的 deadline/lock/collision。
//
// 遠未來用 2099 sentinel（穩定）；freeze 相關用 todayTW() 相對日期（明天恆為未來）。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'restore-')), 'r.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const sched = await import('../src/schedule/persistence.js');
const { todayTW, addDays } = await import('../src/util/date.js');

const D = n => addDays(todayTW(), n);
let uid = 400; const nextUser = () => ++uid;

async function mkUser(id) { await q.run('INSERT INTO users (id,email,password_hash,sleep_start,sleep_end,meal_windows) VALUES (?,?,?,?,?,?)', [id, `r${id}@t`, 'x', '23:00', '07:00', '[]']); }
async function mkPlan(userId, status = 'active') { return (await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [userId, `p${userId}`, status])).lastInsertRowid; }
async function mkTask(userId, planId, o = {}) {
  return (await q.run('INSERT INTO tasks (user_id,title,plan_id,deadline_date,deadline_time) VALUES (?,?,?,?,?)',
    [userId, o.title || 'T', planId, o.deadline_date ?? null, o.deadline_time ?? null])).lastInsertRowid;
}
const ver = (userId, blocks, parent) => sched.createScheduleVersion(userId, { source: parent ? sched.SOURCE.AI_REPLAN : sched.SOURCE.INITIAL, effectiveFrom: '2099-01-01', parentVersionId: parent ?? null, blocks });

before(async () => { await initSchema(); });

describe('§13 Restore current-world overlay', () => {
  // A：source 不知道 X，current active 有 X placement → 沿用現在的 placement
  test('A. newer task 現在有 placement → restore carry current placement', async () => {
    const u = nextUser(); await mkUser(u); const plan = await mkPlan(u);
    const t1 = await mkTask(u, plan, { title: '原' });
    const src = await ver(u, [{ task_id: t1, date: '2099-02-01', start_time: '19:00', end_time: '20:00' }]);
    const x = await mkTask(u, plan, { title: '後加' });
    const cur = await ver(u, [
      { task_id: t1, date: '2099-02-05', start_time: '19:00', end_time: '20:00' },
      { task_id: x, date: '2099-02-07', start_time: '18:00', end_time: '19:00' },
    ], src.version_id);
    const p = await sched.getRestorePreview(u, src.version_id);
    assert.equal(p.base_version_id, cur.version_id);
    assert.deepEqual(p.unplaced_task_ids, [], 'X 不再 unplaced');
    assert.ok(p.restorable_blocks.some(b => Number(b.task_id) === x && b.date === '2099-02-07'), 'X 沿用現在的 placement');
    assert.ok(p.restorable_blocks.some(b => Number(b.task_id) === t1 && b.date === '2099-02-01'), 't1 走 template');
  });

  // B：source 不知道 X，current active 也沒有 X placement → X unplaced
  test('B. newer task 現在也沒 placement → 保持 unplaced', async () => {
    const u = nextUser(); await mkUser(u); const plan = await mkPlan(u);
    const t1 = await mkTask(u, plan);
    const src = await ver(u, [{ task_id: t1, date: '2099-03-01', start_time: '19:00', end_time: '20:00' }]);
    const x = await mkTask(u, plan, { title: '沒被排' });
    // current active 版本沒有 X 的 block
    await ver(u, [{ task_id: t1, date: '2099-03-02', start_time: '19:00', end_time: '20:00' }], src.version_id);
    const p = await sched.getRestorePreview(u, src.version_id);
    assert.deepEqual(p.unplaced_task_ids, [x], 'X 沒有現在 placement → unplaced');
    assert.ok(!p.restorable_blocks.some(b => Number(b.task_id) === x));
  });

  // C：newer task 現在 placement 違反現在 deadline → 不 carry 成合法 placement
  test('C. newer task 現在 placement 違反現在 deadline → 不 carry', async () => {
    const u = nextUser(); await mkUser(u); const plan = await mkPlan(u);
    const t1 = await mkTask(u, plan);
    const src = await ver(u, [{ task_id: t1, date: '2099-04-01', start_time: '19:00', end_time: '20:00' }]);
    const x = await mkTask(u, plan, { title: '超期', deadline_date: '2099-04-03' });
    await ver(u, [
      { task_id: t1, date: '2099-04-02', start_time: '19:00', end_time: '20:00' },
      { task_id: x, date: '2099-04-10', start_time: '18:00', end_time: '19:00' },   // 超過 deadline 2099-04-03
    ], src.version_id);
    const p = await sched.getRestorePreview(u, src.version_id);
    assert.ok(!p.restorable_blocks.some(b => Number(b.task_id) === x), '違反 deadline 的現在 placement 不得 carry');
    assert.ok(p.conflicts.some(c => Number(c.task_id) === x && c.type === 'deadline'), '記為 deadline 衝突');
  });

  // D：newer task 現在 placement 與 template block collision → 不 silent apply
  test('D. newer task 現在 placement 與 template 時段重疊 → 不 carry、記為衝突', async () => {
    const u = nextUser(); await mkUser(u); const plan = await mkPlan(u);
    const t1 = await mkTask(u, plan);
    const src = await ver(u, [{ task_id: t1, date: '2099-05-01', start_time: '19:00', end_time: '20:00' }]);
    const x = await mkTask(u, plan, { title: '撞時段' });
    await ver(u, [
      { task_id: t1, date: '2099-05-02', start_time: '19:00', end_time: '20:00' },
      { task_id: x, date: '2099-05-01', start_time: '19:30', end_time: '20:30' },   // 與 template t1 的 2099-05-01 19:00-20:00 重疊
    ], src.version_id);
    const p = await sched.getRestorePreview(u, src.version_id);
    assert.ok(!p.restorable_blocks.some(b => Number(b.task_id) === x), '撞 template 時段的現在 placement 不得 carry');
    assert.ok(p.conflicts.some(c => Number(c.task_id) === x && c.type === 'schedule_collision'));
  });

  // E：current completed / cancelled Task → 不得 carry
  test('E. completed / cancelled 的現在 placement 一律 exclude', async () => {
    const u = nextUser(); await mkUser(u); const plan = await mkPlan(u);
    const t1 = await mkTask(u, plan);
    const src = await ver(u, [{ task_id: t1, date: '2099-06-01', start_time: '19:00', end_time: '20:00' }]);
    const done = await mkTask(u, plan, { title: '已完成' });
    const cancelled = await mkTask(u, plan, { title: '已取消' });
    await ver(u, [
      { task_id: t1, date: '2099-06-02', start_time: '19:00', end_time: '20:00' },
      { task_id: done, date: '2099-06-05' }, { task_id: cancelled, date: '2099-06-06' },
    ], src.version_id);
    await q.run('UPDATE tasks SET completed=1 WHERE id=?', [done]);
    await q.run('UPDATE tasks SET cancelled=1 WHERE id=?', [cancelled]);
    const p = await sched.getRestorePreview(u, src.version_id);
    assert.ok(!p.restorable_blocks.some(b => [done, cancelled].includes(Number(b.task_id))), '已結束 Task 不得 carry');
    assert.ok(!p.unplaced_task_ids.includes(done) && !p.unplaced_task_ids.includes(cancelled), '也不列 unplaced');
  });

  // F：Rolling Freeze —— 現在 active 的 newer Task 落在明天（freeze 窗）→ restore 不得因舊版缺它而移除
  test('F. freeze：明天的 newer placement 不因 restore 被移除', async () => {
    const u = nextUser(); await mkUser(u); const plan = await mkPlan(u);
    const t1 = await mkTask(u, plan);
    const src = await ver(u, [{ task_id: t1, date: '2099-07-01', start_time: '19:00', end_time: '20:00' }]);
    const x = await mkTask(u, plan, { title: '明天既定' });
    await ver(u, [
      { task_id: t1, date: '2099-07-02', start_time: '19:00', end_time: '20:00' },
      { task_id: x, date: D(1), start_time: '19:00', end_time: '20:00' },   // 明天（freeze 窗內）
    ], src.version_id);
    const p = await sched.getRestorePreview(u, src.version_id);
    assert.ok(p.restorable_blocks.some(b => Number(b.task_id) === x && b.date === D(1)), '明天的既定安排必須被 carry，不得移除');
  });

  // G：restore 不 rollback Material / StudySession / Task lifecycle / Plan lifecycle
  test('G. restore 不動 Material / StudySession / Task / Plan 狀態', async () => {
    const u = nextUser(); await mkUser(u); const plan = await mkPlan(u);
    const t1 = await mkTask(u, plan);
    const src = await ver(u, [{ task_id: t1, date: '2099-08-01', start_time: '19:00', end_time: '20:00' }]);
    const x = await mkTask(u, plan);
    const cur = await ver(u, [
      { task_id: t1, date: '2099-08-02', start_time: '19:00', end_time: '20:00' },
      { task_id: x, date: '2099-08-05' },
    ], src.version_id);
    const mp = (await q.get('SELECT COUNT(*) c FROM material_progress WHERE user_id=?', [u])).c;
    const ss = (await q.get('SELECT COUNT(*) c FROM study_sessions WHERE user_id=?', [u])).c;
    const planStatus = (await q.get('SELECT status FROM plans WHERE id=?', [plan])).status;
    await sched.applyRestore(u, src.version_id, { baseVersionId: cur.version_id });
    assert.equal((await q.get('SELECT COUNT(*) c FROM material_progress WHERE user_id=?', [u])).c, mp);
    assert.equal((await q.get('SELECT COUNT(*) c FROM study_sessions WHERE user_id=?', [u])).c, ss);
    assert.equal((await q.get('SELECT status FROM plans WHERE id=?', [plan])).status, planStatus);
    assert.equal((await q.get('SELECT completed,cancelled,deleted FROM tasks WHERE id=?', [x])).completed, 0);
  });
});
