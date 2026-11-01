// 任務完成狀態已寫入但刷新失敗時，重試只能讀取，不能再次反轉完成狀態。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const CalendarView = (await import('../tt/CalendarView')).default;
const { today } = await import('../tt/helpers');

describe('行事曆任務完成切換：寫入與刷新邊界', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('calView', 'day');
    api.mockReset();
    api.mockImplementation(async path => path === '/events' ? [] : []);
  });

  it('PATCH 成功但刷新失敗時，重新載入不重送 PATCH', async () => {
    const task = { id: 71, title: '複習數學', due_date: today(), due_time: '08:00', completed: false };
    let refreshAvailable = false;
    const reload = vi.fn(async () => {
      if (!refreshAvailable) throw new Error('刷新失敗');
    });

    render(<CalendarView tasks={[task]} reload={reload} />);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/schedule/locks'));
    fireEvent.click(screen.getByText('08:00 複習數學'));

    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/71', {
      method: 'PATCH', body: { completed: true },
    }));

    expect(await screen.findByRole('alert')).toHaveTextContent('任務完成狀態已更新，但畫面暫時無法重新載入');
    refreshAvailable = true;
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/tasks/71' && opts?.method === 'PATCH')).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
