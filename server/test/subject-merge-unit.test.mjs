import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSubjectName, matchingSubjects, subjectMergeImpact, mergeSubjects } from '../src/subjects/merge.js';

const objectify = r => r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const wrap = client => ({
  all: async (sql, args = []) => objectify(await client.execute({ sql, args })),
  get: async (sql, args = []) => objectify(await client.execute({ sql, args }))[0],
  run: async (sql, args = []) => { const r = await client.execute({ sql, args }); return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid || 0) }; },
});

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'subject-merge-'));
  const file = path.join(dir, 'db.sqlite');
  const c = createClient({ url: 'file:' + file });
  for (const sql of [
    'CREATE TABLE lists(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,color TEXT,order_index INTEGER)',
    'CREATE TABLE tasks(id INTEGER PRIMARY KEY,user_id INTEGER,list_id INTEGER,completed INTEGER,deadline_date TEXT)',
    'CREATE TABLE toc_items(id INTEGER PRIMARY KEY,user_id INTEGER,list_id INTEGER)',
    'CREATE TABLE plans(id INTEGER PRIMARY KEY,user_id INTEGER,primary_list_id INTEGER)',
    'CREATE TABLE material_books(id INTEGER PRIMARY KEY,user_id INTEGER,subject_list_id INTEGER)',
    'CREATE TABLE plan_progress_segments(id INTEGER PRIMARY KEY,user_id INTEGER,subject_list_id INTEGER)',
    'CREATE TABLE plan_manual_scope(id INTEGER PRIMARY KEY,user_id INTEGER,subject_list_id INTEGER,task_id INTEGER)',
    'CREATE TABLE plan_exam_subjects(id INTEGER PRIMARY KEY,user_id INTEGER,plan_id INTEGER,subject_list_id INTEGER,exam_date TEXT,order_index INTEGER,updated_at TEXT)',
    'CREATE UNIQUE INDEX exam_one ON plan_exam_subjects(user_id,plan_id,subject_list_id)',
    'CREATE TABLE list_shares(id INTEGER PRIMARY KEY,list_id INTEGER,owner_id INTEGER,member_id INTEGER)',
    'CREATE TABLE study_sessions(id INTEGER PRIMARY KEY,user_id INTEGER,task_id INTEGER,actual_minutes INTEGER)',
  ]) await c.execute(sql);
  return { c, db: wrap(c), close: () => { c.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('subject normalization detects full-width, case and repeated whitespace', async () => {
  assert.equal(normalizeSubjectName(' ＭＡＴＨ   A '), normalizeSubjectName('math a'));
  const { c, db, close } = await fixture();
  await c.execute("INSERT INTO lists VALUES (1,7,'ＭＡＴＨ  A','#fff',0)");
  assert.deepEqual((await matchingSubjects(db, 7, ' math a ')).map(x => Number(x.id)), [1]);
  close();
});

test('preview is read-only; merge preserves task/history and moves every list reference', async () => {
  const { c, db, close } = await fixture();
  await c.batch([
    "INSERT INTO lists VALUES (1,7,'物理','#1',0)", "INSERT INTO lists VALUES (2,7,' 物理 ','#2',1)",
    "INSERT INTO tasks VALUES (10,7,2,0,'2030-06-20')", 'INSERT INTO study_sessions VALUES (20,7,10,30)',
    'INSERT INTO toc_items VALUES (30,7,2)', 'INSERT INTO plans VALUES (40,7,2)', 'INSERT INTO material_books VALUES (50,7,2)',
    'INSERT INTO plan_progress_segments VALUES (60,7,2)', 'INSERT INTO plan_manual_scope VALUES (70,7,2,10)',
    "INSERT INTO plan_exam_subjects VALUES (80,7,40,1,'2030-06-25',3,NULL)",
    "INSERT INTO plan_exam_subjects VALUES (81,7,40,2,'2030-06-20',1,NULL)",
    'INSERT INTO list_shares VALUES (90,1,7,8)', 'INSERT INTO list_shares VALUES (91,2,7,8)',
  ], 'write');
  const preview = await subjectMergeImpact(db, 7, 1, [2]);
  assert.equal(preview.counts.tasks, 1); assert.equal(preview.conflicts.exam_plans_deduplicated, 1);
  assert.equal((await db.get('SELECT list_id FROM tasks WHERE id=10')).list_id, 2);
  const t = await c.transaction('write'), tx = wrap(t);
  await mergeSubjects(tx, 7, 1, [2], preview.fingerprint); await t.commit();
  for (const [table, col] of [['tasks','list_id'],['toc_items','list_id'],['plans','primary_list_id'],['material_books','subject_list_id'],['plan_progress_segments','subject_list_id'],['plan_manual_scope','subject_list_id']])
    assert.equal(Number((await db.get(`SELECT ${col} AS value FROM ${table}`)).value), 1, table);
  assert.deepEqual(await db.get('SELECT subject_list_id,exam_date,order_index FROM plan_exam_subjects'), { subject_list_id: 1, exam_date: '2030-06-20', order_index: 1 });
  assert.equal((await db.all('SELECT * FROM list_shares')).length, 1);
  assert.equal((await db.get('SELECT actual_minutes FROM study_sessions WHERE task_id=10')).actual_minutes, 30);
  assert.deepEqual(await db.get('SELECT completed,deadline_date FROM tasks WHERE id=10'), { completed: 0, deadline_date: '2030-06-20' });
  close();
});

test('ownership and stale preview fail closed', async () => {
  const { c, db, close } = await fixture();
  await c.batch(["INSERT INTO lists VALUES (1,7,'化學','#1',0)", "INSERT INTO lists VALUES (2,7,'化學','#2',1)", "INSERT INTO lists VALUES (3,9,'化學','#3',0)"], 'write');
  await assert.rejects(() => subjectMergeImpact(db, 7, 1, [3]), /不屬於你/);
  const preview = await subjectMergeImpact(db, 7, 1, [2]);
  await c.execute('INSERT INTO tasks VALUES (10,7,2,0,NULL)');
  const t = await c.transaction('write'), tx = wrap(t);
  await assert.rejects(() => mergeSubjects(tx, 7, 1, [2], preview.fingerprint), /預覽後有變動/);
  await t.rollback();
  assert.ok(await db.get('SELECT id FROM lists WHERE id=2'));
  close();
});
