// Google 的忙碌時段真的有把排程擠開嗎？
//
// 前面幾支測的是「不會壞」；這一支測的是「真的有效」——如果 busy 沒有被扣掉，
// 整個功能就只是一個好看的連結按鈕。
//
// 這裡直接測 scheduler 用的那兩個函式（freeSlotsForDay / busyMinutesForDay 的
// 語意），以避免為了戳一次 FreeBusy 而在測試裡架一台假的 Google。
// 端點層的失敗行為（fail closed）由 google-calendar-api.test.mjs 負責。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyToDayMap } from '../src/integrations/google-calendar.js';
// 直接測 scheduler 真正用的那兩個函式。
// 先前這裡自己複製了一份 freeSlots 的邏輯——那樣測的是「我對契約的理解」，
// 就算真正的 freeSlotsForDay 完全忽略 externalBusy，測試也照樣全綠。
import { freeSlotsForDay, busyMinutesForDay } from '../src/routes/schedule.js';

const SETTINGS = { sleep_start: '23:00', sleep_end: '07:00', meal_windows: [['12:00', '12:30']] };
const ev = (start_time, end_time, date) => ({ date, start_time, end_time, recurring: null });
const freeSlots = ({ events = [], external = null, date = '2026-09-01' }) =>
  freeSlotsForDay(date, events, SETTINGS, null, external);

const covers = (slots, from, to) => slots.some(([a, b]) => a <= from && b >= to);

test('沒有 Google busy 時的空檔就是既有行為', () => {
  const free = freeSlots({});
  assert.ok(covers(free, 8 * 60, 12 * 60), '早上應該是空的');
  assert.ok(covers(free, 13 * 60, 22 * 60), '下午到晚上應該是空的');
});

test('Google 的忙碌時段真的把那一段從空檔裡挖掉', () => {
  const map = busyToDayMap([
    { start: '2026-09-01T09:00:00+08:00', end: '2026-09-01T12:00:00+08:00' },
  ]);
  const free = freeSlots({ external: map.get('2026-09-01') });
  assert.ok(!free.some(([a, b]) => a < 12 * 60 && b > 9 * 60), '09:00–12:00 不該還是空的');
  assert.ok(covers(free, 13 * 60, 22 * 60), '沒被 Google 佔到的時段要留著');
});

test('整天忙碌時當天完全排不進去', () => {
  const map = busyToDayMap([
    { start: '2026-09-03T00:00:00+08:00', end: '2026-09-04T00:00:00+08:00' },
  ]);
  const free = freeSlots({ external: map.get('2026-09-03'), date: '2026-09-03' });
  assert.deepEqual(free, [], '整天 busy 的日子不該有任何空檔');
});

test('跨午夜的行程會同時吃掉兩天各自的時段', () => {
  const map = busyToDayMap([
    { start: '2026-09-01T21:00:00+08:00', end: '2026-09-02T02:00:00+08:00' },
  ]);
  const d1 = freeSlots({ external: map.get('2026-09-01'), date: '2026-09-01' });
  const d2 = freeSlots({ external: map.get('2026-09-02'), date: '2026-09-02' });
  assert.ok(!d1.some(([a, b]) => a < 1440 && b > 21 * 60), '第一天 21:00 之後不該是空的');
  assert.ok(!d2.some(([a]) => a < 2 * 60), '第二天凌晨那段也要被吃掉');
  assert.ok(covers(d2, 8 * 60, 12 * 60), '第二天白天仍然可用');
});

test('Google busy 與既有行程重疊時不會重複扣，也不會漏扣', () => {
  const map = busyToDayMap([
    { start: '2026-09-01T19:00:00+08:00', end: '2026-09-01T20:00:00+08:00' },
  ]);
  const free = freeSlots({
    events: [ev('19:30', '21:00', '2026-09-01')],   // 使用者自己的補習
    external: map.get('2026-09-01'),
  });
  assert.ok(!free.some(([a, b]) => a < 21 * 60 && b > 19 * 60), '19:00–21:00 整段都不該有空檔');
  assert.ok(covers(free, 21 * 60, 23 * 60), '21:00 之後要恢復可用');
});

test('剩不到 30 分鐘的縫隙不算空檔（跟既有規則一致）', () => {
  const map = busyToDayMap([
    { start: '2026-09-01T08:00:00+08:00', end: '2026-09-01T11:50:00+08:00' },
  ]);
  const free = freeSlots({ external: map.get('2026-09-01') });
  // 07:00 起床到 08:00 有 60 分鐘 → 算；11:50 到 12:00 只有 10 分鐘 → 不算
  assert.ok(covers(free, 7 * 60, 8 * 60));
  assert.ok(!free.some(([a, b]) => a >= 11 * 60 + 50 && b <= 12 * 60));
});

test('busyMinutesForDay 把外部忙碌算進「這天太滿」', () => {
  const map = busyToDayMap([
    { start: '2026-09-01T09:00:00+08:00', end: '2026-09-01T17:00:00+08:00' },
  ]);
  const external = map.get('2026-09-01');
  assert.equal(busyMinutesForDay('2026-09-01', [], null), 0, '沒有外部行事曆時維持既有行為');
  assert.equal(busyMinutesForDay('2026-09-01', [], external), 8 * 60, '整天在外面要算成 480 分鐘');
  // 使用者自己的行程也要一起算，不是被外部忙碌取代
  assert.equal(
    busyMinutesForDay('2026-09-01', [ev('19:00', '20:00', '2026-09-01')], external),
    9 * 60);
});
