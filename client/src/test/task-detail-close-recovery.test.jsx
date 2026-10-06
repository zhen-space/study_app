import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

describe('Task／School Assignment Detail committed refresh recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/501' && options.method === 'PATCH') return Promise.resolve({});
      return Promise.resolve([]);
    });
  });

  it('PATCH committed 後 reload 失敗只重試 reload，不重送 PATCH', async () => {
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    const task = { ...fx.tasks[0], id: 501, title: '英文作業', completed: false, deleted: false };
    render(<Tasks view={{ type: 'tasks' }} tasks={[task]} lists={fx.lists} filters={[]}
      reload={reload} title="任務" />);
    fireEvent.click(screen.getByText('英文作業'));
    fireEvent.change(screen.getByDisplayValue('英文作業'), { target: { value: '英文作業更新' } });
    fireEvent.click(screen.getByTitle('完成編輯'));

    expect(await screen.findByRole('alert')).toHaveTextContent('任務已儲存，但畫面暫時無法更新');
    expect(screen.getByRole('button', { name: '重新載入並關閉' })).toBeEnabled();
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks/501' && options?.method === 'PATCH')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入並關閉' }));
    await waitFor(() => expect(screen.queryByTitle('完成編輯')).toBeNull());
    expect(reload).toHaveBeenCalledTimes(2);
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks/501' && options?.method === 'PATCH')).toHaveLength(1);
  });
});
