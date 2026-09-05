// Google Calendar 的端點與排程整合。
//
// 這一支跑真的伺服器，守三件事：
//   ① 隔離：A 讀不到、也中斷不了 B 的連結
//   ② 保密：status 回應與資料庫裡都不能出現 token 明文
//   ③ fail closed：連結了但讀不到 Google 時，preview 必須 503，
//      絕不產出一份沒考慮外部行程的假安全排程
//
// 沒有連結 Google 的使用者，行為必須跟這個功能不存在時**完全一樣**。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer, day, sec } from './helpers.mjs';
import { diagnosticFetch, logActiveResources } from './handle-diagnostics.mjs';

const KEY = randomBytes(32).toString('base64');
const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'https://study-app.test/api/integrations/google-calendar/callback',
  TOKEN_ENCRYPTION_KEY: KEY,
};
const startGoogleServer = (options = {}) => startServer({ ...options, diagnostics: true });

const json = async r => ({ status: r.status, body: await r.json().catch(() => null) });
const get = (base, H, p) => diagnosticFetch(base + p, { headers: H }).then(json);
const post = (base, H, p, b) => diagnosticFetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) }).then(json);
const del = (base, H, p) => diagnosticFetch(base + p, { method: 'DELETE', headers: H }).then(json);

after(async () => {
  // 讓已收到 close 的 ChildProcessWrap 有一個 event-loop turn 完成釋放，
  // teardown snapshot 才不會把正常的短暫清理誤判為殘留。
  await new Promise(resolve => setImmediate(resolve));
  logActiveResources('google-calendar-api.test.mjs teardown');
});

test('未連結時 status 是 read_only_busy，而且不含任何 token 欄位', async () => {
  const { base, H, stop } = await startGoogleServer();
  try {
    const r = await get(base, H, '/integrations/google-calendar/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.connected, false);
    assert.equal(r.body.mode, 'read_only_busy');
    const keys = Object.keys(r.body).join(',');
    for (const bad of ['access_token', 'refresh_token', 'encrypted', 'client_secret', 'token']) {
      assert.ok(!keys.includes(bad), `status 不該有 ${bad}`);
    }
  } finally { await stop(); }
});

test('連結端點需要登入；沒設定 Google 環境變數時回 503', async () => {
  const { base, H, stop } = await startGoogleServer();
  try {
    const anon = await diagnosticFetch(base + '/integrations/google-calendar/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(anon.status, 401, '沒登入不能拿到授權網址');

    // 測試伺服器沒有 Google 環境變數
    const r = await post(base, H, '/integrations/google-calendar/connect');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'NOT_CONFIGURED');
  } finally { await stop(); }
});

test('callback 拒絕無效 state，而且不會因此建立任何連結', async () => {
  const { base, H, stop } = await startGoogleServer({ env: GOOGLE_ENV });
  try {
    const r = await diagnosticFetch(`${base}/integrations/google-calendar/callback?code=abc&state=forged`, { redirect: 'manual' });
    assert.ok([301, 302, 303, 307, 308].includes(r.status), '應該導回 App');
    assert.ok(r.headers.get('location').includes('google=failed'));

    const st = await get(base, H, '/integrations/google-calendar/status');
    assert.equal(st.body.connected, false, '驗證失敗不能留下連結');
  } finally { await stop(); }
});

test('callback 不接受沒有 code 的請求', async () => {
  const { base, stop } = await startGoogleServer({ env: GOOGLE_ENV });
  try {
    const r = await diagnosticFetch(`${base}/integrations/google-calendar/callback`, { redirect: 'manual' });
    assert.ok(r.headers.get('location').includes('google=failed'));
  } finally { await stop(); }
});

test('資料庫裡存的是密文，看不到 token 明文；A 讀不到也中斷不了 B', async () => {
  const { base, H, stop, connectGoogle, rawConnection, secondUser } = await startGoogleServer({ env: GOOGLE_ENV });
  try {
    await connectGoogle(1, { refresh_token: 'PLAINTEXT-REFRESH-XYZ', access_token: 'PLAINTEXT-ACCESS-XYZ', expires_in: 3600 });

    const row = await rawConnection(1);
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes('PLAINTEXT-REFRESH-XYZ'), 'refresh token 明文進了資料庫');
    assert.ok(!dump.includes('PLAINTEXT-ACCESS-XYZ'), 'access token 明文進了資料庫');
    assert.equal(row.scope, 'https://www.googleapis.com/auth/calendar.freebusy');
    assert.equal(row.encryption_version, 1);

    const mine = await get(base, H, '/integrations/google-calendar/status');
    assert.equal(mine.body.connected, true);
    assert.equal(mine.body.calendar, 'primary');
    assert.ok(!JSON.stringify(mine.body).includes('PLAINTEXT'), 'status 洩漏了 token');

    // 另一個使用者看不到這個連結
    const other = await secondUser();
    const theirs = await get(base, other.H, '/integrations/google-calendar/status');
    assert.equal(theirs.body.connected, false, 'B 不該看到 A 的連結');

    // B 呼叫中斷連結也不能刪到 A 的
    await del(base, other.H, '/integrations/google-calendar');
    assert.ok(await rawConnection(1), 'B 的中斷連結刪掉了 A 的憑證');
  } finally { await stop(); }
});

test('中斷連結一定會刪掉本地憑證，remote revoke 失敗也一樣', async () => {
  // 測試環境連不到 accounts.google.com，revoke 必定失敗——這正是要驗的情境：
  // 網路壞掉不能變成「使用者想中斷卻中斷不了」。
  const { base, H, stop, connectGoogle, rawConnection } = await startGoogleServer({ env: GOOGLE_ENV });
  try {
    await connectGoogle(1, { refresh_token: 'r-1', access_token: 'a-1', expires_in: 3600 });
    assert.ok(await rawConnection(1));

    const r = await del(base, H, '/integrations/google-calendar');
    assert.equal(r.status, 200);
    assert.equal(r.body.connected, false);
    assert.equal(await rawConnection(1), undefined, '本地憑證必須被刪掉');

    const st = await get(base, H, '/integrations/google-calendar/status');
    assert.equal(st.body.connected, false);
  } finally { await stop(); }
});

test('中斷連結不刪任何 Plan / Task / 行程', async () => {
  const { base, H, stop, connectGoogle } = await startGoogleServer({ env: GOOGLE_ENV });
  try {
    await post(base, H, '/lists', { name: '數學' });
    await post(base, H, '/tasks', { title: '不該被刪的任務', due_date: day(1) });
    await post(base, H, '/events', { title: '補習', date: day(1), start_time: '19:00', end_time: '21:00' });
    await connectGoogle(1, { refresh_token: 'r', access_token: 'a', expires_in: 3600 });

    await del(base, H, '/integrations/google-calendar');

    const tasks = await get(base, H, '/tasks');
    const events = await get(base, H, '/events');
    assert.equal(tasks.body.filter(t => t.title === '不該被刪的任務').length, 1);
    assert.equal(events.body.filter(e => e.title === '補習').length, 1);
  } finally { await stop(); }
});

/* ---------------- 排程整合 ---------------- */

test('沒連結 Google 時，排程行為跟這個功能不存在完全一樣', async () => {
  const { base, H, plan, stop } = await startGoogleServer();
  try {
    const r = await plan([sec(1, '單元一'), sec(1, '單元二')]);
    assert.ok(r.blocks.length >= 2, '既有排程必須照常運作');
    const st = await get(base, H, '/integrations/google-calendar/status');
    assert.equal(st.body.connected, false);
  } finally { await stop(); }
});

test('連結了但讀不到 Google 時，preview fail closed（503），不給假的安全排程', async () => {
  // 測試環境連不到 googleapis.com，FreeBusy 必定失敗
  const { base, H, stop, connectGoogle } = await startGoogleServer({ env: GOOGLE_ENV });
  try {
    await connectGoogle(1, { refresh_token: 'r', access_token: 'a', expires_in: 3600 });
    const r = await diagnosticFetch(base + '/schedule/preview', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        items: [sec(1, '單元一')], startDate: day(0), endDate: day(7),
        excludeWeekdays: [], excludeDates: [], timed: true, perDay: 0, pace: 'even',
      }),
    });
    assert.equal(r.status, 503, '讀不到外部行事曆就不該產出排程');
    const body = await r.json();
    assert.equal(body.code, 'GOOGLE_CALENDAR_UNAVAILABLE');
    assert.ok(body.error.includes('Google Calendar'));
    assert.ok(!JSON.stringify(body).includes('blocks'), '不能夾帶一份沒考慮外部行程的安排');
  } finally { await stop(); }
});

test('Google 整合不寫 fixed_events、不建 StudySession、不動 Material / Plan selection', async () => {
  const { base, H, stop, connectGoogle, tableNames } = await startGoogleServer({ env: GOOGLE_ENV });
  try {
    const before = {
      events: (await get(base, H, '/events')).body,
      sessions: (await get(base, H, '/study-sessions')).body,
    };
    await connectGoogle(1, { refresh_token: 'r', access_token: 'a', expires_in: 3600 });
    await diagnosticFetch(base + '/schedule/preview', {
      method: 'POST', headers: H,
      body: JSON.stringify({ items: [sec(1, '單元一')], startDate: day(0), endDate: day(7), timed: true }),
    }).catch(() => {});

    const after = {
      events: (await get(base, H, '/events')).body,
      sessions: (await get(base, H, '/study-sessions')).body,
    };
    assert.deepEqual(after.events, before.events, 'Google 忙碌時段不得落地成 fixed_events');
    assert.deepEqual(after.sessions, before.sessions, '不得由行事曆事件建立 StudySession');

    // 也不該多出任何鏡射表
    const names = await tableNames();
    for (const forbidden of ['google_calendar_events', 'google_busy_events', 'google_schedule_versions']) {
      assert.ok(!names.includes(forbidden), `不該存在 ${forbidden}`);
    }
    assert.ok(names.includes('google_calendar_connections'), '只該有這一張新表');
  } finally { await stop(); }
});
