// Token 生命週期：落地、換新、外洩面。
//
// 這一支存在的理由是 mutation testing 抓到的三個破口：
//   ・「資料庫存的是密文」原本只驗到測試工具寫進去的資料，沒有驗到
//     saveConnection 本身——把 encryptToken 拿掉，測試照樣全綠。
//   ・refresh 流程完全沒有測試。Google 在 refresh 回應裡通常不會再給一次
//     refresh token，若這時把舊的清掉，使用者下次就得重新授權，
//     而且要等到 token 過期才會發現。
//   ・status 只驗了「沒有 PLAINTEXT 字樣」，把整筆 connection 攤平回傳
//     （含密文欄位）也不會被抓到。
//
// 這裡直接對真正的函式做，並用 stub 取代對 Google 的網路呼叫。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const KEY = randomBytes(32).toString('base64');
const dir = mkdtempSync(path.join(tmpdir(), 'gcal-token-'));
process.env.DB_FILE = path.join(dir, 'token.sqlite');
process.env.TURSO_DATABASE_URL = '';
process.env.TOKEN_ENCRYPTION_KEY = KEY;
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csec';
process.env.GOOGLE_REDIRECT_URI = 'https://study-app.test/api/integrations/google-calendar/callback';

const { q, initSchema } = await import('../src/db/init.js');
const gcal = await import('../src/integrations/google-calendar.js');
const { decryptToken } = await import('../src/util/crypto.js');

await (initSchema?.() ?? Promise.resolve());
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } });

const row = userId => q.get('SELECT * FROM google_calendar_connections WHERE user_id=?', [userId]);

// 換掉 global fetch 來模擬 Google 的回應，測完還原。
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = original; }
}
const jsonResponse = (body, ok = true) => ({
  ok, status: ok ? 200 : 400,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

test('saveConnection 真的把 token 加密後才落地', async () => {
  await gcal.saveConnection(101, {
    access_token: 'ACCESS-PLAINTEXT-101',
    refresh_token: 'REFRESH-PLAINTEXT-101',
    expires_in: 3600,
    scope: gcal.GOOGLE_SCOPE,
  });
  const r = await row(101);
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes('ACCESS-PLAINTEXT-101'), 'access token 明文進了資料庫');
  assert.ok(!dump.includes('REFRESH-PLAINTEXT-101'), 'refresh token 明文進了資料庫');
  // 而且要能解得回來——不是隨便存了一段讀不出來的東西
  assert.equal(decryptToken(r.refresh_token_encrypted), 'REFRESH-PLAINTEXT-101');
  assert.equal(decryptToken(r.access_token_encrypted), 'ACCESS-PLAINTEXT-101');
  assert.equal(r.scope, gcal.GOOGLE_SCOPE);
  assert.equal(r.encryption_version, 1);
});

test('access token 沒過期就直接用，不會多打一次 Google', async () => {
  await gcal.saveConnection(102, { access_token: 'A-102', refresh_token: 'R-102', expires_in: 3600 });
  let called = 0;
  await withFetch(async () => { called += 1; return jsonResponse({}); }, async () => {
    assert.equal(await gcal.accessTokenFor(102), 'A-102');
  });
  assert.equal(called, 0, '還沒過期就不該去換新的');
});

test('access token 過期時換新的，而且沒回新 refresh token 就保留原本那把', async () => {
  await gcal.saveConnection(103, { access_token: 'OLD-A-103', refresh_token: 'KEEP-R-103', expires_in: -10 });
  const before = await row(103);

  await withFetch(async () => jsonResponse({ access_token: 'NEW-A-103', expires_in: 3600 }), async () => {
    assert.equal(await gcal.accessTokenFor(103), 'NEW-A-103');
  });

  const after = await row(103);
  assert.equal(decryptToken(after.access_token_encrypted), 'NEW-A-103', 'access token 要換成新的');
  assert.ok(after.refresh_token_encrypted, 'refresh token 不能被清掉');
  assert.equal(decryptToken(after.refresh_token_encrypted), 'KEEP-R-103',
    'Google 沒給新的 refresh token 時必須保留原本那把，否則使用者下次得重新授權');
  assert.notEqual(after.access_token_expires_at, before.access_token_expires_at);
});

test('Google 有回新的 refresh token 時就換掉', async () => {
  await gcal.saveConnection(104, { access_token: 'OLD-A-104', refresh_token: 'OLD-R-104', expires_in: -10 });
  await withFetch(async () => jsonResponse({ access_token: 'NEW-A-104', refresh_token: 'NEW-R-104', expires_in: 3600 }), async () => {
    await gcal.accessTokenFor(104);
  });
  assert.equal(decryptToken((await row(104)).refresh_token_encrypted), 'NEW-R-104');
});

test('refresh 失敗時要求重新連結，並記下原因，但不刪掉憑證', async () => {
  await gcal.saveConnection(105, { access_token: 'A-105', refresh_token: 'R-105', expires_in: -10 });
  await withFetch(async () => jsonResponse({ error: 'invalid_grant' }, false), async () => {
    await assert.rejects(() => gcal.accessTokenFor(105), e => e.code === 'REAUTH_REQUIRED');
  });
  const r = await row(105);
  assert.ok(r, '刪掉憑證會讓使用者連「需要重新連結」都看不到');
  assert.equal(r.last_error_code, 'REFRESH_FAILED');
});

test('status 只回傳前端需要的欄位，絕不夾帶任何 token 或密文', async () => {
  await gcal.saveConnection(106, { access_token: 'A-106', refresh_token: 'R-106', expires_in: 3600 });
  const s = await gcal.statusFor(106);

  assert.deepEqual(Object.keys(s).sort(), ['calendar', 'connected', 'last_success_at', 'mode'].sort(),
    'status 的欄位是白名單，不能把整筆 connection 攤平回去');
  const dump = JSON.stringify(s);
  for (const bad of ['token', 'encrypted', 'secret', 'A-106', 'R-106']) {
    assert.ok(!dump.includes(bad), `status 洩漏了 ${bad}`);
  }
});

test('未連結時的 status 也不含多餘欄位', async () => {
  const s = await gcal.statusFor(999);
  assert.deepEqual(s, { connected: false, mode: 'read_only_busy' });
});

test('沒有連結時 loadGoogleBusy 回 null，不去打 Google', async () => {
  let called = 0;
  await withFetch(async () => { called += 1; return jsonResponse({}); }, async () => {
    assert.equal(await gcal.loadGoogleBusy(998, '2026-09-01', '2026-09-07'), null);
  });
  assert.equal(called, 0);
});

test('FreeBusy 只問 primary，時間窗是台灣時間、且含最後一天整天', async () => {
  await gcal.saveConnection(107, { access_token: 'A-107', refresh_token: 'R-107', expires_in: 3600 });
  let sent = null;
  await withFetch(async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return jsonResponse({ calendars: { primary: { busy: [] } } });
  }, async () => {
    await gcal.loadGoogleBusy(107, '2026-09-01', '2026-09-07');
  });
  assert.ok(sent.url.includes('/calendar/v3/freeBusy'));
  assert.deepEqual(sent.body.items, [{ id: 'primary' }], 'v1 只查 primary');
  assert.equal(sent.body.timeZone, 'Asia/Taipei');
  assert.equal(sent.body.timeMin, '2026-09-01T00:00:00+08:00');
  assert.equal(sent.body.timeMax, '2026-09-08T00:00:00+08:00', '迄點取後一天零點，才含得到最後一天');
  assert.equal(sent.auth, 'Bearer A-107');
});

test('Google 回報該日曆有錯誤時視為讀取失敗，不當成「這個人有空」', async () => {
  await gcal.saveConnection(108, { access_token: 'A-108', refresh_token: 'R-108', expires_in: 3600 });
  await withFetch(async () => jsonResponse({ calendars: { primary: { errors: [{ reason: 'notFound' }], busy: [] } } }), async () => {
    await assert.rejects(() => gcal.loadGoogleBusy(108, '2026-09-01', '2026-09-07'),
      e => e.code === 'GOOGLE_CALENDAR_UNAVAILABLE');
  });
});

test('讀取成功會記下時間並清掉先前的錯誤', async () => {
  await gcal.saveConnection(109, { access_token: 'A-109', refresh_token: 'R-109', expires_in: 3600 });
  await q.run('UPDATE google_calendar_connections SET last_error_code=? WHERE user_id=?', ['HTTP_500', 109]);
  await withFetch(async () => jsonResponse({
    calendars: { primary: { busy: [{ start: '2026-09-01T09:00:00+08:00', end: '2026-09-01T10:00:00+08:00' }] } },
  }), async () => {
    const map = await gcal.loadGoogleBusy(109, '2026-09-01', '2026-09-07');
    assert.deepEqual(map.get('2026-09-01'), [[540, 600]]);
  });
  const r = await row(109);
  assert.ok(r.last_success_at);
  assert.equal(r.last_error_code, null);
});
