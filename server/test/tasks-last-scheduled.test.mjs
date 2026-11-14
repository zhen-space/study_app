// 任務清單的逾期判定與拖曳改日期的 domain 邊界（HTTP 層）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { startServer, day } from './helpers.mjs';

test('GET /tasks 替「過去排過、active 版本已無安排」的未完成計畫任務附上最後安排日', async () => {
  const { base, H, stop, dbFile } = await startServer();
  const db = createClient({ url: 'file:' + dbFile });
  try {
    const userId = Number((await db.execute('SELECT id FROM users ORDER BY id DESC LIMIT 1')).rows[0].id);
    const plan = Number((await db.execute({ sql: "INSERT INTO plans (user_id,name,status) VALUES (?,?,'active')", args: [userId, '段考'] })).lastInsertRowid);
    const mk = async (title, extra = {}) => Number((await db.execute({
      sql: 'INSERT INTO tasks (user_id,title,plan_id,completed,due_date) VALUES (?,?,?,?,?)',
      args: [userId, title, extra.plan === false ? null : plan, extra.completed ? 1 : 0, extra.due_date ?? null],
    })).lastInsertRowid);
    const past = await mk('前天的進度');
    const todayPlan = await mk('今天排的進度');
    const done = await mk('已完成', { completed: true });
    const never = await mk('從沒排過');
    const general = await mk('一般任務', { plan: false });
    const version = async (no, blocks) => {
      const v = Number((await db.execute({
        sql: "INSERT INTO schedule_versions (user_id,version_no,source,effective_from,block_count) VALUES (?,?,'initial',?,?)",
        args: [userId, no, day(-3), blocks.length],
      })).lastInsertRowid);
      for (const [taskId, date] of blocks) {
        await db.execute({ sql: 'INSERT INTO scheduled_blocks (user_id,schedule_version_id,task_id,date) VALUES (?,?,?,?)', args: [userId, v, taskId, date] });
      }
      return v;
    };
    await version(1, [[past, day(-2)], [todayPlan, day(0)], [done, day(-2)]]);
    const active = await version(2, []);
    await db.execute({ sql: 'INSERT OR REPLACE INTO user_schedule_state (user_id,active_version_id) VALUES (?,?)', args: [userId, active] });

    const rows = await fetch(base + '/tasks', { headers: H }).then(r => r.json());
    const byId = id => rows.find(t => Number(t.id) === id);
    assert.equal(byId(past).last_scheduled_date, day(-2));
    assert.equal(byId(todayPlan).last_scheduled_date, day(0));
    assert.equal(byId(done).last_scheduled_date, undefined, '已完成不附');
    assert.equal(byId(never).last_scheduled_date, undefined);
    assert.equal(byId(general).last_scheduled_date, undefined);

    // 拖曳 domain：計畫任務的日期不能用 generic PATCH 改。
    const planPatch = await fetch(`${base}/tasks/${past}`, { method: 'PATCH', headers: H, body: JSON.stringify({ due_date: day(1), due_time: null }) });
    assert.equal(planPatch.status, 409);
    // 一般任務只改 due_date／due_time，其他欄位不變。
    await db.execute({ sql: "UPDATE tasks SET notes='筆記', priority=2, due_time='19:00' WHERE id=?", args: [general] });
    const ok = await fetch(`${base}/tasks/${general}`, { method: 'PATCH', headers: H, body: JSON.stringify({ due_date: day(1), due_time: '19:00' }) });
    assert.equal(ok.status, 200);
    const after = (await db.execute({ sql: 'SELECT title,notes,priority,due_date,due_time,completed FROM tasks WHERE id=?', args: [general] })).rows[0];
    assert.deepEqual({ ...after }, { title: '一般任務', notes: '筆記', priority: 2, due_date: day(1), due_time: '19:00', completed: 0 });
    assert.equal(Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM tasks WHERE user_id=?', args: [userId] })).rows[0].n), 5, '不建立新任務');
  } finally {
    db.close();
    await stop();
  }
});
