import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

const task = () => ({ ...fx.tasks[0], id: 501, title: '今天複習英文', completed: false, deleted: false });

function mount(reload = vi.fn().mockResolvedValue(undefined)) {
  render(<Tasks view={{ type: 'tasks' }} tasks={[task()]} lists={fx.lists} filters={[]}
    reload={reload} title="任務" />);
  return reload;
}

describe('Task mutation recovery at 375px', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    api.mockReset();
  });

  it('completion stays visible and retryable while pending or after a real API failure', async () => {
    let rejectWrite;
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/501' && options.method === 'PATCH') {
        return new Promise((resolve, reject) => { rejectWrite = reject; });
      }
      return Promise.resolve([]);
    });
    mount();
    const checkbox = screen.getByRole('checkbox', { name: '完成「今天複習英文」' });

    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeDisabled());
    fireEvent.change(checkbox, { target: { checked: true } });
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks/501' && options?.method === 'PATCH')).toHaveLength(1);
    expect(screen.getByText('今天複習英文')).toBeInTheDocument();

    await act(async () => { rejectWrite(new Error('目前無法更新')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('目前無法更新');
    expect(screen.getByRole('checkbox', { name: '完成「今天複習英文」' })).toBeEnabled();
    expect(screen.getByText('今天複習英文')).toBeInTheDocument();
  });

  it('undo is serialized after completion and a failed undo remains retryable', async () => {
    const writes = [];
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/501' && options.method === 'PATCH') {
        writes.push(options.body);
        if (writes.length === 2) return Promise.reject(new Error('復原暫時失敗'));
        return Promise.resolve({});
      }
      return Promise.resolve([]);
    });
    mount();

    fireEvent.click(screen.getByRole('checkbox', { name: '完成「今天複習英文」' }));
    const undo = await screen.findByRole('button', { name: '復原' });
    expect(screen.queryByText('今天複習英文')).not.toBeInTheDocument();
    fireEvent.click(undo);
    expect(await screen.findByRole('alert')).toHaveTextContent('復原暫時失敗');
    expect(screen.queryByText('今天複習英文')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '復原' }));
    await waitFor(() => expect(screen.getByText('今天複習英文')).toBeInTheDocument());
    expect(writes).toEqual([{ completed: true }, { completed: false }, { completed: false }]);
  });

  it('after commit, refresh failure retries only reload and never resends completion', async () => {
    api.mockResolvedValue({});
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    mount(reload);
    fireEvent.click(screen.getByRole('checkbox', { name: '完成「今天複習英文」' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('任務已更新，但畫面暫時無法重新載入');
    expect(screen.queryByText('今天複習英文')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重新載入' })).not.toBeInTheDocument());
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks/501' && options?.body?.completed === true)).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('delete failure keeps the task and detail open instead of claiming success', async () => {
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/501' && options.method === 'DELETE') return Promise.reject(new Error('刪除失敗'));
      if (path.endsWith('/attachments') || path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    mount();
    fireEvent.click(screen.getByText('今天複習英文'));
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '刪除任務' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('刪除失敗');
    expect(screen.getByDisplayValue('今天複習英文')).toBeInTheDocument();
    expect(screen.queryByText(/已刪除「今天複習英文」/)).not.toBeInTheDocument();
  });
});
