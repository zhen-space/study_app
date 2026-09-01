// 番茄鐘接進 Study Session UI 的串接測試。
//
// 要證明的是「真的接上既有 StudySession」，不是模組寫好了：
//   ・相位切換走的是既有的 PATCH /study-sessions/:id（跟使用者自己按暫停同一條路）
//   ・不會產生第二個 session
//   ・倒數歸零不會完成 Task／教材／Plan，也不會結束 StudySession
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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

// 記錄面板要求外層對 StudySession 做的動作
const harness = (session = live()) => {
  const actions = [];
  render(<PomodoroPanel session={session} onSessionAction={a => { actions.push(a); }} />);
  return actions;
};

describe('番茄鐘面板', () => {
  it('沒有進行中的讀書就不顯示', () => {
    render(<PomodoroPanel session={null} onSessionAction={() => {}} />);
    expect(screen.queryByText(/番茄鐘/)).toBeNull();
    render(<PomodoroPanel session={{ id: SID, status: 'completed' }} onSessionAction={() => {}} />);
    expect(screen.queryByText('開始番茄鐘')).toBeNull();
  });

  it('有進行中的讀書時提供開始，並說明休息不算讀書時間', () => {
    harness();
    expect(screen.getByText('開始番茄鐘')).toBeTruthy();
    expect(screen.getByText(/休息時間不算進讀書時間/)).toBeTruthy();
  });

  it('開始之後顯示倒數，且不呼叫任何 API——不會產生第二個 session', () => {
    const actions = harness();
    fireEvent.click(screen.getByText('開始番茄鐘'));
    expect(screen.getByText(/專注中/)).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
  });

  it('專注歸零 → 進休息，並要求暫停既有的 StudySession', async () => {
    const actions = harness();
    fireEvent.click(screen.getByText('開始番茄鐘'));
    await act(async () => { vi.advanceTimersByTime(25 * 60_000 + 1500); });
    await waitFor(() => expect(actions).toEqual(['pause']));
    expect(screen.getByText(/休息中/)).toBeTruthy();
  });

  it('休息歸零 → 回到專注，並要求繼續同一個 StudySession（不是新的）', async () => {
    const actions = harness();
    fireEvent.click(screen.getByText('開始番茄鐘'));
    await act(async () => { vi.advanceTimersByTime(25 * 60_000 + 1500); });
    await waitFor(() => expect(actions).toEqual(['pause']));
    await act(async () => { vi.advanceTimersByTime(5 * 60_000 + 1500); });
    await waitFor(() => expect(actions).toEqual(['pause', 'resume']));
    expect(screen.getByText(/專注中/)).toBeTruthy();
  });

  it('相位切換永遠不會結束 StudySession', async () => {
    const actions = harness();
    fireEvent.click(screen.getByText('開始番茄鐘'));
    await act(async () => { vi.advanceTimersByTime(60 * 60_000); });
    await waitFor(() => expect(actions.length).toBeGreaterThan(0));
    expect(actions).not.toContain('stop');
    expect(actions).not.toContain('completed');
    expect(actions.every(a => a === 'pause' || a === 'resume')).toBe(true);
  });

  it('番茄鐘自己暫停不影響 StudySession', () => {
    const actions = harness();
    fireEvent.click(screen.getByText('開始番茄鐘'));
    fireEvent.click(screen.getByText('暫停番茄鐘'));
    expect(actions).toEqual([], '番茄鐘的暫停是顯示層的事，不動 StudySession');
    expect(screen.getByText('繼續')).toBeTruthy();
  });

  it('狀態指向已結束的 session 時直接丟掉，不讓它看起來還在跑', async () => {
    const actions = [];
    const { rerender } = render(
      <PomodoroPanel session={live()} onSessionAction={a => actions.push(a)} />);
    fireEvent.click(screen.getByText('開始番茄鐘'));
    expect(screen.getByText(/專注中/)).toBeTruthy();
    // 使用者按了「完成本次讀書」：同一個面板收到已結束的 session
    rerender(<PomodoroPanel session={{ id: SID, status: 'completed' }} onSessionAction={a => actions.push(a)} />);
    await waitFor(() => expect(screen.queryByText(/專注中/)).toBeNull());
    expect(actions).toEqual([], '丟掉陳舊狀態不該對 StudySession 下任何指令');
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
