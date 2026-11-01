// 行事曆新增遇到回應遺失時，必須先向伺服器確認，避免使用者重送而產生重複行程。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const CalendarView = (await import('../tt/CalendarView')).default;

describe('行事曆新增：回應遺失復原', () => {
  beforeEach(() => {
    localStorage.clear();
    api.mockReset();
  });

  it('POST 回應遺失但伺服器已有資料時，關閉表單且不重送', async () => {
    let posted;
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events' && opts?.method === 'POST') {
        posted = opts.body;
        throw new Error('連線中斷');
      }
      if (path === '/events') {
        eventReads += 1;
        return eventReads === 1 ? [] : [{ id: 501, ...posted }];
      }
      return [];
    });

    render(<CalendarView tasks={[]} reload={vi.fn()} addIntent="event" />);
    fireEvent.change(await screen.findByPlaceholderText('標題'), { target: { value: '物理複習' } });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));

    await waitFor(() => expect(screen.queryByPlaceholderText('標題')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/events' && opts?.method === 'POST')).toHaveLength(1);
  });

  it('無法確認時鎖住送出，重新確認成功後仍不重送', async () => {
    let posted;
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events' && opts?.method === 'POST') {
        posted = opts.body;
        throw new Error('連線中斷');
      }
      if (path === '/events') {
        eventReads += 1;
        if (eventReads === 1) return [];
        if (eventReads === 2) throw new Error('仍離線');
        return [{ id: 502, ...posted }];
      }
      return [];
    });

    render(<CalendarView tasks={[]} reload={vi.fn()} addIntent="event" />);
    fireEvent.change(await screen.findByPlaceholderText('標題'), { target: { value: '英文報告' } });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認是否已新增');
    expect(screen.getByRole('button', { name: '確認中…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新確認' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('標題')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/events' && opts?.method === 'POST')).toHaveLength(1);
  });

  it('寫入成功但刷新失敗時關閉表單，只提供重新載入', async () => {
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events' && opts?.method === 'POST') return { id: 503 };
      if (path === '/events') {
        eventReads += 1;
        if (eventReads === 1) return [];
        if (eventReads === 2) throw new Error('刷新失敗');
        return [{ id: 503, title: '化學複習' }];
      }
      return [];
    });

    render(<CalendarView tasks={[]} reload={vi.fn()} addIntent="event" />);
    fireEvent.change(await screen.findByPlaceholderText('標題'), { target: { value: '化學複習' } });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('日曆項目已新增，但畫面暫時無法重新載入');
    expect(screen.queryByPlaceholderText('標題')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.mock.calls.filter(([path, opts]) => path === '/events' && opts?.method === 'POST')).toHaveLength(1);
  });

  it('從行程選單複製時遇到回應遺失，也先確認而不重送', async () => {
    const original = {
      id: 601, title: '地理複習', date: new Date().toLocaleDateString('sv-SE'),
      start_time: '08:00', end_time: '09:00', location: '', color: '', kind: '', recurring: null,
    };
    let posted;
    let eventReads = 0;
    api.mockImplementation(async (path, opts) => {
      if (path === '/events' && opts?.method === 'POST') {
        posted = opts.body;
        throw new Error('回應遺失');
      }
      if (path === '/events') {
        eventReads += 1;
        return eventReads === 1 ? [original] : [original, { id: 602, ...posted }];
      }
      return [];
    });

    render(<CalendarView tasks={[]} reload={vi.fn()} />);
    const event = await screen.findByTitle('點一下編輯，長按可複製/刪除，拖曳可移到別天/別的時段');
    fireEvent.contextMenu(event, { clientX: 20, clientY: 20 });
    fireEvent.click(await screen.findByText('複製一份到後面'));

    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === '/events').length).toBeGreaterThan(2));
    expect(api.mock.calls.filter(([path, opts]) => path === '/events' && opts?.method === 'POST')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
