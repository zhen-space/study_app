// 設定頁、主題、提醒。
//
// 這三樣的共同點是「壞掉不會有人發現」：主題套錯只是顏色怪、提醒沒送出去只是安靜，
// 兩者都不會丟例外。所以要測的是行為本身，不是「有沒有 render 出來」。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const theme = await import('../tt/theme');
const notifyMod = await import('../tt/notify');
const SettingsView = (await import('../tt/SettingsView')).default;

const TD = today();
let errors;
beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
  api.mockImplementation(path => {
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    return Promise.resolve([]);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const draw = async ui => { await act(async () => { render(ui); }); };

/* ---------------- 主題 ---------------- */

describe('主題', () => {
  it('預設是跟隨系統，而且刻意不寫 data-theme（寫了 prefers-color-scheme 就失效）', () => {
    expect(theme.getTheme()).toBe('system');
    theme.applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light dark');
  });

  it('選深色／淺色會掛上 data-theme，並讓原生控制項跟著換', () => {
    theme.setTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    theme.setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('選過的下次打開還在；切回跟隨系統要把屬性拿掉', () => {
    theme.setTheme('dark');
    expect(theme.getTheme()).toBe('dark');
    theme.setTheme('system');
    expect(theme.getTheme()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('localStorage 壞掉（隱私模式）不會讓主題整個炸掉', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('nope'); });
    expect(() => theme.setTheme('dark')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');  // 這次仍要生效
    spy.mockRestore();
  });
});

/* ---------------- 提醒 ---------------- */

describe('提醒', () => {
  const tasks = [
    { id: 1, title: '現在到期', due_date: TD, due_time: '09:00', completed: 0, deleted: 0 },
    { id: 2, title: '別的時間', due_date: TD, due_time: '18:00', completed: 0, deleted: 0 },
    { id: 3, title: '做完了', due_date: TD, due_time: '09:00', completed: 1, deleted: 0 },
    { id: 4, title: '欠著的', due_date: addDays(TD, -2), due_time: null, completed: 0, deleted: 0 },
  ];
  const blocks = [{ id: 9, date: TD, start_time: '09:10', end_time: '10:00', task_title_snapshot: '數學' }];
  const at = hm => new Date(`${TD}T${hm}:00`);

  it('到期時間那一分鐘才提醒，別的時間不吵', () => {
    const out = notifyMod.dueNotifications({ tasks, blocks: [], today: TD, now: at('09:00') });
    expect(out.filter(n => n.kind === 'due').map(n => n.body)).toEqual(['現在到期']);
    const quiet = notifyMod.dueNotifications({ tasks, blocks: [], today: TD, now: at('09:05') });
    expect(quiet.filter(n => n.kind === 'due')).toEqual([]);
  });

  it('已完成的不提醒', () => {
    const out = notifyMod.dueNotifications({ tasks, blocks: [], today: TD, now: at('09:00') });
    expect(out.map(n => n.body)).not.toContain('做完了');
  });

  it('讀書時段開始前 10 分鐘提醒一次', () => {
    const out = notifyMod.dueNotifications({ tasks: [], blocks, today: TD, now: at('09:00') });
    expect(out.map(n => n.kind)).toContain('upcoming');
    const early = notifyMod.dueNotifications({ tasks: [], blocks, today: TD, now: at('08:30') });
    expect(early.map(n => n.kind)).not.toContain('upcoming');
  });

  it('逾期提醒每天只出現一次（送過的不再重複）', () => {
    const first = notifyMod.dueNotifications({ tasks, blocks: [], today: TD, now: at('07:00') });
    const od = first.find(n => n.kind === 'overdue');
    expect(od.body).toContain('1 項');
    const again = notifyMod.dueNotifications({
      tasks, blocks: [], today: TD, now: at('07:30'), sent: new Set([od.key]),
    });
    expect(again.find(n => n.kind === 'overdue')).toBeUndefined();
  });

  it('在設定關掉某一類，那一類就完全不產生', () => {
    notifyMod.setNotifyPrefs({ due: false, upcoming: false, overdue: false });
    expect(notifyMod.dueNotifications({ tasks, blocks, today: TD, now: at('09:00') })).toEqual([]);
  });

  it('沒有通知權限時 notify() 安靜地回 false，不丟例外', () => {
    // 測試環境預設把權限 stub 成 granted，這裡要的是相反的情境
    const orig = Notification.permission;
    Notification.permission = 'denied';
    try {
      expect(() => notifyMod.notify('due', 'x', 'y')).not.toThrow();
      expect(notifyMod.notify('due', 'x', 'y')).toBe(false);
    } finally { Notification.permission = orig; }
  });

  it('權限給了、那一類也開著時才真的送出', () => {
    const sent = [];
    const orig = globalThis.Notification;
    globalThis.Notification = class { constructor(t, o) { sent.push([t, o?.body]); } static permission = 'granted'; };
    try {
      expect(notifyMod.notify('due', '任務提醒', '寫數學')).toBe(true);
      expect(sent).toEqual([['任務提醒', '寫數學']]);
      notifyMod.setNotifyPrefs({ ...notifyMod.getNotifyPrefs(), due: false });
      expect(notifyMod.notify('due', '任務提醒', '寫數學')).toBe(false);
      expect(sent).toHaveLength(1);
    } finally { globalThis.Notification = orig; }
  });
});

/* ---------------- 設定頁 ---------------- */

describe('設定頁', () => {
  it('切主題會立刻套用到 <html>', async () => {
    await draw(<SettingsView />);
    fireEvent.click(screen.getByRole('tab', { name: '深色' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(errors).toEqual([]);
  });

  it('作息時間讀得到、也存得回去（以前只能在排程精靈第 2 步裡改）', async () => {
    await draw(<SettingsView />);
    const start = await screen.findByLabelText('睡覺開始');
    expect(start.value).toBe(fx.settings.sleep_start);

    fireEvent.change(start, { target: { value: '22:30' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存作息' }));
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/settings', expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({ sleep_start: '22:30' }),
      }));
    });
    expect(errors).toEqual([]);
  });

  it('時間格式不對就擋下來，不送出一份壞掉的作息', async () => {
    await draw(<SettingsView />);
    const start = await screen.findByLabelText('睡覺開始');
    fireEvent.change(start, { target: { value: '25:99' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存作息' }));
    await screen.findByRole('alert');
    expect(api).not.toHaveBeenCalledWith('/settings', expect.objectContaining({ method: 'PUT' }));
  });

  it('提醒開關存得住，關掉之後 dueNotifications 真的不產生那一類', async () => {
    await draw(<SettingsView />);
    fireEvent.click(screen.getByLabelText('任務到期'));
    expect(notifyMod.getNotifyPrefs().due).toBe(false);
    const out = notifyMod.dueNotifications({
      tasks: [{ id: 1, title: 'x', due_date: TD, due_time: '09:00', completed: 0, deleted: 0 }],
      blocks: [], today: TD, now: new Date(`${TD}T09:00:00`),
    });
    expect(out.filter(n => n.kind === 'due')).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/* ---------------- 統計：今天／本週 ---------------- */

const stats = await import('../tt/StatsView');

describe('統計的今天／本週讀書時間', () => {
  it('只加總範圍內的日子，資料一律取自 actualByDay（不自己推估）', () => {
    const abd = { [addDays(TD, -9)]: 30, [addDays(TD, -1)]: 45, [TD]: 25 };
    expect(stats.studyMinutes(abd, TD, TD)).toBe(25);
    expect(stats.studyMinutes(abd, addDays(TD, -1), TD)).toBe(70);
    expect(stats.studyMinutes({}, TD, TD)).toBe(0);
    expect(stats.studyMinutes(undefined, TD, TD)).toBe(0);
  });

  it('本週從週一算起', () => {
    // 2026-08-26 是週三 → 該週的週一是 08-24
    expect(stats.weekStart('2026-08-26')).toBe('2026-08-24');
    // 週日要算成「上一個週一那一週」，不是隔天開始的新一週
    expect(stats.weekStart('2026-08-23')).toBe('2026-08-17');
    expect(stats.weekStart('2026-08-24')).toBe('2026-08-24');
  });

  it('壞掉的分鐘數不會讓整頁變成 NaN', () => {
    expect(stats.studyMinutes({ [TD]: null }, TD, TD)).toBe(0);
    expect(stats.studyMinutes({ [TD]: 'x' }, TD, TD)).toBe(0);
  });
});

/* ---------------- Google 日曆（唯讀） ---------------- */

const GoogleCalendarCard = (await import('../tt/GoogleCalendarCard')).default;

describe('Google 日曆連結', () => {
  const withStatus = (status, extra = {}) => {
    api.mockImplementation((path, opts) => {
      if (path === '/integrations/google-calendar/status') return Promise.resolve(status);
      if (extra[path]) return extra[path](opts);
      if (path in fx.responses) return Promise.resolve(fx.responses[path]);
      return Promise.resolve([]);
    });
  };

  it('講清楚只讀忙碌時段，不讀行程內容、也不會寫回 Google', async () => {
    withStatus({ connected: false, mode: 'read_only_busy', configured: true });
    await draw(<GoogleCalendarCard />);
    expect(await screen.findByText(/自動避開 Google Calendar 行程/)).toBeTruthy();
    expect(screen.getByText(/讀不到行程名稱/)).toBeTruthy();
    expect(screen.getByText(/不會在你的 Google 日曆上新增或修改/)).toBeTruthy();
  });

  it('未連結時給連結按鈕；已連結時給中斷連結', async () => {
    withStatus({ connected: false, mode: 'read_only_busy', configured: true });
    const { unmount } = render(<div />); unmount();
    await draw(<GoogleCalendarCard />);
    expect(await screen.findByRole('button', { name: /連結 Google 日曆/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '中斷連結' })).toBeNull();
  });

  it('伺服器沒啟用時不給一顆按了必定失敗的按鈕', async () => {
    withStatus({ connected: false, mode: 'read_only_busy', configured: false });
    await draw(<GoogleCalendarCard />);
    expect(await screen.findByText(/還沒在伺服器上啟用/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /連結 Google 日曆/ })).toBeNull();
  });

  it('中斷連結會打 DELETE，成功後回到未連結狀態', async () => {
    let connected = true;
    api.mockImplementation((path, opts) => {
      if (path === '/integrations/google-calendar/status') {
        return Promise.resolve(connected
          ? { connected: true, calendar: 'primary', mode: 'read_only_busy', last_success_at: null, configured: true }
          : { connected: false, mode: 'read_only_busy', configured: true });
      }
      if (path === '/integrations/google-calendar' && opts?.method === 'DELETE') {
        connected = false; return Promise.resolve({ connected: false });
      }
      if (path in fx.responses) return Promise.resolve(fx.responses[path]);
      return Promise.resolve([]);
    });
    await draw(<GoogleCalendarCard />);
    fireEvent.click(await screen.findByRole('button', { name: '中斷連結' }));
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/integrations/google-calendar', { method: 'DELETE' });
    });
    expect(await screen.findByRole('button', { name: /連結 Google 日曆/ })).toBeTruthy();
  });

  it('狀態讀不到時說得出來，不是一片空白', async () => {
    api.mockImplementation(path => {
      if (path === '/integrations/google-calendar/status') return Promise.reject(new Error('伺服器沒有回應'));
      if (path in fx.responses) return Promise.resolve(fx.responses[path]);
      return Promise.resolve([]);
    });
    await draw(<GoogleCalendarCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('伺服器沒有回應');
  });

  it('前端永遠不碰 token：狀態物件裡沒有任何 token 欄位就正常運作', async () => {
    withStatus({ connected: true, calendar: 'primary', mode: 'read_only_busy', last_success_at: '2026-09-01T01:00:00Z', configured: true });
    await draw(<GoogleCalendarCard />);
    expect(await screen.findByText(/已連結（主要日曆）/)).toBeTruthy();
    expect(errors).toEqual([]);
  });
});

describe('設定頁的時區說明', () => {
  it('說排程用台灣時間，不是「跟著裝置時區」', async () => {
    await draw(<SettingsView />);
    expect(await screen.findByText('排程時區')).toBeTruthy();
    expect(screen.getByText('Asia/Taipei')).toBeTruthy();
    expect(screen.queryByText(/日期與排程都照這個時區計算/)).toBeNull();
  });
});
