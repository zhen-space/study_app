// 外部行事曆忙碌時段的統一契約。
//
// 最重要的一條：跨來源去重用**區間聯集**，不比對事件。同一段時間被 Google
// 與裝置行事曆各報一次，不可以變成兩倍忙碌。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSY_SOURCES, MAX_INTERVALS,
  validateIntervals, normalizeIntervals, mergeBusyIntervals, busyByDay, combineDayMaps,
} from '../src/schedule/busy.js';

// 台灣時間 → UTC ISO（台灣 = UTC+8）
const tw = (date, hm) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 480) * 60000).toISOString();
};
const iv = (date, a, b, source = 'apple') => ({ start_at: tw(date, a), end_at: tw(date, b), source });

/* ---------- 驗證 ---------- */

test('只接受合法的 ISO 區間', () => {
  assert.equal(validateIntervals([]), null);
  assert.equal(validateIntervals([iv('2026-09-10', '09:00', '10:00')]), null);
  assert.match(validateIntervals('nope'), /格式/);
  assert.match(validateIntervals([{ start_at: '2026-09-10', end_at: '2026-09-10' }]), /時間格式/);
  assert.match(validateIntervals([iv('2026-09-10', '10:00', '09:00')]), /結束必須晚於開始/);
  assert.match(validateIntervals([{ ...iv('2026-09-10', '09:00', '10:00'), source: 'outlook' }]), /來源/);
});

test('數量有上限，防呆也防濫用', () => {
  const many = new Array(MAX_INTERVALS + 1).fill(iv('2026-09-10', '09:00', '10:00'));
  assert.match(validateIntervals(many), /數量/);
});

test('來源只有三種', () => {
  assert.deepEqual(BUSY_SOURCES, ['google', 'apple', 'device']);
});

/* ---------- 正規化：只留時間 ---------- */

test('標題、地點、與會者一律被丟掉，不會進到排程器', () => {
  const [out] = normalizeIntervals([{
    ...iv('2026-09-10', '09:00', '10:00'),
    title: '祕密會議', location: '台北', attendees: ['a@b.c'], notes: '不要外流',
  }]);
  assert.deepEqual(Object.keys(out).sort(), ['end_at', 'source', 'source_ref', 'start_at']);
  assert.equal(out.title, undefined);
  assert.equal(out.location, undefined);
  assert.equal(out.attendees, undefined);
  assert.equal(out.notes, undefined);
});

test('source_ref 只留短字串，且只作一次查詢內的除錯識別', () => {
  const [out] = normalizeIntervals([{ ...iv('2026-09-10', '09:00', '10:00'), source_ref: 'x'.repeat(500) }]);
  assert.equal(out.source_ref.length, 128);
  assert.equal(normalizeIntervals([iv('2026-09-10', '09:00', '10:00')])[0].source_ref, null);
});

/* ---------- 合併：跨來源去重 ---------- */

test('同一段時間被 Google 與 Apple 各報一次 → 合併成一段，不是兩倍忙碌', () => {
  const merged = mergeBusyIntervals(normalizeIntervals([
    iv('2026-09-10', '09:00', '10:00', 'google'),
    iv('2026-09-10', '09:00', '10:00', 'apple'),
  ]));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources.sort(), ['apple', 'google']);
});

test('重疊與相接都合併，中間有空隙的不合併', () => {
  const overlap = mergeBusyIntervals(normalizeIntervals([
    iv('2026-09-10', '09:00', '10:30'), iv('2026-09-10', '10:00', '11:00')]));
  assert.equal(overlap.length, 1);

  const touching = mergeBusyIntervals(normalizeIntervals([
    iv('2026-09-10', '09:00', '10:00'), iv('2026-09-10', '10:00', '11:00')]));
  assert.equal(touching.length, 1, '中間沒有空隙就是同一段忙碌');

  const gap = mergeBusyIntervals(normalizeIntervals([
    iv('2026-09-10', '09:00', '10:00'), iv('2026-09-10', '10:30', '11:00')]));
  assert.equal(gap.length, 2);
});

test('輸入順序不影響合併結果', () => {
  const a = mergeBusyIntervals(normalizeIntervals([
    iv('2026-09-10', '13:00', '14:00'), iv('2026-09-10', '09:00', '10:00')]));
  assert.deepEqual(a.map(x => x.start_at), [...a.map(x => x.start_at)].sort());
});

/* ---------- 投影到台灣的日子 ---------- */

test('絕對時刻投影成台灣時間的當天分鐘數', () => {
  const map = busyByDay(mergeBusyIntervals(normalizeIntervals([iv('2026-09-10', '09:00', '10:30')])));
  assert.deepEqual(map.get('2026-09-10'), [[540, 630]]);
});

test('跨午夜的區間切成兩天', () => {
  const merged = mergeBusyIntervals(normalizeIntervals([
    { start_at: tw('2026-09-10', '23:00'), end_at: tw('2026-09-11', '01:00'), source: 'apple' }]));
  const map = busyByDay(merged);
  assert.deepEqual(map.get('2026-09-10'), [[1380, 1440]]);
  assert.deepEqual(map.get('2026-09-11'), [[0, 60]]);
});

test('可以限定日期範圍，範圍外不輸出', () => {
  const merged = mergeBusyIntervals(normalizeIntervals([
    iv('2026-09-01', '09:00', '10:00'), iv('2026-09-10', '09:00', '10:00')]));
  const map = busyByDay(merged, '2026-09-05', '2026-09-15');
  assert.equal(map.has('2026-09-01'), false);
  assert.equal(map.has('2026-09-10'), true);
});

/* ---------- 與既有 Google day map 合併 ---------- */

test('Google 的 day map 與裝置的 day map 合併後不重複計算', () => {
  const google = new Map([['2026-09-10', [[540, 600]]]]);
  const device = new Map([['2026-09-10', [[540, 600]], ]]);
  const out = combineDayMaps(google, device);
  assert.deepEqual(out.get('2026-09-10'), [[540, 600]], '同一段只算一次');
});

test('兩邊互補的時段各自保留，重疊處合併', () => {
  const google = new Map([['2026-09-10', [[540, 600]]]]);
  const device = new Map([['2026-09-10', [[580, 660], [800, 840]]]]);
  assert.deepEqual(combineDayMaps(google, device).get('2026-09-10'), [[540, 660], [800, 840]]);
});

test('其中一邊是 null 也能用（沒連 Google、或不是 iOS）', () => {
  const device = new Map([['2026-09-10', [[540, 600]]]]);
  assert.deepEqual(combineDayMaps(null, device).get('2026-09-10'), [[540, 600]]);
  assert.deepEqual(combineDayMaps(device, null).get('2026-09-10'), [[540, 600]]);
  assert.equal(combineDayMaps(null, null).size, 0);
});

/* ---------- 契約 ---------- */

test('這個模組不碰資料庫、不呼叫外部服務', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/schedule/busy.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.equal(/db\/init|fetch\(|Anthropic/.test(code), false);
  assert.equal(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b/.test(code), false);
});
