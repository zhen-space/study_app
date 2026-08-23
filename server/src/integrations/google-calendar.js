// Google Calendar 整合（v1）：單向唯讀，只拿「哪些時段是忙的」。
//
// 這一版刻意做到最小：
//   ・只要 calendar.freebusy 這一個 scope。拿不到事件標題、地點、參與者——
//     排程只需要知道「這段時間不能排」，多要一個欄位就多一份外洩風險。
//   ・只查 primary 日曆，不做多日曆選擇器。
//   ・不解析 RRULE、不判斷取消的重複事件、不看 transparency。
//     那些 Google 已經在 FreeBusy 裡算好了；自己再算一次只會算錯。
//   ・完全不落地。Google 的忙碌時段不寫進 fixed_events，也沒有 mirror table。
//     每次排程當下去問，問到什麼算什麼——不會有「資料庫裡那份過期了」的問題。
//
// 寫入方向永遠是 Google → Study App。這裡沒有任何建立／修改／刪除事件的程式碼。

import { createHmac, randomBytes } from 'node:crypto';
import { q } from '../db/init.js';
import { encryptToken, decryptToken, ENCRYPTION_VERSION, hasKey, safeEqual } from '../util/crypto.js';
import { addDays } from '../util/date.js';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
export const CALENDAR_ID = 'primary';
export const TZ = 'Asia/Taipei';
const TZ_OFFSET_MIN = 8 * 60;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';

const STATE_TTL_MS = 10 * 60 * 1000;      // 授權頁停留十分鐘還沒按，就重來一次
const REFRESH_SKEW_MS = 2 * 60 * 1000;    // 快過期就先換，不要等到剛好過期才發現
const FETCH_TIMEOUT_MS = 10000;

export class GoogleCalendarError extends Error {
  constructor(message, code = 'GOOGLE_CALENDAR_UNAVAILABLE') { super(message); this.code = code; }
}

export const isConfigured = () =>
  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REDIRECT_URI && hasKey());

/* ---------------- signed state ---------------- */
// callback 是 Google 直接把瀏覽器導回來的，沒有我們的 Authorization header。
// 所以「這是誰在連結」只能靠 state——它必須是伺服器簽出來的，而且短效。
// 前端送什麼 user_id 一律不採信。

const stateSecret = () => process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
const sign = payload => createHmac('sha256', stateSecret()).update(payload).digest('base64url');

export function createState(userId, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({
    purpose: 'google_calendar_connect',
    userId,
    nonce: randomBytes(16).toString('base64url'),
    exp: now + STATE_TTL_MS,
  })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyState(state, now = Date.now()) {
  const [body, mac] = String(state || '').split('.');
  if (!body || !mac) throw new GoogleCalendarError('授權狀態不正確', 'INVALID_STATE');
  if (!safeEqual(mac, sign(body))) throw new GoogleCalendarError('授權狀態驗證失敗', 'INVALID_STATE');
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { throw new GoogleCalendarError('授權狀態格式錯誤', 'INVALID_STATE'); }
  if (payload.purpose !== 'google_calendar_connect') throw new GoogleCalendarError('授權狀態用途不符', 'INVALID_STATE');
  if (!Number.isInteger(payload.userId)) throw new GoogleCalendarError('授權狀態沒有使用者', 'INVALID_STATE');
  if (!(payload.exp > now)) throw new GoogleCalendarError('授權連結已過期，請重新連結', 'EXPIRED_STATE');
  return payload;
}

export function authorizationUrl(userId) {
  if (!isConfigured()) throw new GoogleCalendarError('伺服器尚未設定 Google Calendar', 'NOT_CONFIGURED');
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPE,              // 只要這一個，不多要
    access_type: 'offline',           // 才拿得到 refresh token
    include_granted_scopes: 'false',
    prompt: 'consent',
    state: createState(userId),
  });
  return `${AUTH_URL}?${p.toString()}`;
}

/* ---------------- token ---------------- */

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 就當作沒有細節 */ }
  return { ok: res.ok, status: res.status, json };
}

export async function exchangeCode(code) {
  const r = await postForm(TOKEN_URL, {
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  // 這裡刻意不把 Google 的回應內容放進錯誤訊息：它可能含 token。
  if (!r.ok || !r.json?.refresh_token) {
    throw new GoogleCalendarError('Google 授權失敗，請再試一次', 'TOKEN_EXCHANGE_FAILED');
  }
  return r.json;
}

export async function saveConnection(userId, token, now = new Date()) {
  const iso = now.toISOString();
  const expires = token.expires_in
    ? new Date(now.getTime() + Number(token.expires_in) * 1000).toISOString() : null;
  await q.run(`INSERT INTO google_calendar_connections
    (user_id,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,scope,token_type,
     encryption_version,connected_at,updated_at,last_success_at,last_error_code)
    VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token_encrypted=excluded.access_token_encrypted,
      refresh_token_encrypted=excluded.refresh_token_encrypted,
      access_token_expires_at=excluded.access_token_expires_at,
      scope=excluded.scope, token_type=excluded.token_type,
      encryption_version=excluded.encryption_version,
      updated_at=excluded.updated_at, last_error_code=NULL`,
  [userId,
    token.access_token ? encryptToken(token.access_token) : null,
    encryptToken(token.refresh_token),
    expires, token.scope || GOOGLE_SCOPE, token.token_type || 'Bearer',
    ENCRYPTION_VERSION, iso, iso]);
}

export const getConnection = userId =>
  q.get('SELECT * FROM google_calendar_connections WHERE user_id=?', [userId]);

// 需要時才換 access token。Google 在 refresh 回應裡通常**不會**再給一次
// refresh token——這時必須保留原本那把，否則使用者下次就得重新授權。
export async function accessTokenFor(userId, now = Date.now()) {
  const conn = await getConnection(userId);
  if (!conn) throw new GoogleCalendarError('尚未連結 Google Calendar', 'NOT_CONNECTED');

  const notExpired = conn.access_token_encrypted && conn.access_token_expires_at
    && Date.parse(conn.access_token_expires_at) - REFRESH_SKEW_MS > now;
  if (notExpired) return decryptToken(conn.access_token_encrypted);

  const refresh = decryptToken(conn.refresh_token_encrypted);
  const r = await postForm(TOKEN_URL, {
    refresh_token: refresh,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  if (!r.ok || !r.json?.access_token) {
    await q.run('UPDATE google_calendar_connections SET last_error_code=?,updated_at=? WHERE user_id=?',
      ['REFRESH_FAILED', new Date(now).toISOString(), userId]);
    throw new GoogleCalendarError('Google Calendar 需要重新連結', 'REAUTH_REQUIRED');
  }
  const expires = r.json.expires_in
    ? new Date(now + Number(r.json.expires_in) * 1000).toISOString() : null;
  await q.run(`UPDATE google_calendar_connections
      SET access_token_encrypted=?, access_token_expires_at=?, updated_at=?, last_error_code=NULL
        ${r.json.refresh_token ? ', refresh_token_encrypted=?' : ''}
    WHERE user_id=?`,
  r.json.refresh_token
    ? [encryptToken(r.json.access_token), expires, new Date(now).toISOString(), encryptToken(r.json.refresh_token), userId]
    : [encryptToken(r.json.access_token), expires, new Date(now).toISOString(), userId]);
  return r.json.access_token;
}

export async function disconnect(userId) {
  const conn = await getConnection(userId);
  // 先盡力通知 Google 撤銷，但**不論成敗都要刪掉本地的 token**。
  // 網路壞掉不能變成「使用者想中斷卻中斷不了」。
  let revoked = false;
  if (conn?.refresh_token_encrypted) {
    try {
      const r = await postForm(REVOKE_URL, { token: decryptToken(conn.refresh_token_encrypted) });
      revoked = r.ok;
    } catch { revoked = false; }
  }
  await q.run('DELETE FROM google_calendar_connections WHERE user_id=?', [userId]);
  return { removed: !!conn, revoked };
}

/* ---------------- FreeBusy → 每天的忙碌分鐘區間 ---------------- */

// RFC3339 → 台灣時間的「第幾分鐘」。Date.parse 已經處理好各種偏移寫法
// （Z、+08:00、-05:00），我們只要把絕對時間換算到台灣即可。
const twMinutes = iso => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new GoogleCalendarError('Google 回傳的時間格式無法解析', 'BAD_RESPONSE');
  return Math.floor(ms / 60000) + TZ_OFFSET_MIN;
};
const twDate = totalMin => {
  const d = new Date(Math.floor(totalMin / 1440) * 1440 * 60000);
  return d.toISOString().slice(0, 10);
};

// 一段 busy 區間 → 依台灣本地日期切成每日的 [起分, 迄分]。
// 跨午夜、跨好幾天、整天（[0,1440]）都由這裡處理；
// 不用 UTC 的 .slice(0,10) 決定日期，那在 UTC+8 會整個差一天。
export function splitBusyByDay(startIso, endIso) {
  const start = twMinutes(startIso);
  const end = twMinutes(endIso);
  if (end <= start) return [];
  const out = [];
  let cur = start;
  while (cur < end) {
    const dayStart = Math.floor(cur / 1440) * 1440;
    const dayEnd = dayStart + 1440;
    const sliceEnd = Math.min(end, dayEnd);
    out.push([twDate(cur), cur - dayStart, sliceEnd - dayStart]);
    cur = sliceEnd;
  }
  return out;
}

// busy 陣列 → Map<YYYY-MM-DD, [[startMin, endMin], ...]>，同一天內合併重疊。
export function busyToDayMap(busy = [], startDate = null, endDate = null) {
  const map = new Map();
  for (const b of busy) {
    if (!b?.start || !b?.end) continue;
    for (const [date, s, e] of splitBusyByDay(b.start, b.end)) {
      if (startDate && date < startDate) continue;
      if (endDate && date > endDate) continue;
      if (!map.has(date)) map.set(date, []);
      map.get(date).push([s, e]);
    }
  }
  for (const [date, list] of map) {
    list.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const iv of list) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([...iv]);
    }
    map.set(date, merged);
  }
  return map;
}

// 排程當下才去問。回傳 Map<YYYY-MM-DD, [[startMin,endMin],...]>；
// 沒連結就回 null，呼叫端據此判斷「這個使用者根本沒有這一層」。
export async function loadGoogleBusy(userId, startDate, endDate, now = Date.now()) {
  const conn = await getConnection(userId);
  if (!conn) return null;

  const accessToken = await accessTokenFor(userId, now);
  const timeMin = `${startDate}T00:00:00+08:00`;
  const timeMax = `${addDays(endDate, 1)}T00:00:00+08:00`;   // 迄點取後一天零點，含最後一天整天

  let res;
  try {
    res = await fetch(FREEBUSY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin, timeMax, timeZone: TZ, items: [{ id: CALENDAR_ID }] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    await markError(userId, 'FETCH_FAILED', now);
    throw new GoogleCalendarError('暫時無法讀取 Google Calendar');
  }
  if (!res.ok) {
    await markError(userId, `HTTP_${res.status}`, now);
    throw new GoogleCalendarError('暫時無法讀取 Google Calendar');
  }
  let body;
  try { body = await res.json(); } catch {
    await markError(userId, 'BAD_RESPONSE', now);
    throw new GoogleCalendarError('暫時無法讀取 Google Calendar');
  }
  const cal = body?.calendars?.[CALENDAR_ID];
  // Google 針對單一日曆回報的錯誤（沒權限、日曆不存在）也算讀取失敗，
  // 不能當成「這個人這段時間都有空」。
  if (!cal || (cal.errors?.length)) {
    await markError(userId, 'CALENDAR_ERROR', now);
    throw new GoogleCalendarError('暫時無法讀取 Google Calendar');
  }
  await q.run('UPDATE google_calendar_connections SET last_success_at=?,last_error_code=NULL,updated_at=? WHERE user_id=?',
    [new Date(now).toISOString(), new Date(now).toISOString(), userId]);
  return busyToDayMap(cal.busy || [], startDate, endDate);
}

async function markError(userId, code, now) {
  await q.run('UPDATE google_calendar_connections SET last_error_code=?,updated_at=? WHERE user_id=?',
    [code, new Date(now).toISOString(), userId]).catch(() => {});
}

// 給前端看的狀態。這裡永遠不會出現 token、密文或 client secret。
export async function statusFor(userId) {
  const conn = await getConnection(userId);
  if (!conn) return { connected: false, mode: 'read_only_busy' };
  return {
    connected: true,
    calendar: CALENDAR_ID,
    mode: 'read_only_busy',
    last_success_at: conn.last_success_at || null,
  };
}
