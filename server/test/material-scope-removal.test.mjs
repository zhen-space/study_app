import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'scope-remove-')), 'test.sqlite');
process.env.TURSO_DATABASE_URL = '';
process.env.JWT_SECRET = 'scope-removal-test-secret';

const { q, initSchema } = await import('../src/db/init.js');
const sched = await import('../src/schedule/persistence.js');
const { addDays, todayTW } = await import('../src/util/date.js');

let seq = 100;
async function fixture({ completed = false } = {}) {
  const user = ++seq;
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [user, `u${user}@test`, 'x']);
  const list = await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [user, '國文']);
  const plan = await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [user, '段考', 'active']);
  const book = await q.run('INSERT INTO material_books (user_id,title,subject_list_id) VALUES (?,?,?)', [user, '課本', list.lastInsertRowid]);
  const node = await q.run("INSERT INTO material_nodes (user_id,book_id,kind,title) VALUES (?,?,'chapter',?)", [user, book.lastInsertRowid, '第一章']);
  const item = await q.run("INSERT INTO material_content_items (user_id,book_id,node_id,kind,title) VALUES (?,?,?,'reading',?)", [user, book.lastInsertRowid, node.lastInsertRowid, '第一課']);
  const task = await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id,material_content_item_id,completed) VALUES (?,?,?,?,?,?)',
    [user, list.lastInsertRowid, '第一課', plan.lastInsertRowid, item.lastInsertRowid, completed ? 1 : 0]);
  await q.run('INSERT INTO plan_material_items (user_id,plan_id,content_item_id,selected,task_id) VALUES (?,?,?,?,?)',
    [user, plan.lastInsertRowid, item.lastInsertRowid, 1, task.lastInsertRowid]);
  await q.run('INSERT INTO material_progress (user_id,content_item_id,completed,source_task_id) VALUES (?,?,?,?)',
    [user, item.lastInsertRowid, completed ? 1 : 0, task.lastInsertRowid]);
  await q.run("INSERT INTO study_sessions (user_id,task_id,started_at,status,actual_minutes) VALUES (?,?,?,'completed',20)",
    [user, task.lastInsertRowid, '2026-09-01T10:00:00Z']);
  let version;
  if (completed) {
    version = await sched.createScheduleVersion(user, { source: sched.SOURCE.INITIAL, blocks: [] });
  } else {
    version = await sched.createScheduleVersion(user, { source: sched.SOURCE.INITIAL,
      blocks: [{ task_id: task.lastInsertRowid, date: addDays(todayTW(), 7) }] });
  }
  return { user, plan: plan.lastInsertRowid, item: item.lastInsertRowid, task: task.lastInsertRowid, version: version.version_id };
}

before(initSchema);

describe('安全移除段考教材範圍', () => {
  test('preview 零寫入；apply 原子取消選取與未完成任務、保留進度/Session/歷史並建立新版', async () => {
    const f = await fixture();
    const before = {
      versions: (await q.get('SELECT COUNT(*) c FROM schedule_versions WHERE user_id=?', [f.user])).c,
      sessions: (await q.get('SELECT COUNT(*) c FROM study_sessions WHERE user_id=?', [f.user])).c,
    };
    const preview = await sched.previewMaterialScopeRemoval(f.user, { planId: f.plan, contentItemId: f.item });
    assert.equal((await q.get('SELECT selected FROM plan_material_items WHERE user_id=?', [f.user])).selected, 1);
    assert.equal((await q.get('SELECT cancelled FROM tasks WHERE id=?', [f.task])).cancelled, 0);
    assert.equal((await q.get('SELECT COUNT(*) c FROM schedule_versions WHERE user_id=?', [f.user])).c, before.versions);
    const result = await sched.applyMaterialScopeRemoval(f.user, { planId: f.plan, contentItemId: f.item,
      baseVersionId: preview.base_version_id, token: preview.token });
    assert.equal((await q.get('SELECT selected FROM plan_material_items WHERE user_id=?', [f.user])).selected, 0);
    assert.equal((await q.get('SELECT cancelled FROM tasks WHERE id=?', [f.task])).cancelled, 1);
    assert.equal((await q.get('SELECT completed FROM material_progress WHERE user_id=?', [f.user])).completed, 0);
    assert.equal((await q.get('SELECT COUNT(*) c FROM study_sessions WHERE user_id=?', [f.user])).c, before.sessions);
    assert.equal((await q.get('SELECT COUNT(*) c FROM scheduled_blocks WHERE schedule_version_id=?', [f.version])).c, 1, '歷史版本不可修改');
    assert.notEqual(result.version.version_id, f.version);
  });

  test('已完成 linked Task 與完成進度保持不變', async () => {
    const f = await fixture({ completed: true });
    const preview = await sched.previewMaterialScopeRemoval(f.user, { planId: f.plan, contentItemId: f.item });
    assert.equal(preview.will_cancel_task, false);
    await sched.applyMaterialScopeRemoval(f.user, { planId: f.plan, contentItemId: f.item,
      baseVersionId: preview.base_version_id, token: preview.token });
    assert.deepEqual(await q.get('SELECT completed,cancelled FROM tasks WHERE id=?', [f.task]), { completed: 1, cancelled: 0 });
    assert.equal((await q.get('SELECT completed FROM material_progress WHERE user_id=?', [f.user])).completed, 1);
  });

  test('stale、跨使用者與 task lock fail closed', async () => {
    const stale = await fixture();
    const preview = await sched.previewMaterialScopeRemoval(stale.user, { planId: stale.plan, contentItemId: stale.item });
    await q.run('UPDATE tasks SET cancelled=1 WHERE id=?', [stale.task]);
    await assert.rejects(() => sched.applyMaterialScopeRemoval(stale.user, { planId: stale.plan, contentItemId: stale.item,
      baseVersionId: preview.base_version_id, token: preview.token }), e => e.code === 'MATERIAL_SCOPE_STALE');
    assert.equal((await q.get('SELECT selected FROM plan_material_items WHERE user_id=?', [stale.user])).selected, 1);
    const other = await fixture();
    await assert.rejects(() => sched.previewMaterialScopeRemoval(stale.user, { planId: other.plan, contentItemId: other.item }), e => e.status === 404);
    await q.run("INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,'task',?)", [other.user, other.task]);
    await assert.rejects(() => sched.previewMaterialScopeRemoval(other.user, { planId: other.plan, contentItemId: other.item }), e => e instanceof sched.ScheduleLockConflictError);
    assert.equal((await q.get('SELECT selected FROM plan_material_items WHERE user_id=?', [other.user])).selected, 1);
  });

  test('版本建立失敗時 selection 與 Task 一起 rollback', async () => {
    const f = await fixture();
    const preview = await sched.previewMaterialScopeRemoval(f.user, { planId: f.plan, contentItemId: f.item });
    await q.run(`CREATE TRIGGER fail_scope_version BEFORE INSERT ON schedule_versions
      WHEN NEW.reason LIKE '移除教材範圍%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    await assert.rejects(() => sched.applyMaterialScopeRemoval(f.user, { planId: f.plan, contentItemId: f.item,
      baseVersionId: preview.base_version_id, token: preview.token }), /injected failure/);
    await q.run('DROP TRIGGER fail_scope_version');
    assert.equal((await q.get('SELECT selected FROM plan_material_items WHERE user_id=?', [f.user])).selected, 1);
    assert.equal((await q.get('SELECT cancelled FROM tasks WHERE id=?', [f.task])).cancelled, 0);
    assert.equal(await sched.getActiveVersionId(f.user), f.version);
  });
});
