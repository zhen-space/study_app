// 裝置行事曆的忙碌時段進入排程器。
//
// 這裡刻意用真的排程 API（helpers 的 plan()），不是自己重算一份 free slots——
// 自己重算的話，就算排程器根本忽略 external_busy，測試照樣會綠。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day, sec } from './helpers.mjs';

// 台灣時間 → UTC ISO
const tw = (date, hm) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 480) * 60000).toISOString();
};
const busy = (date, a, b, source = 'apple') => ({ start_at: tw(date, a), end_at: tw(date, b), source });

const D = () => day(1);

test('裝置行事曆的忙碌時段會被排程器避開', async () => {
  const s = await startServer();
  try {
    const opts = { startDate: D(), endDate: D(), timed: true, perDay: 0 };
    const before = await s.plan([sec(1, '數學', { start: D(), end: D() })], opts);
    assert.ok(before.blocks.length > 0, '先確認沒有忙碌時段時排得出來');

    // 把整天都標成忙碌，應該完全排不進去
    const after = await s.plan([sec(1, '數學', { start: D(), end: D() })], {
      ...opts, external_busy: [busy(D(), '00:00', '23:59')],
    });
    assert.equal(after.blocks.length, 0, '整天忙碌時不得排入任何 block');
  } finally { s.stop(); }
});

test('只擋住忙碌的那幾個小時，其餘時間照排', async () => {
  const s = await startServer();
  try {
    const out = await s.plan([sec(1, '數學', { start: D(), end: D() })], {
      startDate: D(), endDate: D(), timed: true, perDay: 0,
      external_busy: [busy(D(), '09:00', '12:00')],
    });
    for (const b of out.blocks) {
      if (!b.start_time || !b.end_time) continue;
      const overlaps = b.start_time < '12:00' && '09:00' < b.end_time;
      assert.equal(overlaps, false, `${b.start_time}-${b.end_time} 撞到忙碌時段`);
    }
  } finally { s.stop(); }
});

test('Google 與裝置報同一段時間，不會算成兩倍忙碌', async () => {
  const s = await startServer();
  try {
    const opts = { startDate: D(), endDate: D(), timed: true, perDay: 0 };
    const once = await s.plan([sec(1, '數學', { start: D(), end: D() })], {
      ...opts, external_busy: [busy(D(), '09:00', '12:00', 'apple')],
    });
    const twice = await s.plan([sec(1, '數學', { start: D(), end: D() })], {
      ...opts,
      external_busy: [busy(D(), '09:00', '12:00', 'apple'), busy(D(), '09:00', '12:00', 'google')],
    });
    assert.equal(twice.blocks.length, once.blocks.length,
      '同一段時間報兩次，可排時間不得因此變少');
  } finally { s.stop(); }
});

test('格式不合法一律 400，不會被當成「沒有忙碌時段」放行', async () => {
  const s = await startServer();
  try {
    for (const bad of [
      [{ start_at: 'yesterday', end_at: 'today' }],
      [{ start_at: tw(D(), '10:00'), end_at: tw(D(), '09:00') }],
      [{ ...busy(D(), '09:00', '10:00'), source: 'outlook' }],
      'not-an-array',
    ]) {
      const r = await fetch(s.base + '/schedule/preview', {
        method: 'POST', headers: s.H,
        body: JSON.stringify({
          items: [sec(1, '數學', { start: D(), end: D() })],
          startDate: D(), endDate: D(), excludeWeekdays: [], excludeDates: [],
          timed: true, perDay: 0, pace: 'even', external_busy: bad,
        }),
      });
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
      assert.equal((await r.json()).code, 'INVALID_EXTERNAL_BUSY');
    }
  } finally { s.stop(); }
});

test('裝置行事曆完全不落地：沒有新表，也沒有寫進 fixed_events', async () => {
  const s = await startServer();
  try {
    await s.plan([sec(1, '數學', { start: D(), end: D() })], {
      startDate: D(), endDate: D(), timed: true, perDay: 0,
      external_busy: [busy(D(), '09:00', '12:00')],
    });
    const names = await s.tableNames();
    for (const n of names) {
      assert.equal(/apple|device_busy|busy_cache|calendar_events/.test(n), false, `不該存在 ${n}`);
    }
    const events = await (await fetch(s.base + '/events', { headers: s.H })).json();
    assert.equal(events.length, 0, '外部忙碌時段不得變成固定行程');
  } finally { s.stop(); }
});

test('沒帶 external_busy 時行為完全不變（regression）', async () => {
  const s = await startServer();
  try {
    const out = await s.plan([sec(1, '數學', { start: D(), end: D() })],
      { startDate: D(), endDate: D(), timed: true, perDay: 0 });
    assert.ok(out.blocks.length > 0);
  } finally { s.stop(); }
});
