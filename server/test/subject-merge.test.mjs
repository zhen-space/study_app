import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { startServer } from './helpers.mjs';

let S, H, base, db, userId;
const api = async (path, method = 'GET', body) => {
  const r = await fetch(base + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  S = await startServer(); H = S.H; base = S.base;
  db = createClient({ url: 'file:' + S.dbFile });
  userId = Number((await db.execute('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0][0]);
});
after(async () => { db?.close(); await S?.stop(); });

describe('同名科目偵測與安全合併', () => {
  test('NFKC、大小寫與空白正規化；另建同名必須明確 opt-in', async () => {
    const first = await api('/lists', 'POST', { name: 'ＭＡＴＨ  A' });
    assert.equal(first.status, 200);
    const conflict = await api('/lists', 'POST', { name: ' math   a ' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'duplicate_subject_name');
    assert.equal(conflict.body.existing[0].id, first.body.id);
    const explicit = await api('/lists', 'POST', { name: 'math a', allow_duplicate: true });
    assert.equal(explicit.status, 200);
  });

  test('preview 零寫入；apply 原子轉移所有 refs、dedupe 並保留歷史', async () => {
    const target = (await api('/lists', 'POST', { name: '物理' })).body.id;
    const source = (await api('/lists', 'POST', { name: ' 物理 ', allow_duplicate: true })).body.id;
    const plan = (await api('/plans', 'POST', { name: '段考', primary_list_id: source, target_date: '2030-06-30' })).body.id;
    const task = (await api('/tasks', 'POST', { title: '作業', list_id: source, plan_id: plan, deadline_date: '2030-06-20', estimated_minutes: 45, task_kind: 'school_assignment', school_assignment_type: 'homework' })).body.id;
    const otherUser = Number((await db.execute({ sql: "INSERT INTO users (email,password_hash) VALUES (?,?)", args: ['share@test.local', 'x'] })).lastInsertRowid);
    await db.batch([
      { sql: 'INSERT INTO toc_items (user_id,list_id,title) VALUES (?,?,?)', args: [userId,source,'章'] },
      { sql: 'INSERT INTO material_books (user_id,title,subject_list_id) VALUES (?,?,?)', args: [userId,'講義',source] },
      { sql: 'INSERT INTO plan_progress_segments (user_id,plan_id,end_date,subject_list_id,title) VALUES (?,?,?,?,?)', args: [userId,plan,'2030-06-10',source,'進度'] },
      { sql: 'INSERT INTO plan_manual_scope (user_id,plan_id,subject_list_id,label,task_id) VALUES (?,?,?,?,?)', args: [userId,plan,source,'手寫範圍',task] },
      { sql: 'INSERT INTO plan_exam_subjects (user_id,plan_id,subject_list_id,exam_date,order_index) VALUES (?,?,?,?,?)', args: [userId,plan,target,'2030-06-25',3] },
      { sql: 'INSERT INTO plan_exam_subjects (user_id,plan_id,subject_list_id,exam_date,order_index) VALUES (?,?,?,?,?)', args: [userId,plan,source,'2030-06-20',1] },
      { sql: 'INSERT INTO list_shares (list_id,owner_id,member_id) VALUES (?,?,?)', args: [target,userId,otherUser] },
      { sql: 'INSERT INTO list_shares (list_id,owner_id,member_id) VALUES (?,?,?)', args: [source,userId,otherUser] },
      { sql: "INSERT INTO study_sessions (user_id,task_id,started_at,ended_at,status,actual_minutes) VALUES (?,?,?,?,?,?)", args: [userId,task,'2030-01-01T00:00:00Z','2030-01-01T00:30:00Z','completed',30] },
    ], 'write');

    const preview = await api('/lists/merge-preview', 'POST', { target_id: target, source_ids: [source] });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.counts.tasks, 1);
    assert.equal(preview.body.conflicts.exam_plans_deduplicated, 1);
    assert.equal(Number((await db.execute({ sql: 'SELECT list_id FROM tasks WHERE id=?', args: [task] })).rows[0][0]), source, 'preview 不得寫入');

    const merged = await api('/lists/merge', 'POST', { target_id: target, source_ids: [source], preview_fingerprint: preview.body.fingerprint });
    assert.equal(merged.status, 200);
    for (const [table, column] of [['tasks','list_id'],['toc_items','list_id'],['plans','primary_list_id'],['material_books','subject_list_id'],['plan_progress_segments','subject_list_id'],['plan_manual_scope','subject_list_id']]) {
      const rows = await db.execute({ sql: `SELECT ${column} FROM ${table} WHERE user_id=?`, args: [userId] });
      assert.ok(rows.rows.every(r => Number(r[0]) !== source), `${table} 不再引用來源科目`);
    }
    const exam = await db.execute({ sql: 'SELECT subject_list_id,exam_date,order_index FROM plan_exam_subjects WHERE user_id=? AND plan_id=?', args: [userId,plan] });
    assert.equal(exam.rows.length, 1);
    assert.deepEqual(
      [Number(exam.rows[0].subject_list_id), exam.rows[0].exam_date, Number(exam.rows[0].order_index)],
      [target, '2030-06-20', 1],
    );
    const shares = await db.execute({ sql: 'SELECT list_id FROM list_shares WHERE owner_id=? AND member_id=?', args: [userId,otherUser] });
    assert.deepEqual(shares.rows.map(r => Number(r[0])), [target]);
    const keptTask = await db.execute({ sql: 'SELECT completed,deadline_date FROM tasks WHERE id=?', args: [task] });
    assert.deepEqual(
      [Number(keptTask.rows[0].completed), keptTask.rows[0].deadline_date],
      [0, '2030-06-20'],
    );
    assert.equal((await db.execute({ sql: 'SELECT COUNT(*) FROM study_sessions WHERE task_id=?', args: [task] })).rows[0][0], 1);
  });

  test('ownership fail closed，stale preview 完全不套用', async () => {
    const a = (await api('/lists', 'POST', { name: '化學' })).body.id;
    const b = (await api('/lists', 'POST', { name: '化學', allow_duplicate: true })).body.id;
    const p = await api('/lists/merge-preview', 'POST', { target_id: a, source_ids: [b] });
    await api('/tasks', 'POST', { title: '預覽後新增', list_id: b });
    const stale = await api('/lists/merge', 'POST', { target_id: a, source_ids: [b], preview_fingerprint: p.body.fingerprint });
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'merge_preview_stale');
    assert.equal((await db.execute({ sql: 'SELECT COUNT(*) FROM lists WHERE id=?', args: [b] })).rows[0][0], 1);
    const foreign = Number((await db.execute({ sql: 'INSERT INTO lists (user_id,name) VALUES (?,?)', args: [999999,'化學'] })).lastInsertRowid);
    assert.equal((await api('/lists/merge-preview', 'POST', { target_id: a, source_ids: [foreign] })).status, 404);
  });
});
