// 測試用的共用工具：開一台乾淨的伺服器（暫存資料庫）、註冊測試帳號、送排程請求
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allocateServerId,
  diagnosticFetch,
  logStopCompleted,
  logStopStarted,
  trackChild,
  trackDbClient,
  untrackDbClient,
} from './handle-diagnostics.mjs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 伺服器用「台灣時區的今天」當起點，早於今天的日期會被裁掉。
// 測試一律用相對日期，才不會過幾天就開始壞掉。
// 日期運算全部走 UTC（T00:00:00Z + setUTCDate），這樣不管跑測試的機器
// TZ 設成什麼（Asia/Taipei、UTC、America/New_York）結果都一樣。
export const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
export const day = n => {
  const d = new Date(today() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// 開一台只給這次測試用的伺服器：隨機埠、暫存 SQLite、跟正式/開發資料完全隔離。
// 起不來就換個埠再試（最多 3 次）——CI 上多個測試檔並行、每個檔又可能開好幾台，
// 隨機埠偶爾會撞在一起，撞到就整組 hook 掛掉。重試比擴大埠範圍可靠。
// env：讓需要特定環境變數的測試（例如 Google Calendar 的 client id、加密金鑰）
// 自己開一台帶著那些設定的伺服器，而不是污染全域 process.env。
export async function startServer({ env = {}, diagnostics = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await bootOnce(env, diagnostics); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function bootOnce(extraEnv = {}, diagnostics = false) {
  const instanceId = allocateServerId();
  const dir = mkdtempSync(path.join(tmpdir(), 'studyapp-test-'));
  const port = 3400 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: path.join(dir, 'test.sqlite'),
      JWT_SECRET: 'test-secret',
      INTERNAL_MIGRATION_TOKEN: 'test-internal-migration-token',
      TURSO_DATABASE_URL: '',        // 確保不會連到雲端資料庫
      TURSO_AUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',         // graceful degradation 的測試不可依賴外部環境
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(instanceId, proc, diagnostics);
  let childClosed = false;
  proc.once('close', () => { childClosed = true; });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  // 起不來時要看得出原因：退出碼與訊號都印出來，
  // 不然日誌只剩一行「API on :PORT」，根本查不下去
  const bail = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    return new Error(`伺服器啟動失敗（exit=${proc.exitCode} signal=${proc.signalCode} port=${port}）：\n${log}`);
  };

  const base = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw bail();
    try {
      const r = await diagnosticFetch(base + '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x@x', password: 'x' }),
      });
      if (r.status) break;                       // 有回應就代表起來了（401 也算）
    } catch { await new Promise(r => setTimeout(r, 100)); }
  }

  const email = `t${Date.now()}@test.local`;
  const reg = await diagnosticFetch(base + '/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: '12345678', name: '測試' }),
  });
  const { token } = await reg.json().catch(() => ({}));
  if (!token) { proc.kill('SIGKILL'); throw bail(); }
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  // 送一次排程，回傳 { blocks, check, unplaced }
  const plan = async (items, opts = {}) => {
    const r = await diagnosticFetch(base + '/schedule/preview', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        items,
        startDate: opts.startDate ?? day(0),
        endDate: opts.endDate ?? day(29),
        excludeWeekdays: [], excludeDates: [],
        timed: false, perDay: 0, pace: 'even',
        ...opts,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('排程失敗：' + JSON.stringify(j));
    return j;
  };

  let stopPromise;
  const stop = () => {
    if (!diagnostics) {
      proc.kill('SIGKILL');
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      return;
    }
    if (stopPromise) return stopPromise;
    logStopStarted(instanceId, proc, diagnostics);
    stopPromise = (async () => {
      await new Promise(resolve => {
        if (childClosed) return resolve();
        proc.once('close', resolve);
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      });
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      logStopCompleted(instanceId, proc, diagnostics);
    })();
    return stopPromise;
  };

  // 直接讀這台伺服器的 SQLite 檔。用途是驗「資料庫裡到底存了什麼」——
  // 例如 token 是不是真的以密文落地。走 API 看不到這一層。
  const dbFile = path.join(dir, 'test.sqlite');
  // 每次用完就把 client 關掉。留著不關會讓 node --test 的 event loop 一直有活的
  // handle，整個測試檔跑完卻不結束——症狀是 CI 上某個 TZ 的 job 卡住十幾分鐘，
  // 而同一個 commit 的其他 TZ job 七十秒就過了。用 withDb 包起來，
  // 之後新增的用法不會再忘記關。
  const withDb = async (fn) => {
    const { createClient } = await import('@libsql/client');
    const c = createClient({ url: 'file:' + dbFile });
    const clientId = trackDbClient(diagnostics);
    try { return await fn(c); } finally {
      try { c.close(); } catch {}
      untrackDbClient(clientId);
    }
  };
  const rawConnection = async (userId) => withDb(async c => {
    const r = await c.execute({ sql: 'SELECT * FROM google_calendar_connections WHERE user_id=?', args: [userId] });
    if (!r.rows[0]) return undefined;
    return Object.fromEntries(r.columns.map((col, i) => [col, r.rows[0][i]]));
  });
  const tableNames = async () => withDb(async c => {
    const r = await c.execute("SELECT name FROM sqlite_master WHERE type='table'");
    return r.rows.map(row => String(row[0]));
  });
  // 直接寫入一筆已連結的憑證。真的走一次 Google OAuth 在測試裡做不到，
  // 但「連結之後系統怎麼表現」才是要驗的東西，所以用伺服器自己的加密函式落地。
  const connectGoogle = async (userId, token) => withDb(async c => {
    const { encryptToken } = await import('../src/util/crypto.js');
    const key = Buffer.from(extraEnv.TOKEN_ENCRYPTION_KEY || '', 'base64');
    const now = new Date().toISOString();
    const expires = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
    await c.execute({
      sql: `INSERT INTO google_calendar_connections
        (user_id,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,scope,token_type,
         encryption_version,connected_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [userId,
        token.access_token ? encryptToken(token.access_token, key) : null,
        encryptToken(token.refresh_token, key),
        expires, 'https://www.googleapis.com/auth/calendar.freebusy', 'Bearer', 1, now, now],
    });
  });
  // 第二個帳號，用來驗使用者之間的隔離
  const secondUser = async () => {
    const email2 = `u2${Date.now()}@test.local`;
    const r = await diagnosticFetch(base + '/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email2, password: '12345678', name: '測試2' }),
    });
    const { token } = await r.json();
    return { H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } };
  };

  return { base, H, plan, stop, dbFile, log: () => log, rawConnection, tableNames, connectGoogle, secondUser };
}

/* ---------- 建立測試項目的小工具 ---------- */

// 一般的「節」（範例+例題）：可以一天排很多個
export const sec = (subject_id, title, o = {}) => ({
  subject_id, title, minutes: 60, spread: false,
  start: o.start ?? day(0), end: o.end ?? day(29), ...o,
});
// 純題目（單元練習／歷屆試題）：一天最多兩份，且不與「節」同日
export const pure = (subject_id, title, o = {}) => sec(subject_id, title, { onePerDay: true, ...o });
// 壓軸（模考等）：獨佔該科的一整天，排在該科所有一般項目之後
export const finalItem = (subject_id, title, o = {}) => sec(subject_id, title, { final: true, onePerDay: true, ...o });

// 一本書：units 章 × secsPer 節，每章再加上指定的純題目
export function book(subject_id, name, units, secsPer, pureKinds = [], o = {}) {
  const out = [];
  for (let c = 1; c <= units; c++) {
    for (let i = 1; i <= secsPer; i++) out.push(sec(subject_id, `${name}｜單元${c}｜節${i}｜範例+例題`, o));
    for (const k of pureKinds) out.push(pure(subject_id, `${name}｜單元${c}｜${k}`, o));
  }
  return out;
}

/* ---------- 判讀 blocks 的小工具 ---------- */

// blocks 不會帶回內部旗標，所以照標題判斷（跟實際使用情境一致）
export const isPure = t => /單元練習$|歷屆試題$/.test(t);
export const isFinal = t => /模考/.test(t);
export const datesOf = blocks => [...new Set(blocks.map(b => b.date))].sort();
export const perDay = blocks => datesOf(blocks).map(d => blocks.filter(b => b.date === d).length);
export const countOn = (blocks, date, sid) =>
  blocks.filter(b => b.date === date && b.subject_id === sid).length;
