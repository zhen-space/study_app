// 行事曆拖曳搬移遇到回應遺失時，必須讀回確認實際位置。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const CalendarView = (await import('../tt/CalendarView')).default;

const event = {
  id: 1101, title: '地科複習', date: new Date().toLocaleDateString('sv-SE'),
  start_time: '08:00', end_time: '09:00', location: '', color: '', kind: '', recurring: null,
};

async function dragToLaterTime() {
  const node = await screen.findByTitle('點一下編輯，長按可複製/刪除，拖曳可移到別天/別的時段');
  const transfer = {
    value: '', effectAllowed: '',
    setData(_type, value) { this.value = value; },
    getData() { return this.value; },
  };
  fireEvent.dragStart(node, { clientY: 0, dataTransfer: transfer });
  const day = document.querySelector('[data-day]');
  Object.defineProperty(day, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0, left: 0, width: 300, height: 1000 }) });
  fireEvent.drop(day, { clientY: 240, dataTransfer: transfer });
}

describe('行事曆拖曳搬移：回應遺失復原', () => {
  beforeEach(() => { localStorage.clear(); api.mockReset(); });

  it('PATCH 回應遺失但伺服器已有新位置時，不顯示錯誤也不重送', async () => {
    let patch;
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events/1101' && opts?.method === 'PATCH') {
        patch = opts.body;
        throw new Error('回應遺失');
      }
      if (path === '/events') return ++eventReads === 1 ? [event] : [{ ...event, ...patch }];
      return [];
    });
    render(<CalendarView tasks={[]} reload={vi.fn()} />);
    await dragToLaterTime();
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === '/events').length).toBeGreaterThan(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.mock.calls.filter(([path, opts]) => path === '/events/1101' && opts?.method === 'PATCH')).toHaveLength(1);
  });

  it('無法確認移動結果時提示重新載入，且不重送 PATCH', async () => {
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events/1101' && opts?.method === 'PATCH') throw new Error('回應遺失');
      if (path === '/events') {
        eventReads += 1;
        if (eventReads === 1) return [event];
        if (eventReads === 2) throw new Error('仍離線');
        return [];
      }
      return [];
    });
    render(<CalendarView tasks={[]} reload={vi.fn()} />);
    await dragToLaterTime();
    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認行程是否已移動');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/events/1101' && opts?.method === 'PATCH')).toHaveLength(1);
  });
});
