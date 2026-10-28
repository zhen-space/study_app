import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const MemoView = (await import('../tt/MemoView')).default;

const memo = { id: 7, content: '交物理作業', done: 0, category: '', due_date: null };
const deleteCalls = () => api.mock.calls.filter(([path, options]) => path === '/memos/7' && options?.method === 'DELETE');

describe('備忘錄刪除失敗復原', () => {
  beforeEach(() => {
    api.mockReset();
    api.mockImplementation(path => Promise.resolve(path === '/memo-cats' ? [] : [memo]));
  });

  it('DELETE 失敗後重讀仍存在時，項目不會假消失', async () => {
    api.mockImplementation((path, options) => {
      if (path === '/memos/7' && options?.method === 'DELETE') return Promise.reject(new Error('網路中斷'));
      return Promise.resolve(path === '/memo-cats' ? [] : [memo]);
    });
    render(<MemoView />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除「交物理作業」' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(screen.getByText('交物理作業')).toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '重新載入' })).not.toBeInTheDocument();
  });

  it('DELETE 已提交但回應遺失時，以重讀結果移除且不重送', async () => {
    let memoReads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memos/7' && options?.method === 'DELETE') return Promise.reject(new Error('回應中斷'));
      if (path === '/memos') return Promise.resolve(++memoReads === 1 ? [memo] : []);
      return Promise.resolve([]);
    });
    render(<MemoView />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除「交物理作業」' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(screen.queryByText('交物理作業')).not.toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(1);
  });

  it('DELETE 後連重讀也失敗時鎖住該筆，重試只重新載入', async () => {
    let memoReads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memos/7' && options?.method === 'DELETE') return Promise.reject(new Error('回應中斷'));
      if (path === '/memos') {
        memoReads += 1;
        if (memoReads === 2) return Promise.reject(new Error('仍離線'));
        return Promise.resolve([memo]);
      }
      return Promise.resolve([]);
    });
    render(<MemoView />);

    fireEvent.click(await screen.findByRole('button', { name: '刪除「交物理作業」' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認是否刪除');
    expect(screen.getByRole('button', { name: '刪除「交物理作業」' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '刪除「交物理作業」' })).not.toBeDisabled();
    expect(deleteCalls()).toHaveLength(1);
    expect(memoReads).toBe(3);
  });
});
