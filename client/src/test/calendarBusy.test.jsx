// 裝置行事曆 adapter 的平台邊界。
//
// 重點在「沒有原生層時要正確地什麼都不做」：不得假裝 web 可以讀 EventKit，
// 也不得因為讀不到就擋住排程。
import { describe, it, expect, afterEach } from 'vitest';
import {
  PERMISSION_STATES, isSupported, getPermissionState, requestPermission,
  listCalendars, getBusyIntervals, permissionMessage,
} from '../tt/calendarBusy';

const install = impl => { globalThis.StudyAppCalendar = impl; };
afterEach(() => { delete globalThis.StudyAppCalendar; });

const RANGE = { startDate: '2026-09-10', endDate: '2026-09-17' };
const ok = (over = {}) => ({
  getPermissionState: async () => 'authorized',
  requestPermission: async () => 'authorized',
  listCalendars: async () => [{ id: 'c1', title: '個人' }],
  getBusyIntervals: async () => ([
    { start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z' },
  ]),
  ...over,
});

describe('沒有原生層（Web / Android）', () => {
  it('一律 unsupported，而且不丟例外', async () => {
    expect(isSupported()).toBe(false);
    expect(await getPermissionState()).toBe('unsupported');
    expect(await requestPermission()).toBe('unsupported');
    expect(await listCalendars()).toEqual([]);
    expect(await getBusyIntervals(RANGE)).toEqual([]);
  });

  it('訊息說清楚是平台限制，不是壞掉', () => {
    expect(permissionMessage('unsupported')).toMatch(/iPhone|iPad/);
  });
});

describe('權限', () => {
  it('五種狀態', () => {
    expect(PERMISSION_STATES).toEqual(
      ['unsupported', 'not_determined', 'authorized', 'denied', 'restricted']);
  });

  it('被拒絕過就不再跳權限視窗', async () => {
    let asked = 0;
    install(ok({
      getPermissionState: async () => 'denied',
      requestPermission: async () => { asked += 1; return 'authorized'; },
    }));
    expect(await requestPermission()).toBe('denied');
    expect(asked).toBe(0, '拒絕過就不該再問');
  });

  it('restricted 同樣不再詢問', async () => {
    let asked = 0;
    install(ok({
      getPermissionState: async () => 'restricted',
      requestPermission: async () => { asked += 1; return 'authorized'; },
    }));
    expect(await requestPermission()).toBe('restricted');
    expect(asked).toBe(0);
  });

  it('尚未決定時才會真的詢問', async () => {
    let asked = 0;
    install(ok({
      getPermissionState: async () => 'not_determined',
      requestPermission: async () => { asked += 1; return 'authorized'; },
    }));
    expect(await requestPermission()).toBe('authorized');
    expect(asked).toBe(1);
  });

  it('未授權時不讀任何行事曆資料', async () => {
    let read = 0;
    install(ok({
      getPermissionState: async () => 'not_determined',
      getBusyIntervals: async () => { read += 1; return []; },
    }));
    expect(await getBusyIntervals(RANGE)).toEqual([]);
    expect(read).toBe(0);
  });

  it('原生層丟例外時退回安全值，不讓畫面壞掉', async () => {
    install(ok({ getPermissionState: async () => { throw new Error('x'); } }));
    expect(await getPermissionState()).toBe('unsupported');
    install(ok({ listCalendars: async () => { throw new Error('x'); } }));
    expect(await listCalendars()).toEqual([]);
  });
});

describe('忙碌時段', () => {
  it('只帶出時間與來源——標題、地點、與會者一律不外流', async () => {
    install(ok({
      getBusyIntervals: async () => ([{
        start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z',
        title: '祕密會議', location: '台北', attendees: ['a@b.c'], notes: 'x',
      }]),
    }));
    const out = await getBusyIntervals(RANGE);
    expect(out).toEqual([{ start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z', source: 'apple' }]);
    expect(Object.keys(out[0])).toEqual(['start_at', 'end_at', 'source']);
  });

  it('標成 free / transparent 的事件不算忙碌', async () => {
    install(ok({
      getBusyIntervals: async () => ([
        { start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z', availability: 'free' },
        { start_at: '2026-09-10T03:00:00Z', end_at: '2026-09-10T04:00:00Z', busy: false },
        { start_at: '2026-09-10T05:00:00Z', end_at: '2026-09-10T06:00:00Z' },
      ]),
    }));
    const out = await getBusyIntervals(RANGE);
    expect(out.length).toBe(1);
    expect(out[0].start_at).toBe('2026-09-10T05:00:00Z');
  });

  it('壞掉的區間被濾掉，不會送出去汙染排程', async () => {
    install(ok({
      getBusyIntervals: async () => ([
        { start_at: '2026-09-10T05:00:00Z', end_at: '2026-09-10T04:00:00Z' },
        { start_at: null, end_at: '2026-09-10T04:00:00Z' },
        { start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z' },
      ]),
    }));
    expect((await getBusyIntervals(RANGE)).length).toBe(1);
  });

  it('讀取失敗時當作沒有裝置行事曆，不擋住排程', async () => {
    install(ok({ getBusyIntervals: async () => { throw new Error('boom'); } }));
    expect(await getBusyIntervals(RANGE)).toEqual([]);
  });
});

describe('介面沒有任何寫入能力', () => {
  it('模組不呼叫任何新增／修改／刪除事件的方法', async () => {
    const fs = await import('node:fs');
    const code = fs.readFileSync('src/tt/calendarBusy.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [/createEvent/i, /saveEvent/i, /removeEvent/i, /deleteEvent/i, /updateEvent/i, /\bwrite\b/i]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
