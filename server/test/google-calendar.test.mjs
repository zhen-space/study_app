// Google Calendar v1：單向唯讀，只當作 scheduler 的外部忙碌時段。
//
// 這裡守的多半是「壞掉不會有人發現」的東西：
//   ・scope 多要了一個 → 沒人會注意，但外洩範圍整個變大
//   ・token 明文進資料庫 → 平常完全看不出來
//   ・Google 掛掉時靜默忽略 → 會產出一份看起來完全可行、實際撞滿的排程
// 所以這些一律要有測試釘住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptToken, decryptToken, loadKey, EncryptionKeyError } from '../src/util/crypto.js';
import {
  GOOGLE_SCOPE, CALENDAR_ID, createState, verifyState, splitBusyByDay, busyToDayMap,
  authorizationUrl, GoogleCalendarError,
} from '../src/integrations/google-calendar.js';

const KEY = randomBytes(32).toString('base64');
const withEnv = async (env, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k] of Object.entries(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

/* ---------------- 加密 ---------------- */

test('加密 roundtrip；同樣的明文每次密文不同（隨機 IV）', () => {
  const key = Buffer.from(KEY, 'base64');
  const a = encryptToken('1//refresh-token-abc', key);
  const b = encryptToken('1//refresh-token-abc', key);
  assert.notEqual(a, b, '固定 IV 會讓相同 token 產生相同密文');
  assert.equal(decryptToken(a, key), '1//refresh-token-abc');
  assert.equal(decryptToken(b, key), '1//refresh-token-abc');
  assert.ok(!a.includes('refresh-token-abc'), 'envelope 裡不能看得到明文');
});

test('用錯的金鑰解不開，而且是丟例外，不是回一段垃圾', () => {
  const good = Buffer.from(KEY, 'base64');
  const bad = randomBytes(32);
  const box = encryptToken('secret-value', good);
  assert.throws(() => decryptToken(box, bad));
});

test('密文被動過手腳就解不開（GCM authentication tag）', () => {
  const key = Buffer.from(KEY, 'base64');
  const box = JSON.parse(encryptToken('secret-value', key));
  const ct = Buffer.from(box.ct, 'base64');
  ct[0] ^= 0xff;
  assert.throws(() => decryptToken(JSON.stringify({ ...box, ct: ct.toString('base64') }), key));
});

test('金鑰長度不對就直接失敗，不會將就跑起來', async () => {
  await withEnv({ TOKEN_ENCRYPTION_KEY: Buffer.from('too-short').toString('base64') }, () => {
    assert.throws(() => loadKey(), EncryptionKeyError);
  });
  await withEnv({ TOKEN_ENCRYPTION_KEY: '' }, () => {
    assert.throws(() => loadKey(), EncryptionKeyError);
  });
  await withEnv({ TOKEN_ENCRYPTION_KEY: KEY }, () => {
    assert.equal(loadKey().length, 32);
  });
});

/* ---------------- OAuth scope 與 state ---------------- */

test('授權網址只要 calendar.freebusy，沒有任何其他 scope', async () => {
  await withEnv({
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec',
    GOOGLE_REDIRECT_URI: 'https://example.test/api/integrations/google-calendar/callback',
    TOKEN_ENCRYPTION_KEY: KEY,
  }, () => {
    const url = new URL(authorizationUrl(7));
    assert.equal(url.searchParams.get('scope'), GOOGLE_SCOPE);
    assert.equal(GOOGLE_SCOPE, 'https://www.googleapis.com/auth/calendar.freebusy');
    for (const forbidden of [
      'auth/calendar ', 'calendar.readonly', 'calendar.events',
      'calendar.events.readonly', 'calendar.calendarlist.readonly',
    ]) {
      assert.ok(!url.searchParams.get('scope').includes(forbidden), `不該要求 ${forbidden}`);
    }
    assert.equal(url.searchParams.get('access_type'), 'offline', '沒有 offline 就拿不到 refresh token');
    assert.ok(url.searchParams.get('state'), '一定要帶 state');
    assert.ok(!url.searchParams.get('redirect_uri').includes('localhost'), 'redirect 必須來自環境變數');
  });
});

test('沒設定 Google 環境變數時不產生授權網址', async () => {
  await withEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: '' }, () => {
    assert.throws(() => authorizationUrl(1), e => e.code === 'NOT_CONFIGURED');
  });
});

test('state 是伺服器簽的：竄改、過期、換用途一律拒絕', async () => {
  await withEnv({ TOKEN_ENCRYPTION_KEY: KEY }, () => {
    const now = Date.now();
    const state = createState(42, now);
    assert.equal(verifyState(state, now).userId, 42);

    // 竄改 payload（把 userId 換成別人）而不重簽 → 必須被擋
    const [body] = state.split('.');
    const tampered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    tampered.userId = 999;
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${state.split('.')[1]}`;
    assert.throws(() => verifyState(forged, now), e => e.code === 'INVALID_STATE');

    assert.throws(() => verifyState(state, now + 11 * 60 * 1000), e => e.code === 'EXPIRED_STATE');
    assert.throws(() => verifyState('garbage', now), e => e.code === 'INVALID_STATE');
    assert.throws(() => verifyState('', now), e => e.code === 'INVALID_STATE');
  });
});

test('不同使用者的 state 不能互換', async () => {
  await withEnv({ TOKEN_ENCRYPTION_KEY: KEY }, () => {
    const now = Date.now();
    assert.equal(verifyState(createState(1, now), now).userId, 1);
    assert.equal(verifyState(createState(2, now), now).userId, 2);
  });
});

/* ---------------- FreeBusy → 每日分鐘區間 ---------------- */

test('一般時段換算成台灣時間的分鐘區間', () => {
  // 09:00–10:30 (+08:00)
  const out = splitBusyByDay('2026-09-01T09:00:00+08:00', '2026-09-01T10:30:00+08:00');
  assert.deepEqual(out, [['2026-09-01', 540, 630]]);
});

test('Google 用 Z 表示時間時也要換算到台灣，不是直接切 UTC 日期', () => {
  // 2026-09-01T16:30Z ＝ 台灣 2026-09-02 00:30
  const out = splitBusyByDay('2026-09-01T16:30:00Z', '2026-09-01T17:00:00Z');
  assert.deepEqual(out, [['2026-09-02', 30, 60]], 'UTC .slice(0,10) 會算成 09-01');
});

test('跨午夜的行程依台灣本地日期拆成兩天', () => {
  const out = splitBusyByDay('2026-09-01T22:00:00+08:00', '2026-09-02T01:30:00+08:00');
  assert.deepEqual(out, [
    ['2026-09-01', 1320, 1440],
    ['2026-09-02', 0, 90],
  ]);
});

test('整天的行程表示成 [0, 1440]，跨多天則每天都是整天', () => {
  const one = splitBusyByDay('2026-09-03T00:00:00+08:00', '2026-09-04T00:00:00+08:00');
  assert.deepEqual(one, [['2026-09-03', 0, 1440]]);
  const two = splitBusyByDay('2026-09-03T00:00:00+08:00', '2026-09-05T00:00:00+08:00');
  assert.deepEqual(two, [['2026-09-03', 0, 1440], ['2026-09-04', 0, 1440]]);
});

test('同一天內重疊的忙碌時段會合併', () => {
  const map = busyToDayMap([
    { start: '2026-09-01T09:00:00+08:00', end: '2026-09-01T10:00:00+08:00' },
    { start: '2026-09-01T09:30:00+08:00', end: '2026-09-01T11:00:00+08:00' },
    { start: '2026-09-01T14:00:00+08:00', end: '2026-09-01T15:00:00+08:00' },
  ]);
  assert.deepEqual(map.get('2026-09-01'), [[540, 660], [840, 900]]);
});

test('範圍外的日期被濾掉', () => {
  const map = busyToDayMap([
    { start: '2026-08-30T09:00:00+08:00', end: '2026-08-30T10:00:00+08:00' },
    { start: '2026-09-02T09:00:00+08:00', end: '2026-09-02T10:00:00+08:00' },
    { start: '2026-09-09T09:00:00+08:00', end: '2026-09-09T10:00:00+08:00' },
  ], '2026-09-01', '2026-09-05');
  assert.deepEqual([...map.keys()], ['2026-09-02']);
});

// 重複事件、取消的實例、transparency 全部由 Google 在 FreeBusy 算好。
// 我們只照收到的 busy 陣列處理——這一條是刻意的：自己解析 RRULE 只會算錯。
test('不自行解析重複或取消：FreeBusy 給幾段就是幾段', () => {
  const map = busyToDayMap([
    { start: '2026-09-01T09:00:00+08:00', end: '2026-09-01T10:00:00+08:00' },
    { start: '2026-09-08T09:00:00+08:00', end: '2026-09-08T10:00:00+08:00' },
  ]);
  // 每週重複的第三次被取消 → Google 不會回它，我們也不該自己補出來
  assert.equal(map.size, 2);
  assert.ok(!map.has('2026-09-15'));
});

test('壞掉的時間格式會丟明確的錯，不會靜默變成沒有忙碌', () => {
  assert.throws(() => splitBusyByDay('not-a-date', '2026-09-01T10:00:00+08:00'), GoogleCalendarError);
});

test('迄點不晚於起點的區間直接忽略', () => {
  assert.deepEqual(splitBusyByDay('2026-09-01T10:00:00+08:00', '2026-09-01T10:00:00+08:00'), []);
  assert.deepEqual(splitBusyByDay('2026-09-01T11:00:00+08:00', '2026-09-01T10:00:00+08:00'), []);
});

test('v1 只查 primary', () => {
  assert.equal(CALENDAR_ID, 'primary');
});
