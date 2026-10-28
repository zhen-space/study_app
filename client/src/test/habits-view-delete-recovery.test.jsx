import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { today } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const HabitsView = (await import('../tt/HabitsView')).default;

const habit = (over = {}) => ({
  id: 7, name: '背單字', icon: '📘', color: '#16a34a', category: '', miss_policy: 'keep', checkins: [today()], ...over,
});
const deleteCalls = () => api.mock.calls.filter(([, o]) => o?.method === 'DELETE');
const checkinCalls = () => api.mock.calls.filter(([path]) => /\/checkin$/.test(path));
const delBtn = name => screen.getByRole('button', { name: `刪除習慣「${name}」` });
const queryDelBtn = name => screen.queryByRole('button', { name: `刪除習慣「${name}」` });

function mount(habits = [habit()], reload = vi.fn().mockResolvedValue(undefined)) {
  const utils = render(<HabitsView habits={habits} reload={reload} />);
  return { reload, ...utils };
}

describe('習慣頁刪除習慣的確認／防重／寫入／刷新邊界', () => {
  beforeEach(() => {
    api.mockReset();
    api.mockResolvedValue({ ok: true });
    window.confirm.mockReset();
    window.confirm.mockReturnValue(true);
  });

  it('確認後刪除：送出一次 DELETE、整包重新載入、不顯示錯誤', async () => {
    const { reload } = mount();

    await act(async () => { fireEvent.click(delBtn('背單字')); });

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(window.confirm.mock.calls[0][0]).toContain('背單字');
    expect(deleteCalls()).toEqual([['/habits/7', { method: 'DELETE' }]]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('確認對話框按取消：不送出任何寫入、不刷新、習慣仍在', async () => {
    window.confirm.mockReturnValue(false);
    const { reload } = mount();

    await act(async () => { fireEvent.click(delBtn('背單字')); });

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(api).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('背單字')).toBeInTheDocument();
    expect(delBtn('背單字')).not.toBeDisabled();
  });

  it('寫入或刷新尚未結束前，連點刪除不會重送、也不會再跳確認', async () => {
    let resolveWrite;
    let reentered = false;
    api.mockImplementation(() => {
      // 同一個事件循環內再點一次：此時 React 還沒重繪，只能靠同步鎖擋下
      if (!reentered) { reentered = true; delBtn('背單字').click(); }
      return new Promise(resolve => { resolveWrite = resolve; });
    });
    let resolveReload;
    const reload = vi.fn(() => new Promise(resolve => { resolveReload = resolve; }));
    mount([habit()], reload);

    fireEvent.click(delBtn('背單字'));
    expect(deleteCalls()).toHaveLength(1);
    expect(delBtn('背單字')).toBeDisabled();
    fireEvent.click(delBtn('背單字'));
    expect(deleteCalls()).toHaveLength(1);
    expect(window.confirm).toHaveBeenCalledOnce();

    await act(async () => { resolveWrite({ ok: true }); });
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => { resolveReload(); });
    expect(deleteCalls()).toHaveLength(1);
    expect(window.confirm).toHaveBeenCalledOnce();
  });

  it('刪除進行中不能對同一個習慣打卡，打卡進行中也不能刪除；其他習慣不受影響', async () => {
    let resolveWrite;
    api.mockImplementation(() => new Promise(resolve => { resolveWrite = resolve; }));
    mount([habit(), habit({ id: 8, name: '跑步', checkins: [] })]);

    // 刪除進行中 → 同一習慣的打卡被擋
    fireEvent.click(delBtn('背單字'));
    fireEvent.click(screen.getAllByTitle(today())[0]);
    expect(checkinCalls()).toHaveLength(0);
    expect(screen.getAllByTitle(today())[0]).toHaveAttribute('aria-busy', 'true');
    expect(delBtn('跑步')).not.toBeDisabled();
    await act(async () => { resolveWrite({ ok: true }); });
    // 刪除成功後只剩「跑步」
    expect(screen.getAllByTitle(today())).toHaveLength(1);

    // 打卡進行中 → 同一習慣的刪除被擋，而且連確認都不跳
    api.mockReset();
    window.confirm.mockClear();
    api.mockImplementation(() => new Promise(resolve => { resolveWrite = resolve; }));
    fireEvent.click(screen.getAllByTitle(today())[0]);
    expect(checkinCalls()).toEqual([['/habits/8/checkin', { method: 'POST', body: { date: today(), undo: false } }]]);
    expect(delBtn('跑步')).toBeDisabled();
    fireEvent.click(delBtn('跑步'));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(deleteCalls()).toHaveLength(0);
    await act(async () => { resolveWrite({ ok: true }); });
  });

  it('寫入失敗時顯示錯誤、不刷新、習慣仍在且可直接再刪一次', async () => {
    api.mockRejectedValueOnce(new Error('網路連線中斷'));
    const { reload } = mount();

    await act(async () => { fireEvent.click(delBtn('背單字')); });

    expect(screen.getByRole('alert')).toHaveTextContent('網路連線中斷');
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('背單字')).toBeInTheDocument();
    expect(delBtn('背單字')).not.toBeDisabled();

    await act(async () => { fireEvent.click(delBtn('背單字')); });
    expect(deleteCalls()).toHaveLength(2);
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('沒有錯誤訊息的寫入失敗退回預設繁中提示', async () => {
    api.mockRejectedValueOnce(new Error(''));
    mount();

    await act(async () => { fireEvent.click(delBtn('背單字')); });

    expect(screen.getByRole('alert')).toHaveTextContent('習慣沒有刪除成功，請再試一次。');
  });

  it('已刪除但刷新失敗：不誤報刪除失敗、先從畫面拿掉，無法再打卡或重刪；重試只重新載入', async () => {
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error('刷新失敗'))
      .mockResolvedValue(undefined);
    const keep = habit({ id: 8, name: '跑步', category: '運動', checkins: [] });
    const { rerender } = mount([habit({ category: '英文' }), keep], reload);

    await act(async () => { fireEvent.click(delBtn('背單字')); });

    expect(screen.getByRole('alert')).toHaveTextContent('習慣已刪除，但畫面暫時無法重新載入。');
    // props 仍是舊資料，但已刪除的習慣與它獨有的分類不再顯示，避免對不存在的習慣操作
    expect(screen.queryByText('背單字')).not.toBeInTheDocument();
    expect(queryDelBtn('背單字')).not.toBeInTheDocument();
    expect(screen.queryByText(/英文/)).not.toBeInTheDocument();
    expect(screen.getAllByTitle(today())).toHaveLength(1);
    expect(screen.getByText('跑步')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenLastCalledWith();
    expect(deleteCalls()).toHaveLength(1);
    expect(checkinCalls()).toHaveLength(0);

    // 刷新成功後 props 不再有它，畫面維持一致
    rerender(<HabitsView habits={[keep]} reload={reload} />);
    expect(screen.queryByText('背單字')).not.toBeInTheDocument();
    expect(screen.getByText('跑步')).toBeInTheDocument();
  });

  it('刪掉最後一個習慣但刷新失敗：顯示空狀態，重試刷新仍失敗時保留提示且不重送', async () => {
    const reload = vi.fn().mockRejectedValue(new Error('刷新失敗'));
    mount([habit()], reload);

    await act(async () => { fireEvent.click(delBtn('背單字')); });
    expect(screen.getByText('還沒有習慣，新增一個開始打卡吧')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('仍然無法重新載入，請稍後再試。'));
    expect(deleteCalls()).toHaveLength(1);
  });
});
