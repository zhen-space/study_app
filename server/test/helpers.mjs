// 測試用的共用工具：開一台乾淨的伺服器（暫存資料庫）、註冊測試帳號、送排程請求
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 開一台只給這次測試用的伺服器：隨機埠、暫存 SQLite、跟正式/開發資料完全隔離
export async function startServer() {
  const dir = mkdtempSync(path.join(tmpdir(), 'studyapp-test-'));
  const port = 3400 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: path.join(dir, 'test.sqlite'),
      JWT_SECRET: 'test-secret',
      TURSO_DATABASE_URL: '',        // 確保不會連到雲端資料庫
      TURSO_AUTH_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  const base = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error('伺服器啟動失敗：\n' + log);
    try {
      const r = await fetch(base + '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x@x', password: 'x' }),
      });
      if (r.status) break;                       // 有回應就代表起來了（401 也算）
    } catch { await new Promise(r => setTimeout(r, 100)); }
  }

  const email = `t${Date.now()}@test.local`;
  const reg = await fetch(base + '/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: '12345678', name: '測試' }),
  });
  const { token } = await reg.json();
  if (!token) throw new Error('註冊測試帳號失敗：\n' + log);
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  // 送一次排程，回傳 { blocks, check, unplaced }
  const plan = async (items, opts = {}) => {
    const r = await fetch(base + '/schedule/preview', {
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

  const stop = () => {
    proc.kill('SIGKILL');
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return { base, H, plan, stop, log: () => log };
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
