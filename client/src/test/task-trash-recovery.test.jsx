import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

const trashed = (id, title) => ({ ...fx.tasks[0], id, title, deleted: true, completed: false });

function mount(reload = vi.fn().mockResolvedValue(undefined), rows = [trashed(701, '待刪講義')]) {
  render(<Tasks view={{ type: 'trash' }} tasks={rows} lists={fx.lists} filters={[]}
    reload={reload} title="任務" />);
  return reload;
}

describe('375px 任務垃圾桶 mutation recovery', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    api.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('永久刪除 pending 時同步防重送，提交後刷新失敗只重試 reload', async () => {
    let resolveDelete;
    let remove;
    let reentered = false;
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/701?hard=1' && options.method === 'DELETE') {
        if (!reentered) {
          reentered = true;
          fireEvent.click(remove);
        }
        return new Promise(resolve => { resolveDelete = resolve; });
      }
      return Promise.resolve([]);
    });
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    mount(reload);
    remove = screen.getByRole('button', { name: '永久刪除「待刪講義」' });

    fireEvent.click(remove);
    expect(api.mock.calls.filter(([path]) => path === '/tasks/701?hard=1')).toHaveLength(1);
    expect(remove).toBeDisabled();

    await act(async () => { resolveDelete({ ok: true }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('任務已永久刪除，但畫面暫時無法重新載入');
    expect(screen.queryByText('待刪講義')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重新載入' })).not.toBeInTheDocument());
    expect(api.mock.calls.filter(([path]) => path === '/tasks/701?hard=1')).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('真正永久刪除失敗保留項目與錯誤，且可再次確認重試', async () => {
    api.mockRejectedValueOnce(new Error('暫時無法永久刪除')).mockResolvedValueOnce({ ok: true });
    const reload = mount();

    fireEvent.click(screen.getByRole('button', { name: '永久刪除「待刪講義」' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暫時無法永久刪除');
    expect(screen.getByText('待刪講義')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '永久刪除「待刪講義」' }));
    await waitFor(() => expect(screen.queryByText('待刪講義')).not.toBeInTheDocument());
    expect(api).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('還原失敗不會讓項目消失，成功後才移出垃圾桶', async () => {
    api.mockRejectedValueOnce(new Error('暫時無法還原')).mockResolvedValueOnce({ ok: true });
    const reload = mount();

    fireEvent.click(screen.getByRole('button', { name: '還原' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暫時無法還原');
    expect(screen.getByText('待刪講義')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '還原' }));
    await waitFor(() => expect(screen.queryByText('待刪講義')).not.toBeInTheDocument());
    expect(api).toHaveBeenLastCalledWith('/tasks/701', { method: 'PATCH', body: { deleted: false } });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('取消永久刪除零寫入；清空失敗保留全部項目並可重試', async () => {
    const rows = [trashed(701, '待刪講義'), trashed(702, '舊作業')];
    window.confirm.mockReturnValueOnce(false).mockReturnValue(true);
    mount(undefined, rows);
    fireEvent.click(screen.getByRole('button', { name: '永久刪除「待刪講義」' }));
    expect(api).not.toHaveBeenCalled();

    api.mockRejectedValueOnce(new Error('清空失敗')).mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: '清空垃圾桶' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('清空失敗');
    expect(screen.getByText('待刪講義')).toBeInTheDocument();
    expect(screen.getByText('舊作業')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '清空垃圾桶' }));
    await waitFor(() => expect(screen.queryByText('待刪講義')).not.toBeInTheDocument());
    expect(screen.queryByText('舊作業')).not.toBeInTheDocument();
    expect(api.mock.calls.filter(([path]) => path === '/trash')).toHaveLength(2);
  });
});
