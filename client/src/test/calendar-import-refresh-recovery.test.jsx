// 批次匯入已寫入但刷新失敗時，預覽要關閉並只提供重新載入，不重送匯入。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const CalendarView = (await import('../tt/CalendarView')).default;

const imported = [{
  title: '數學課', date: '2099-06-01', start_time: '08:00', end_time: '09:00',
  location: '', recurring: null, checked: true,
}];

describe('行事曆批次匯入：寫入與刷新邊界', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('calImport', JSON.stringify(imported));
    api.mockReset();
    vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  it('POST 成功但刷新失敗時關閉預覽，只重新載入而不重送', async () => {
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events/bulk' && opts?.method === 'POST') return { imported: 1 };
      if (path === '/events') {
        eventReads += 1;
        if (eventReads === 1) return [];
        if (eventReads === 2) throw new Error('刷新失敗');
        return [{ id: 1201, ...imported[0] }];
      }
      return [];
    });

    render(<CalendarView tasks={[]} reload={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '加入日曆' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('行程已匯入，但畫面暫時無法重新載入');
    expect(screen.queryByRole('button', { name: '加入日曆' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/events/bulk' && opts?.method === 'POST')).toHaveLength(1);
  });
});
