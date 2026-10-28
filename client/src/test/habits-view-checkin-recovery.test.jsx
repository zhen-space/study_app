import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const HabitsView = (await import('../tt/HabitsView')).default;

const habit = (over = {}) => ({
  id: 7, name: '背單字', icon: '📘', color: '#16a34a', category: '', miss_policy: 'keep', checkins: [], ...over,
});
const checkinCalls = (id = 7) => api.mock.calls.filter(([path]) => path === `/habits/${id}/checkin`);
// 打卡圓點以日期為 title；多個習慣時依畫面順序取第 n 個
const dot = (date, n = 0) => screen.getAllByTitle(date)[n];

function mount(habits = [habit()], reload = vi.fn().mockResolvedValue(undefined)) {
  render(<HabitsView habits={habits} reload={reload} />);
  return reload;
}

describe('習慣頁打卡／補卡／取消的寫入／刷新邊界', () => {
  beforeEach(() => {
    api.mockReset();
    api.mockResolvedValue({ ok: true, earned: 5 });
  });

  it('打卡成功後整包重新載入，不顯示錯誤', async () => {
    const reload = mount();

    fireEvent.click(dot(today()));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledWith();
    expect(checkinCalls()).toEqual([['/habits/7/checkin', { method: 'POST', body: { date: today(), undo: false } }]]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(dot(today())).toHaveAttribute('aria-busy', 'false'));
  });

  it('點已打卡的日子送出取消（undo: true），點過去的日子是補卡', async () => {
    const past = addDays(today(), -2);
    const reload = mount([habit({ checkins: [today()] })]);

    fireEvent.click(dot(today()));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    fireEvent.click(dot(past));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));

    expect(checkinCalls().map(([, o]) => o.body)).toEqual([
      { date: today(), undo: true },
      { date: past, undo: false },
    ]);
  });

  it('未來的日子不能打卡', () => {
    const reload = mount();

    fireEvent.click(dot(addDays(today(), 1)));

    expect(checkinCalls()).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it('寫入失敗時明確顯示錯誤、不刷新、不產生未處理的 rejection，之後可再試', async () => {
    api.mockRejectedValueOnce(new Error('網路連線中斷'));
    const reload = mount();

    fireEvent.click(dot(today()));

    expect(await screen.findByRole('alert')).toHaveTextContent('網路連線中斷');
    expect(reload).not.toHaveBeenCalled();
    await waitFor(() => expect(dot(today())).toHaveAttribute('aria-busy', 'false'));

    fireEvent.click(dot(today()));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(checkinCalls()).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('沒有錯誤訊息的寫入失敗退回預設繁中提示', async () => {
    api.mockRejectedValueOnce(new Error(''));
    mount();

    fireEvent.click(dot(today()));

    expect(await screen.findByRole('alert')).toHaveTextContent('打卡沒有儲存成功，請再試一次。');
  });

  it('打卡已寫入但刷新失敗時，不誤報成打卡失敗，且重試只重新載入、不重送打卡', async () => {
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error('刷新失敗'))
      .mockResolvedValue(undefined);
    mount([habit()], reload);

    fireEvent.click(dot(today()));

    expect(await screen.findByRole('alert')).toHaveTextContent('已打卡，但畫面暫時無法重新載入。');
    expect(checkinCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenLastCalledWith();
    expect(checkinCalls()).toHaveLength(1);
  });

  it('重試刷新仍失敗時保留提示，且仍不重送打卡', async () => {
    const reload = vi.fn().mockRejectedValue(new Error('刷新失敗'));
    mount([habit()], reload);

    fireEvent.click(dot(today()));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('仍然無法重新載入，請稍後再試。'));
    expect(screen.getByRole('button', { name: '重新載入' })).not.toBeDisabled();
    expect(checkinCalls()).toHaveLength(1);
  });

  it('補卡／取消已寫入但刷新失敗時，提示對應實際動作', async () => {
    const past = addDays(today(), -1);
    const reload = vi.fn().mockRejectedValue(new Error('刷新失敗'));
    mount([habit({ checkins: [today()] })], reload);

    fireEvent.click(dot(past));
    expect(await screen.findByRole('alert')).toHaveTextContent('已補卡，但畫面暫時無法重新載入。');
    await waitFor(() => expect(dot(today())).toHaveAttribute('aria-busy', 'false'));

    fireEvent.click(dot(today()));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已取消打卡，但畫面暫時無法重新載入。'));
    expect(checkinCalls().map(([, o]) => o.body.undo)).toEqual([false, true]);
  });

  it('寫入或刷新尚未結束前，用舊畫面狀態連點（含點同習慣其他日子）不會再送打卡', async () => {
    let resolveWrite;
    let reentered = false;
    api.mockImplementation(() => {
      // 同一個事件循環內再點一次：此時 React 還沒重繪，只能靠同步鎖擋下
      if (!reentered) { reentered = true; fireEvent.click(dot(today())); }
      return new Promise(resolve => { resolveWrite = resolve; });
    });
    let resolveReload;
    const reload = vi.fn(() => new Promise(resolve => { resolveReload = resolve; }));
    mount([habit()], reload);

    fireEvent.click(dot(today()));
    expect(checkinCalls()).toHaveLength(1);
    expect(dot(today())).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(dot(addDays(today(), -1)));
    expect(checkinCalls()).toHaveLength(1);

    await act(async () => { resolveWrite({ ok: true }); });
    expect(reload).toHaveBeenCalledTimes(1);
    // 寫入完成但刷新還沒回來：畫面仍是「未打卡」，依然要擋，否則會再送一次 undo:false
    fireEvent.click(dot(today()));
    expect(checkinCalls()).toHaveLength(1);

    await act(async () => { resolveReload(); });
    expect(dot(today())).toHaveAttribute('aria-busy', 'false');
  });

  it('每個習慣各自上鎖，一個在處理中不影響另一個', async () => {
    let resolveWrite;
    api.mockImplementation(path => path === '/habits/7/checkin'
      ? new Promise(resolve => { resolveWrite = resolve; })
      : Promise.resolve({ ok: true }));
    const reload = mount([habit(), habit({ id: 8, name: '跑步', icon: '🏃' })]);

    fireEvent.click(dot(today(), 0));
    expect(dot(today(), 1)).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(dot(today(), 1));

    await waitFor(() => expect(checkinCalls(8)).toHaveLength(1));
    await act(async () => { resolveWrite({ ok: true }); });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });
});
