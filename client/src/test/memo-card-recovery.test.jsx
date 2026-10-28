import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const MemoCard = (await import('../tt/MemoCard')).default;

const memo = { id: 7, content: '交物理作業', done: 0, category: '', due_date: null };
const patchCalls = () => api.mock.calls.filter(([path, options]) => path === '/memos/7' && options?.method === 'PATCH');

describe('首頁備忘錄完成狀態復原', () => {
  beforeEach(() => {
    localStorage.clear();
    api.mockReset();
  });

  it('寫入失敗後重讀正式狀態，不讓備忘錄假裝已完成', async () => {
    api.mockImplementation((path, options) => {
      if (path === '/memos/7' && options?.method === 'PATCH') return Promise.reject(new Error('網路中斷'));
      return Promise.resolve([memo]);
    });
    render(<MemoCard goMemo={vi.fn()} />);

    fireEvent.click(await screen.findByRole('checkbox'));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(screen.queryByRole('button', { name: '重新載入' })).not.toBeInTheDocument();
    expect(await screen.findByText('交物理作業')).toBeInTheDocument();
    expect(patchCalls()).toHaveLength(1);
    expect(api.mock.calls.filter(([path]) => path === '/memos')).toHaveLength(2);
  });

  it('回應遺失但伺服器其實已完成時，以重讀結果為準且不重送 PATCH', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memos/7' && options?.method === 'PATCH') return Promise.reject(new Error('回應中斷'));
      if (path === '/memos') return Promise.resolve(++reads === 1 ? [memo] : [{ ...memo, done: 1 }]);
      return Promise.resolve({});
    });
    render(<MemoCard goMemo={vi.fn()} />);

    fireEvent.click(await screen.findByRole('checkbox'));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(screen.queryByText('交物理作業')).not.toBeInTheDocument();
    expect(patchCalls()).toHaveLength(1);
  });

  it('寫入後連重讀也失敗時，重試只重新載入、不再切換完成狀態', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memos/7' && options?.method === 'PATCH') return Promise.reject(new Error('回應中斷'));
      if (path === '/memos') {
        reads += 1;
        if (reads === 2) return Promise.reject(new Error('仍離線'));
        return Promise.resolve([memo]);
      }
      return Promise.resolve({});
    });
    render(<MemoCard goMemo={vi.fn()} />);

    fireEvent.click(await screen.findByRole('checkbox'));
    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認完成狀態');
    expect(screen.getByRole('checkbox')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox')).not.toBeDisabled();
    expect(patchCalls()).toHaveLength(1);
    expect(reads).toBe(3);
  });
});
