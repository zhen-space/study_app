import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { today } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

const habit = (over = {}) => ({
  id: 7, name: '背單字', icon: '📘', miss_policy: 'skip', checkins: [], ...over,
});
const checkinCalls = () => api.mock.calls.filter(([path]) => path === '/habits/7/checkin');
// 只讓下一次打卡失敗（mount 時 MemoCard 也會呼叫 api，不能用 mockRejectedValueOnce）
function failNextCheckin(error) {
  const base = api.getMockImplementation();
  let failed = false;
  api.mockImplementation((path, options) => {
    if (!failed && path.includes('/checkin')) { failed = true; return Promise.reject(error); }
    return base(path, options);
  });
}
const box = () => screen.getByRole('checkbox', { name: '背單字 今日打卡' });

function mount(habits = [habit()], reload = vi.fn().mockResolvedValue(undefined)) {
  render(<Tasks view={{ type: 'today' }} tasks={[]} lists={[]} filters={[]}
    habits={habits} reload={reload} title="今天" />);
  return reload;
}

describe('Today 今日習慣打卡的寫入／刷新邊界', () => {
  beforeEach(() => {
    localStorage.clear();
    api.mockReset();
    // Today 頁的 MemoCard 也會讀 /memos，要回陣列
    api.mockImplementation(path => Promise.resolve(path.includes('/checkin') ? { ok: true, earned: 5 } : []));
  });

  it('打卡成功後整包重新載入（習慣不在 tasks scope 內），不把 API 回應當成 scope', async () => {
    const reload = mount();

    fireEvent.click(box());

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledWith();
    expect(checkinCalls()).toEqual([['/habits/7/checkin', { method: 'POST', body: { date: today(), undo: false } }]]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(box()).not.toBeDisabled());
  });

  it('已打卡時點擊送出取消（undo: true）', async () => {
    const reload = mount([habit({ checkins: [today()] })]);
    expect(box()).toBeChecked();

    fireEvent.click(box());

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(checkinCalls()[0][1].body).toEqual({ date: today(), undo: true });
  });

  it('打卡寫入失敗時明確顯示錯誤、不刷新、不產生未處理的 rejection，之後可再試', async () => {
    failNextCheckin(new Error('網路連線中斷'));
    const reload = mount();

    fireEvent.click(box());

    expect(await screen.findByRole('alert')).toHaveTextContent('網路連線中斷');
    expect(reload).not.toHaveBeenCalled();
    expect(box()).not.toBeChecked();
    await waitFor(() => expect(box()).not.toBeDisabled());

    fireEvent.click(box());
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(checkinCalls()).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('沒有錯誤訊息的寫入失敗退回預設繁中提示', async () => {
    failNextCheckin(new Error(''));
    mount();

    fireEvent.click(box());

    expect(await screen.findByRole('alert')).toHaveTextContent('打卡沒有儲存成功，請再試一次。');
  });

  it('打卡已寫入但刷新失敗時，不誤報成打卡失敗，且重試只重新載入、不重送打卡', async () => {
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error('刷新失敗'))
      .mockResolvedValue(undefined);
    mount([habit()], reload);

    fireEvent.click(box());

    expect(await screen.findByRole('alert')).toHaveTextContent('已打卡，但畫面暫時無法重新載入。');
    expect(checkinCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(reload).toHaveBeenCalledTimes(2);
    expect(checkinCalls()).toHaveLength(1);
  });

  it('取消打卡已寫入但刷新失敗時，提示的是取消而不是打卡', async () => {
    const reload = vi.fn().mockRejectedValueOnce(new Error('刷新失敗'));
    mount([habit({ checkins: [today()] })], reload);

    fireEvent.click(box());

    expect(await screen.findByRole('alert')).toHaveTextContent('已取消打卡，但畫面暫時無法重新載入。');
    expect(checkinCalls()).toHaveLength(1);
  });

  it('寫入或刷新尚未結束前，用舊畫面狀態連點不會再送一次打卡', async () => {
    let resolveWrite;
    let reentered = false;
    api.mockImplementation(path => {
      if (path !== '/habits/7/checkin') return Promise.resolve([]);
      // 同一個事件循環內再點一次：此時 React 還沒重繪 disabled，只能靠同步鎖擋下
      if (!reentered) { reentered = true; fireEvent.click(box()); }
      return new Promise(resolve => { resolveWrite = resolve; });
    });
    let resolveReload;
    const reload = vi.fn(() => new Promise(resolve => { resolveReload = resolve; }));
    mount([habit()], reload);

    fireEvent.click(box());
    expect(checkinCalls()).toHaveLength(1);
    expect(box()).toBeDisabled();

    await act(async () => { resolveWrite({ ok: true }); });
    expect(reload).toHaveBeenCalledTimes(1);
    // 寫入完成但刷新還沒回來：畫面仍是「未打卡」，依然要擋
    expect(box()).toBeDisabled();
    expect(checkinCalls()).toHaveLength(1);

    await act(async () => { resolveReload(); });
    expect(box()).not.toBeDisabled();
  });

  it('每個習慣各自上鎖，一個在處理中不影響另一個', async () => {
    let resolveWrite;
    api.mockImplementation(path => path === '/habits/7/checkin'
      ? new Promise(resolve => { resolveWrite = resolve; })
      : Promise.resolve(path.includes('/checkin') ? { ok: true } : []));
    const reload = mount([habit(), habit({ id: 8, name: '跑步', icon: '🏃' })]);

    fireEvent.click(box());
    const other = screen.getByRole('checkbox', { name: '跑步 今日打卡' });
    expect(other).not.toBeDisabled();
    fireEvent.click(other);

    await waitFor(() => expect(api.mock.calls.filter(([p]) => p === '/habits/8/checkin')).toHaveLength(1));
    await act(async () => { resolveWrite({ ok: true }); });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });
});
