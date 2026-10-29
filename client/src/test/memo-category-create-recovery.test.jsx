import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const MemoView = (await import('../tt/MemoView')).default;

const cat = { id: 1, name: '學校' };
const posts = () => api.mock.calls.filter(([path, options]) => path === '/memo-cats' && options?.method === 'POST');

describe('備忘錄分類新增失敗復原', () => {
  beforeEach(() => {
    api.mockReset(); vi.stubGlobal('prompt', vi.fn(() => '功課'));
    api.mockImplementation(path => Promise.resolve(path === '/memo-cats' ? [cat] : []));
  });

  it('POST 已提交但回應遺失時重讀確認且不重送', async () => {
    let catReads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memo-cats' && options?.method === 'POST') return Promise.reject(new Error('中斷'));
      if (path === '/memo-cats') return Promise.resolve(++catReads === 1 ? [cat] : [cat, { id: 2, name: '功課' }]);
      return Promise.resolve([]);
    });
    render(<MemoView />);
    await screen.findAllByText('學校');
    fireEvent.click(screen.getByText('＋新分類'));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect((await screen.findAllByText('功課')).length).toBeGreaterThan(0);
    expect(posts()).toHaveLength(1);
  });

  it('POST 與重讀都失敗時阻擋再次新增，重試只讀取', async () => {
    let catReads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memo-cats' && options?.method === 'POST') return Promise.reject(new Error('中斷'));
      if (path === '/memo-cats') {
        catReads += 1;
        if (catReads === 2) return Promise.reject(new Error('離線'));
        return Promise.resolve(catReads === 1 ? [cat] : [cat, { id: 2, name: '功課' }]);
      }
      return Promise.resolve([]);
    });
    render(<MemoView />);
    await screen.findAllByText('學校');
    fireEvent.click(screen.getByText('＋新分類'));

    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認是否新增分類');
    fireEvent.click(screen.getByText('＋新分類'));
    expect(prompt).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已重新載入確認'));
    expect(posts()).toHaveLength(1);
  });
});
