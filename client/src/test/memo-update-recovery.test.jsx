import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const MemoView = (await import('../tt/MemoView')).default;

const memo = { id: 7, content: '交物理作業', done: 0, category: '', due_date: null };
const patchCalls = () => api.mock.calls.filter(([path, options]) => path === '/memos/7' && options?.method === 'PATCH');

describe('備忘錄更新失敗復原', () => {
  beforeEach(() => {
    api.mockReset();
    api.mockImplementation(path => Promise.resolve(path === '/memo-cats' ? [] : [memo]));
  });

  it('PATCH 失敗後重讀仍未完成時，不讓畫面停在假完成', async () => {
    api.mockImplementation((path, options) => {
      if (path === '/memos/7' && options?.method === 'PATCH') return Promise.reject(new Error('網路中斷'));
      return Promise.resolve(path === '/memo-cats' ? [] : [memo]);
    });
    render(<MemoView />);

    fireEvent.click(await screen.findByRole('checkbox', { name: '完成「交物理作業」' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(screen.getByRole('checkbox', { name: '完成「交物理作業」' })).not.toBeChecked();
    expect(patchCalls()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '重新載入' })).not.toBeInTheDocument();
  });

  it('PATCH 已提交但回應遺失時，以重讀結果保留完成狀態且不重送', async () => {
    let memoReads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memos/7' && options?.method === 'PATCH') return Promise.reject(new Error('回應中斷'));
      if (path === '/memos') return Promise.resolve(++memoReads === 1 ? [memo] : [{ ...memo, done: 1 }]);
      return Promise.resolve([]);
    });
    render(<MemoView />);

    fireEvent.click(await screen.findByRole('checkbox', { name: '完成「交物理作業」' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    fireEvent.click(screen.getByRole('button', { name: '顯示已完成（1）' }));
    expect(screen.getByRole('checkbox', { name: '完成「交物理作業」' })).toBeChecked();
    expect(patchCalls()).toHaveLength(1);
  });

  it('PATCH 後連重讀也失敗時鎖住該筆，重試只重新載入', async () => {
    let memoReads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memos/7' && options?.method === 'PATCH') return Promise.reject(new Error('回應中斷'));
      if (path === '/memos') {
        memoReads += 1;
        if (memoReads === 2) return Promise.reject(new Error('仍離線'));
        return Promise.resolve([memo]);
      }
      return Promise.resolve([]);
    });
    render(<MemoView />);

    fireEvent.click(await screen.findByRole('checkbox', { name: '完成「交物理作業」' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認是否更新');
    expect(screen.getByRole('checkbox', { name: '完成「交物理作業」' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: '完成「交物理作業」' })).not.toBeDisabled();
    expect(patchCalls()).toHaveLength(1);
    expect(memoReads).toBe(3);
  });
});
