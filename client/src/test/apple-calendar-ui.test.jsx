// Apple Calendar 設定卡 UX ＋ 排程 request 串接（rolling / normal 同一條 seam）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const AppleCalendarCard = (await import('../tt/AppleCalendarCard')).default;
const RollingExamSchedule = (await import('../tt/RollingExamSchedule')).default;

const install = impl => { globalThis.StudyAppCalendar = impl; };
const bridge = (over = {}) => ({
  getPermissionState: async () => 'authorized',
  requestPermission: async () => 'authorized',
  listCalendars: async () => [{ id: 'c1', title: '個人' }, { id: 'c2', title: '工作' }],
  getBusyIntervals: async () => ([{ start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z' }]),
  ...over,
});

beforeEach(() => { api.mockReset(); try { localStorage.clear(); } catch {} });
afterEach(() => { delete globalThis.StudyAppCalendar; });

describe('AppleCalendarCard 權限生命週期 / 選取 UI', () => {
  it('Q. web/PWA（無原生層）→ 明確顯示只支援 iPhone/iPad，不假裝可連', async () => {
    render(<AppleCalendarCard />);
    expect(await screen.findByText(/只支援 iPhone \/ iPad App/)).toBeTruthy();
    expect(screen.queryByText('允許 Apple 行事曆存取')).toBeNull();
    expect(screen.queryByText(/已授權/)).toBeNull();
  });

  it('not_determined → 顯示 CTA；按下請求後變已授權並列出行事曆', async () => {
    let perm = 'not_determined';
    install(bridge({ getPermissionState: async () => perm, requestPermission: async () => { perm = 'authorized'; return 'authorized'; } }));
    render(<AppleCalendarCard />);
    const cta = await screen.findByText('允許 Apple 行事曆存取');
    fireEvent.click(cta);
    await waitFor(() => expect(screen.getByText('個人')).toBeTruthy());
    expect(screen.getByText('工作')).toBeTruthy();
  });

  it('denied → 顯示需到系統設定開啟；不列行事曆', async () => {
    install(bridge({ getPermissionState: async () => 'denied' }));
    render(<AppleCalendarCard />);
    expect(await screen.findByText(/系統「設定 → 隱私權 → 行事曆」/)).toBeTruthy();
  });

  it('restricted → 顯示受限', async () => {
    install(bridge({ getPermissionState: async () => 'restricted' }));
    render(<AppleCalendarCard />);
    expect(await screen.findByText(/螢幕使用時間／MDM/)).toBeTruthy();
  });

  it('authorized → 勾選行事曆會存進本機（只存 id）', async () => {
    install(bridge());
    render(<AppleCalendarCard />);
    const cb = await screen.findByLabelText('工作');
    fireEvent.click(cb);
    await waitFor(() => expect(JSON.parse(localStorage.getItem('apple_calendar_selected_ids') || '[]')).toEqual(['c2']));
  });

  it('listCalendars 回空 → 顯示沒有可用的行事曆', async () => {
    install(bridge({ listCalendars: async () => [] }));
    render(<AppleCalendarCard />);
    expect(await screen.findByText('沒有可用的行事曆。')).toBeTruthy();
  });

  it('J(UI). 曾授權、之後撤銷 → 進設定重讀為 denied，不再顯示已授權', async () => {
    // 先種一個選取，之後撤銷權限，卡片不得繼續顯示 authorized 的行事曆清單
    localStorage.setItem('apple_calendar_selected_ids', JSON.stringify(['c1']));
    install(bridge({ getPermissionState: async () => 'denied' }));
    render(<AppleCalendarCard />);
    expect(await screen.findByText(/系統「設定 → 隱私權 → 行事曆」/)).toBeTruthy();
    expect(screen.queryByLabelText('個人')).toBeNull();
  });
});

describe('排程 request 串接（rolling preview 帶 external_busy）', () => {
  const preview = { window: { freeze_start: '9/1', freeze_through: '9/2', rolling_start: '9/3' }, diff: { items: [] }, frozen: [], movable: [], infeasible: null };
  const bodyOf = path => {
    const call = api.mock.calls.find(([p]) => p === path);
    return call ? call[1].body : null;
  };

  it('N. authorized + 有選 + 有 scheduleEnd → rolling preview 帶 external_busy', async () => {
    install(bridge());
    localStorage.setItem('apple_calendar_selected_ids', JSON.stringify(['c1']));
    api.mockImplementation(async () => preview);
    render(<RollingExamSchedule planId={5} scheduleEnd="2026-10-01" onClose={() => {}} onApplied={async () => {}} />);
    await waitFor(() => expect(bodyOf('/schedule/rolling/preview')).toBeTruthy());
    const body = bodyOf('/schedule/rolling/preview');
    expect(body.plan_id).toBe(5);
    expect(body.external_busy).toEqual([{ start_at: '2026-09-10T01:00:00Z', end_at: '2026-09-10T02:00:00Z', source: 'apple' }]);
  });

  it('M. web/PWA（unsupported）→ rolling preview 不帶 external_busy，排程照常', async () => {
    api.mockImplementation(async () => preview);
    render(<RollingExamSchedule planId={5} scheduleEnd="2026-10-01" onClose={() => {}} onApplied={async () => {}} />);
    await waitFor(() => expect(bodyOf('/schedule/rolling/preview')).toBeTruthy());
    expect(bodyOf('/schedule/rolling/preview').external_busy).toBeUndefined();
  });

  it('沒有 scheduleEnd（拿不到範圍）→ 不帶 external_busy', async () => {
    install(bridge());
    localStorage.setItem('apple_calendar_selected_ids', JSON.stringify(['c1']));
    api.mockImplementation(async () => preview);
    render(<RollingExamSchedule planId={5} scheduleEnd={null} onClose={() => {}} onApplied={async () => {}} />);
    await waitFor(() => expect(bodyOf('/schedule/rolling/preview')).toBeTruthy());
    expect(bodyOf('/schedule/rolling/preview').external_busy).toBeUndefined();
  });
});
