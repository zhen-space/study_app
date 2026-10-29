import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const MemoView = (await import('../tt/MemoView')).default;

const existing = { id: 1, content: '原有備忘', done: 0, category: '', due_date: null };
const posts = () => api.mock.calls.filter(([path, options]) => path === '/memos' && options?.method === 'POST');

describe('備忘錄新增失敗復原', () => {
  beforeEach(() => { api.mockReset(); api.mockImplementation(path => Promise.resolve(path === '/memo-cats' ? [] : [existing])); });

  it('POST 已提交但回應遺失時重讀確認，不重送也不保留草稿', async () => {
    let reads = 0;
    const created = { ...existing, id: 2, content: '交數學作業' };
    api.mockImplementation((path, options) => {
      if (path === '/memos' && options?.method === 'POST') return Promise.reject(new Error('回應中斷'));
      if (path === '/memos') return Promise.resolve(++reads === 1 ? [existing] : [existing, created]);
      return Promise.resolve([]);
    });
    render(<MemoView />);
    const input = screen.getByPlaceholderText('要記下什麼？');
    fireEvent.change(input, { target: { value: '交數學作業' } });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(input).toHaveValue('');
    expect(screen.getByText('交數學作業')).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });

  it('POST 與重讀都失敗時鎖住新增，重試只讀取並保留未提交草稿', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/memos' && options?.method === 'POST') return Promise.reject(new Error('中斷'));
      if (path === '/memos') {
        reads += 1;
        if (reads === 2) return Promise.reject(new Error('離線'));
        return Promise.resolve([existing]);
      }
      return Promise.resolve([]);
    });
    render(<MemoView />);
    const input = screen.getByPlaceholderText('要記下什麼？');
    fireEvent.change(input, { target: { value: '交數學作業' } });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認是否新增');
    expect(input).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('新增失敗'));
    expect(input).not.toBeDisabled();
    expect(input).toHaveValue('交數學作業');
    expect(posts()).toHaveLength(1);
  });
});
