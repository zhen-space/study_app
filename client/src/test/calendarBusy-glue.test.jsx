// Apple Calendar JS glue：把 device busy 接進排程 request 的邊界行為。
//
// 釘住的重點：web/PWA 一律 no-op；只有 supported + authorized + 有選行事曆才送；
// 送出去的永遠只有 start/end/source，選取只存本機、壞資料安全正規化、已刪除的 id 剔除。
import { describe, it, expect, afterEach } from 'vitest';
import {
  fetchExternalBusy, loadSelectedCalendarIds, saveSelectedCalendarIds, pruneSelectedCalendarIds, dayRangeToIso,
} from '../tt/calendarBusy';

const RANGE = { startDate: '2026-09-10', endDate: '2026-09-17' };

// 記憶體版 localStorage
const mem = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
};

const install = impl => { globalThis.StudyAppCalendar = impl; };
afterEach(() => { delete globalThis.StudyAppCalendar; });

const bridge = (over = {}) => ({
  getPermissionState: async () => 'authorized',
  requestPermission: async () => 'authorized',
  listCalendars: async () => [{ id: 'c1', title: '個人' }, { id: 'c2', title: '工作' }],
  getBusyIntervals: async () => ([{ start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z' }]),
  ...over,
});

describe('選取行事曆的本機持久化', () => {
  it('H. 壞掉的 localStorage 安全正規化成空選取', () => {
    expect(loadSelectedCalendarIds(mem({ apple_calendar_selected_ids: '{壞的' }))).toEqual([]);
    expect(loadSelectedCalendarIds(mem({ apple_calendar_selected_ids: '{"not":"array"}' }))).toEqual([]);
    expect(loadSelectedCalendarIds(mem())).toEqual([]);
  });

  it('存取往返；去重、去空白', () => {
    const st = mem();
    saveSelectedCalendarIds([' c1 ', 'c1', '', 'c2'], st);
    expect(loadSelectedCalendarIds(st)).toEqual(['c1', 'c2']);
  });

  it('I. 已刪除／不存在的行事曆 id 從選取中剔除', () => {
    const st = mem({ apple_calendar_selected_ids: JSON.stringify(['c1', 'ghost', 'c2']) });
    const kept = pruneSelectedCalendarIds([{ id: 'c1' }, { id: 'c2' }], st);
    expect(kept).toEqual(['c1', 'c2']);
    expect(loadSelectedCalendarIds(st)).toEqual(['c1', 'c2']);
  });

  it('選取只含 id，永遠不含任何事件內容', () => {
    const st = mem();
    saveSelectedCalendarIds(['c1'], st);
    const raw = JSON.parse(st.getItem('apple_calendar_selected_ids'));
    expect(raw).toEqual(['c1']);
  });

  it('日期範圍換成台灣日界的 ISO 邊界', () => {
    expect(dayRangeToIso('2026-09-10', '2026-09-17')).toEqual({
      startISO: '2026-09-10T00:00:00+08:00', endISO: '2026-09-17T23:59:59+08:00',
    });
  });
});

describe('fetchExternalBusy：只有 supported + authorized + 有選才送', () => {
  it('A. unsupported（web/PWA）→ 不送 external_busy，排程照常', async () => {
    const r = await fetchExternalBusy(RANGE, mem({ apple_calendar_selected_ids: '["c1"]' }));
    expect(r).toEqual({ external_busy: null, status: 'unsupported' });
  });

  it('B. not_determined → 不送', async () => {
    install(bridge({ getPermissionState: async () => 'not_determined' }));
    const r = await fetchExternalBusy(RANGE, mem({ apple_calendar_selected_ids: '["c1"]' }));
    expect(r.external_busy).toBe(null);
    expect(r.status).toBe('not_determined');
  });

  it('C. denied → 不送', async () => {
    install(bridge({ getPermissionState: async () => 'denied' }));
    const r = await fetchExternalBusy(RANGE, mem({ apple_calendar_selected_ids: '["c1"]' }));
    expect(r.external_busy).toBe(null);
    expect(r.status).toBe('denied');
  });

  it('D. restricted → 不送', async () => {
    install(bridge({ getPermissionState: async () => 'restricted' }));
    const r = await fetchExternalBusy(RANGE, mem({ apple_calendar_selected_ids: '["c1"]' }));
    expect(r.external_busy).toBe(null);
    expect(r.status).toBe('restricted');
  });

  it('E. authorized + 有選 → external_busy 帶著 apple 區間', async () => {
    install(bridge());
    const r = await fetchExternalBusy(RANGE, mem({ apple_calendar_selected_ids: '["c1"]' }));
    expect(r.status).toBe('active');
    expect(r.external_busy).toEqual([{ start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z', source: 'apple' }]);
  });

  it('F. authorized 但沒選任何行事曆 → 不送', async () => {
    install(bridge());
    const r = await fetchExternalBusy(RANGE, mem({ apple_calendar_selected_ids: '[]' }));
    expect(r).toEqual({ external_busy: null, status: 'no_selection' });
  });

  it('G. 多選行事曆 → id 全部傳給原生層', async () => {
    let got = null;
    install(bridge({ getBusyIntervals: async ({ calendarIds }) => { got = calendarIds; return []; } }));
    await fetchExternalBusy(RANGE, mem({ apple_calendar_selected_ids: '["c1","c2"]' }));
    expect(got).toEqual(['c1', 'c2']);
  });

  it('J. 曾授權、之後被撤銷 → 重新讀到 denied，不再送 device busy', async () => {
    let perm = 'authorized';
    install(bridge({ getPermissionState: async () => perm }));
    const st = mem({ apple_calendar_selected_ids: '["c1"]' });
    expect((await fetchExternalBusy(RANGE, st)).status).toBe('active');
    perm = 'denied';                                   // 使用者到系統設定關掉
    const after = await fetchExternalBusy(RANGE, st);
    expect(after.external_busy).toBe(null);
    expect(after.status).toBe('denied');
  });

  it('K. 原生層讀取忙碌失敗 → 優雅降級（不丟例外、無 stale、排程照常）', async () => {
    install(bridge({ getBusyIntervals: async () => { throw new Error('boom'); } }));
    const r = await fetchExternalBusy(RANGE, mem({ apple_calendar_selected_ids: '["c1"]' }));
    // getBusyIntervals 內部已 fail-safe 成 []，這裡不 crash、不留任何快取
    expect(Array.isArray(r.external_busy) ? r.external_busy : []).toEqual([]);
  });

  it('L. 送出去的區間永遠只有 start_at / end_at / source，沒有標題等內容', async () => {
    install(bridge({
      getBusyIntervals: async () => ([{
        start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z',
        title: '祕密', location: '台北', attendees: ['a@b'], id: 'evt-1', notes: 'x',
      }]),
    }));
    const r = await fetchExternalBusy(RANGE, mem({ apple_calendar_selected_ids: '["c1"]' }));
    expect(Object.keys(r.external_busy[0])).toEqual(['start_at', 'end_at', 'source']);
    expect(r.external_busy[0].source).toBe('apple');
  });
});
