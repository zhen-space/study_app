// 番茄鐘面板接進 Study Session UI 的串接測試（v1：三相位 + cycle progress + 設定）。
//
// 要證明的是「真的接上既有 StudySession」：相位切換走既有 PATCH /study-sessions/:id
// （跟使用者自己按暫停同一條路）、不會產生第二個 session、倒數歸零不會完成任何東西。
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const PomodoroPanel = (await import('../tt/PomodoroPanel')).default;

const SID = 7;
const live = (status = 'running') => ({ id: SID, status, actual_minutes: 3, started_at: '2026-09-01T00:00:00Z' });

beforeEach(() => {
  api.mockReset();
  try { localStorage.clear(); } catch {}
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

// 靜態 session：只看畫面/相位，不看動作序列
const harness = (session = live()) => {
  const actions = [];
  render(<PomodoroPanel session={session} onSessionAction={a => { actions.push(a); }} />);
  return actions;
};

// 有狀態 session：套用 pause/resume 後 session.status 會跟著變並重繪——貼近真實 StudyView，
// 才能正確驗 net 動作序列（休息→暫停、專注→繼續）。
let actions;
function Stateful({ start = live() }) {
  const [session, setSession] = useState(start);
  return <PomodoroPanel session={session} onSessionAction={a => {
    actions.push(a);
    setSession(s => ({ ...s, status: a === 'pause' ? 'paused' : 'running' }));
  }} />;
}

describe('番茄鐘面板', () => {
  it('沒有進行中的讀書就不顯示', () => {
    render(<PomodoroPanel session={null} onSessionAction={() => {}} />);
    expect(screen.queryByText(/番茄鐘/)).toBeNull();
    render(<PomodoroPanel session={{ id: SID, status: 'completed' }} onSessionAction={() => {}} />);
    expect(screen.queryByText('開始番茄鐘')).toBeNull();
  });

  it('有進行中的讀書時提供開始，說明休息不算讀書時間，並有設定入口', () => {
    harness();
    expect(screen.getByText('開始番茄鐘')).toBeTruthy();
    expect(screen.getByText(/休息時間不算進讀書時間/)).toBeTruthy();
    expect(screen.getByText('設定')).toBeTruthy();
  });

  it('開始之後顯示倒數與 cycle progress，且不呼叫任何 API——不會產生第二個 session', () => {
    const acts = harness();
    fireEvent.click(screen.getByText('開始番茄鐘'));
    expect(screen.getByText(/專注中/)).toBeTruthy();
    expect(screen.getByText(/專注 1 \/ 4/)).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
    expect(acts).toEqual([]);
  });

  it('專注歸零 → 進短休息，並要求暫停既有的 StudySession', async () => {
    actions = [];
    render(<Stateful />);
    fireEvent.click(screen.getByText('開始番茄鐘'));
    await act(async () => { vi.advanceTimersByTime(25 * 60_000 + 1500); });
    await waitFor(() => expect(actions).toEqual(['pause']));
    expect(screen.getByText(/短休息中/)).toBeTruthy();
  });

  it('短休息歸零 → 回專注，要求繼續同一個 StudySession（不是新的）', async () => {
    actions = [];
    render(<Stateful />);
    fireEvent.click(screen.getByText('開始番茄鐘'));
    await act(async () => { vi.advanceTimersByTime(25 * 60_000 + 1500); });
    await waitFor(() => expect(actions).toEqual(['pause']));
    await act(async () => { vi.advanceTimersByTime(5 * 60_000 + 1500); });
    await waitFor(() => expect(actions).toEqual(['pause', 'resume']));
    expect(screen.getByText(/專注中/)).toBeTruthy();
  });

  it('每 4 輪進一次長休息（用小設定快速到達）', async () => {
    // 種一份小設定：專注 1 分、休息 1 分、每 2 輪長休息 → 兩個專注後進長休息
    localStorage.setItem('pomodoro_prefs', JSON.stringify({ focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, cycles_before_long_break: 2 }));
    actions = [];
    render(<Stateful />);
    fireEvent.click(screen.getByText('開始番茄鐘'));
    await act(async () => { vi.advanceTimersByTime(3 * 60_000 + 1500); });   // 跨過 focus1 + sb + focus2
    await waitFor(() => expect(screen.getByText(/長休息中/)).toBeTruthy());
  });

  it('相位切換永遠不會結束 StudySession（只會 pause / resume）', async () => {
    localStorage.setItem('pomodoro_prefs', JSON.stringify({ focus_minutes: 1, short_break_minutes: 1, long_break_minutes: 1, cycles_before_long_break: 2 }));
    actions = [];
    render(<Stateful />);
    fireEvent.click(screen.getByText('開始番茄鐘'));
    await act(async () => { vi.advanceTimersByTime(60_000 + 1500); });
    await waitFor(() => expect(actions).toContain('pause'));
    await act(async () => { vi.advanceTimersByTime(60_000 + 1500); });
    await waitFor(() => expect(actions).toContain('resume'));
    expect(actions).not.toContain('stop');
    expect(actions).not.toContain('completed');
    expect(actions.every(a => a === 'pause' || a === 'resume')).toBe(true);
  });

  it('番茄鐘自己暫停不影響 StudySession', () => {
    const acts = harness();
    fireEvent.click(screen.getByText('開始番茄鐘'));
    fireEvent.click(screen.getByText('暫停番茄鐘'));
    expect(acts).toEqual([]);
    expect(screen.getByText('繼續')).toBeTruthy();
  });

  it('改設定不會重啟目前正在跑的相位（相位與進度不變）', () => {
    harness();
    fireEvent.click(screen.getByText('開始番茄鐘'));
    expect(screen.getByText(/專注中/)).toBeTruthy();
    expect(screen.getByText(/專注 1 \/ 4/)).toBeTruthy();
    fireEvent.click(screen.getByText('設定'));
    fireEvent.change(screen.getByLabelText('專注（分）'), { target: { value: '50' } });
    // 改設定不會把目前這段重啟（仍是專注中、進度仍是 1 / 4）；新長度只影響下一段
    expect(screen.getByText(/專注中/)).toBeTruthy();
    expect(screen.getByText(/專注 1 \/ 4/)).toBeTruthy();
  });

  it('狀態指向已結束的 session 時直接丟掉，不讓它看起來還在跑', async () => {
    const acts = [];
    const { rerender } = render(<PomodoroPanel session={live()} onSessionAction={a => acts.push(a)} />);
    fireEvent.click(screen.getByText('開始番茄鐘'));
    expect(screen.getByText(/專注中/)).toBeTruthy();
    rerender(<PomodoroPanel session={{ id: SID, status: 'completed' }} onSessionAction={a => acts.push(a)} />);
    await waitFor(() => expect(screen.queryByText(/專注中/)).toBeNull());
    expect(acts).toEqual([]);
  });

  it('倒數歸零不會呼叫任何完成 Task／教材／Plan 的 API', async () => {
    harness();
    fireEvent.click(screen.getByText('開始番茄鐘'));
    await act(async () => { vi.advanceTimersByTime(30 * 60_000); });
    const paths = api.mock.calls.map(([p]) => p);
    for (const forbidden of ['/tasks', '/material', '/plans', '/schedule']) {
      expect(paths.some(p => String(p).startsWith(forbidden))).toBe(false);
    }
  });
});
