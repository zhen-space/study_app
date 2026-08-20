// live StudySession partial unique index 的 schema migration。
//
// 這條防線原本只由 operator script 手動建立，等於每個環境各自 opt-in。
// 納入 initSchema() 之後要同時守住兩件事：
//   1. 乾淨的資料庫開機後就有 index，並且真的擋得住第二筆 live session
//   2. 已經有重複 live session 的資料庫不會因此開不起來，也不會被偷偷改資料

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'ssidx-')), 'x.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema, ensureStudySessionLiveIndex } = await import('../src/db/init.js');

const indexSql = async () => (await q.get(
  "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_study_sessions_one_live'"))?.sql ?? null;

let uid = 0;
const taskOf = new Map();
const newUser = async () => {
  const u = ++uid;
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [u, `u${u}@t`, 'x']);
  const t = await q.run('INSERT INTO tasks (user_id,title) VALUES (?,?)', [u, `t${u}`]);
  taskOf.set(u, Number(t.lastInsertRowid));
  return u;
};
const session = (user, status) => q.run(
  'INSERT INTO study_sessions (user_id,task_id,status,started_at) VALUES (?,?,?,?)',
  [user, taskOf.get(user), status, new Date().toISOString()]);
const live = (user, status = 'running') => session(user, status);

before(async () => { await initSchema(); });

describe('idx_study_sessions_one_live', () => {
  test('乾淨資料庫開機後 index 就存在，定義與 operator script 一致', async () => {
    const sql = await indexSql();
    assert.ok(sql, 'initSchema() 之後應該已經建立 index');
    assert.match(sql, /CREATE UNIQUE INDEX/i);
    assert.match(sql, /study_sessions\s*\(\s*user_id\s*\)/i);
    assert.match(sql, /WHERE\s+status IN \('running','paused'\)/i);
  });

  test('同一個使用者的第二筆未結束計時會被 DB 擋下', async () => {
    const u = await newUser();
    await live(u, 'running');
    await assert.rejects(() => live(u, 'paused'), /UNIQUE|constraint/i);
  });

  test('已結束的計時不受限制，可以有很多筆', async () => {
    const u = await newUser();
    await session(u, 'completed');
    await session(u, 'completed');
    await live(u, 'running');
    const n = await q.get('SELECT COUNT(*) c FROM study_sessions WHERE user_id=?', [u]);
    assert.equal(n.c, 3);
  });

  test('不同使用者各自可以有一筆未結束計時', async () => {
    const a = await newUser(); const b = await newUser();
    await live(a); await live(b);
    const n = await q.get(
      "SELECT COUNT(*) c FROM study_sessions WHERE status IN ('running','paused') AND user_id IN (?,?)", [a, b]);
    assert.equal(n.c, 2);
  });

  test('重複 live session 時：不建 index、不修改任何資料、不讓開機失敗', async () => {
    // 直接把 index 拿掉來模擬「remediation 前的舊資料庫」，再塞入重複資料。
    await q.run('DROP INDEX IF EXISTS idx_study_sessions_one_live');
    const u = await newUser();
    await live(u, 'running');
    await live(u, 'paused');
    const before = await q.get('SELECT COUNT(*) c FROM study_sessions');

    const r = await ensureStudySessionLiveIndex();
    assert.equal(r.status, 'blocked');
    assert.equal(r.duplicate_users, 1);
    assert.equal(await indexSql(), null, '有重複時不得建立 index');

    const after = await q.get('SELECT COUNT(*) c FROM study_sessions');
    assert.equal(after.c, before.c, '不得刪除或結束任何既有 session');
    const stillLive = await q.get(
      "SELECT COUNT(*) c FROM study_sessions WHERE user_id=? AND status IN ('running','paused')", [u]);
    assert.equal(stillLive.c, 2, '絕不自動取消／結束舊 session');

    // 重跑 initSchema() 也不能因此丟例外——開機要活下來。
    await initSchema();
    assert.equal(await indexSql(), null);
  });

  test('清掉重複之後，下一次開機會自動補上 index', async () => {
    await q.run("UPDATE study_sessions SET status='completed' WHERE status='paused'");
    const r = await ensureStudySessionLiveIndex();
    assert.equal(r.status, 'ok');
    assert.ok(await indexSql());
    // 可重跑：已經存在時是 no-op，不會丟錯
    assert.equal((await ensureStudySessionLiveIndex()).status, 'ok');
  });
});
