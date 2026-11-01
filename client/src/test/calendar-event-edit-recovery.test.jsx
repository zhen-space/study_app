// 行事曆編輯遇到回應遺失時，必須讀回確認，避免把已成功儲存誤報為失敗。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const CalendarView = (await import('../tt/CalendarView')).default;

const event = {
  id: 901, title: '舊標題', date: new Date().toLocaleDateString('sv-SE'),
  start_time: '08:00', end_time: '09:00', location: '', color: '', kind: '', recurring: null,
};

async function editTitle(title) {
  fireEvent.click(await screen.findByTitle('點一下編輯，長按可複製/刪除，拖曳可移到別天/別的時段'));
  fireEvent.change(await screen.findByDisplayValue('舊標題'), { target: { value: title } });
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
}

describe('行事曆編輯：回應遺失復原', () => {
  beforeEach(() => { localStorage.clear(); api.mockReset(); });

  it('PATCH 回應遺失但伺服器已有新內容時，不顯示錯誤', async () => {
    let patch;
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events/901' && opts?.method === 'PATCH') {
        patch = opts.body;
        throw new Error('回應遺失');
      }
      if (path === '/events') return ++eventReads === 1 ? [event] : [{ ...event, ...patch }];
      return [];
    });
    render(<CalendarView tasks={[]} reload={vi.fn()} />);
    await editTitle('新標題');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/events/901' && opts?.method === 'PATCH')).toHaveLength(1);
  });

  it('無法確認儲存結果時提示重新載入，且不重送 PATCH', async () => {
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events/901' && opts?.method === 'PATCH') throw new Error('回應遺失');
      if (path === '/events') {
        eventReads += 1;
        if (eventReads === 1) return [event];
        if (eventReads === 2) throw new Error('仍離線');
        return [{ ...event, title: '新標題' }];
      }
      return [];
    });
    render(<CalendarView tasks={[]} reload={vi.fn()} />);
    await editTitle('新標題');
    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認行程是否已儲存');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/events/901' && opts?.method === 'PATCH')).toHaveLength(1);
  });
});
