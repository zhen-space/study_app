import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const MemoView = (await import('../tt/MemoView')).default;

const cat = { id: 3, name: '學校' };
const memo = { id: 7, content: '交作業', done: 0, category: '學校', due_date: null };
const mutationCalls = () => api.mock.calls.filter(([path, options]) => path === '/memo-cats/3' && ['PATCH', 'DELETE'].includes(options?.method));

describe('備忘錄分類異動失敗復原', () => {
  beforeEach(() => {
    api.mockReset();
    vi.stubGlobal('prompt', vi.fn(() => '功課'));
    api.mockImplementation(path => Promise.resolve(path === '/memo-cats' ? [cat] : [memo]));
  });

  it('改名回應遺失時重讀正式資料，不重送異動', async () => {
    let catReads = 0;
    let memoReads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memo-cats/3' && options?.method === 'PATCH') return Promise.reject(new Error('回應中斷'));
      if (path === '/memo-cats') return Promise.resolve(++catReads === 1 ? [cat] : [{ ...cat, name: '功課' }]);
      if (path === '/memos') return Promise.resolve(++memoReads === 1 ? [memo] : [{ ...memo, category: '功課' }]);
      return Promise.resolve([]);
    });
    render(<MemoView />);
    fireEvent.click(await screen.findByRole('button', { name: '管理分類' }));
    fireEvent.click(screen.getByRole('button', { name: '改名' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect((await screen.findAllByText('功課')).length).toBeGreaterThan(0);
    expect(mutationCalls()).toHaveLength(1);
  });

  it('刪除與重讀都失敗時顯示阻擋訊息，重試只重新載入', async () => {
    let failReads = false;
    api.mockImplementation((path, options) => {
      if (path === '/memo-cats/3' && options?.method === 'DELETE') return Promise.reject(new Error('回應中斷'));
      if (failReads && (path === '/memos' || path === '/memo-cats')) return Promise.reject(new Error('離線'));
      return Promise.resolve(path === '/memo-cats' ? [cat] : [memo]);
    });
    render(<MemoView />);
    await screen.findByText('交作業');
    fireEvent.click(screen.getByRole('button', { name: '管理分類' }));
    failReads = true;
    fireEvent.click(screen.getByRole('button', { name: '刪除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認分類是否變更');
    failReads = false;
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(mutationCalls()).toHaveLength(1);
  });
});
