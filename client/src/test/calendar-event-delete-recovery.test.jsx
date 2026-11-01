// 行事曆刪除遇到回應遺失時，必須讀回確認，避免把已成功刪除誤報為失敗。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const CalendarView = (await import('../tt/CalendarView')).default;

const event = {
  id: 801, title: '公民複習', date: new Date().toLocaleDateString('sv-SE'),
  start_time: '08:00', end_time: '09:00', location: '', color: '', kind: '', recurring: null,
};

async function openDelete() {
  const node = await screen.findByTitle('點一下編輯，長按可複製/刪除，拖曳可移到別天/別的時段');
  fireEvent.contextMenu(node, { clientX: 20, clientY: 20 });
  fireEvent.click(await screen.findByText('刪除'));
}

describe('行事曆刪除：回應遺失復原', () => {
  beforeEach(() => { localStorage.clear(); api.mockReset(); });

  it('DELETE 回應遺失但伺服器已刪除時，不顯示錯誤', async () => {
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events/801' && opts?.method === 'DELETE') throw new Error('回應遺失');
      if (path === '/events') return ++eventReads === 1 ? [event] : [];
      return [];
    });
    render(<CalendarView tasks={[]} reload={vi.fn()} />);
    await openDelete();
    await waitFor(() => expect(api).toHaveBeenCalledWith('/events/801', { method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/events/801' && opts?.method === 'DELETE')).toHaveLength(1);
  });

  it('無法確認刪除結果時提示重新載入，且不重送 DELETE', async () => {
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events/801' && opts?.method === 'DELETE') throw new Error('回應遺失');
      if (path === '/events') {
        eventReads += 1;
        if (eventReads === 1) return [event];
        if (eventReads === 2) throw new Error('仍離線');
        return [];
      }
      return [];
    });
    render(<CalendarView tasks={[]} reload={vi.fn()} />);
    await openDelete();
    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認是否已刪除');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/events/801' && opts?.method === 'DELETE')).toHaveLength(1);
  });
});
