// Global Add 寫入／刷新邊界：POST 已成功但 reload 失敗時，不能把表單留著可再按
// （使用者會以為沒存到而重送，多出一筆重複任務／作業）；只能提示並重試 reload。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const GlobalAdd = (await import('../tt/GlobalAdd')).default;

const posts = () => api.mock.calls.filter(([path, opts]) => path === '/tasks' && opts?.method === 'POST');

async function openQuickTask(reload) {
  render(<GlobalAdd lists={[{ id: 1, name: '數學' }]} reload={reload} />);
  fireEvent.click(screen.getByRole('button', { name: '新增' }));
  fireEvent.click(screen.getByRole('button', { name: '新增任務' }));
  fireEvent.change(await screen.findByLabelText('任務標題'), { target: { value: '買便當' } });
}

describe('Global Add 快速任務：寫入與刷新分開處理', () => {
  beforeEach(() => { api.mockReset(); });

  it('POST 成功但 reload 失敗：關閉表單、提示已新增，重新載入只重抓不重送 POST', async () => {
    api.mockImplementation((path, opts) => Promise.resolve(opts?.method === 'POST' ? { id: 501 } : []));
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    await openQuickTask(reload);
    fireEvent.click(screen.getByRole('button', { name: '新增任務' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('任務已新增，但畫面暫時無法重新載入');
    // 表單已關閉，不留下可以再按一次的「新增任務」送出鈕
    expect(screen.queryByLabelText('任務標題')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(reload).toHaveBeenCalledTimes(2);
    expect(posts()).toHaveLength(1);
  });

  it('送出中連點只送一次 POST，且不能取消關閉', async () => {
    let resolvePost;
    api.mockImplementation((path, opts) => opts?.method === 'POST'
      ? new Promise(resolve => { resolvePost = resolve; }) : Promise.resolve([]));
    const reload = vi.fn().mockResolvedValue(undefined);
    await openQuickTask(reload);
    const submit = screen.getByRole('button', { name: '新增任務' });
    const form = submit.closest('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(posts()).toHaveLength(1);
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    await act(async () => { resolvePost({ id: 502 }); });
    await waitFor(() => expect(screen.queryByLabelText('任務標題')).toBeNull());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
  });

  it('POST 失敗：顯示錯誤、保留標題，可重試', async () => {
    let postCount = 0;
    api.mockImplementation((path, opts) => {
      if (!opts?.method) return Promise.resolve([]);
      postCount += 1;
      return postCount === 1 ? Promise.reject(new Error('網路中斷')) : Promise.resolve({ id: 503 });
    });
    const reload = vi.fn().mockResolvedValue(undefined);
    await openQuickTask(reload);
    fireEvent.click(screen.getByRole('button', { name: '新增任務' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('網路中斷');
    expect(screen.getByLabelText('任務標題')).toHaveValue('買便當');
    expect(reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '新增任務' }));
    await waitFor(() => expect(screen.queryByLabelText('任務標題')).toBeNull());
    expect(posts()).toHaveLength(2);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('POST 已提交但回應遺失時讀回確認，不重送任務', async () => {
    let reads = 0;
    api.mockImplementation((path, opts) => {
      if (opts?.method === 'POST') return Promise.reject(new Error('回應中斷'));
      reads += 1;
      return Promise.resolve([{ id: 504, title: '買便當', due_date: null }]);
    });
    const reload = vi.fn().mockResolvedValue(undefined);
    await openQuickTask(reload);
    fireEvent.click(screen.getByRole('button', { name: '不指定日期' }));
    fireEvent.click(screen.getByRole('button', { name: '新增任務' }));

    await waitFor(() => expect(screen.queryByLabelText('任務標題')).toBeNull());
    expect(posts()).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('POST 與確認讀取都失敗時阻擋重送，重新載入只讀取', async () => {
    let reads = 0;
    api.mockImplementation((path, opts) => {
      if (opts?.method === 'POST') return Promise.reject(new Error('回應中斷'));
      reads += 1;
      if (reads === 1) return Promise.reject(new Error('離線'));
      return Promise.resolve([{ id: 505, title: '買便當', due_date: null }]);
    });
    const reload = vi.fn().mockResolvedValue(undefined);
    await openQuickTask(reload);
    fireEvent.click(screen.getByRole('button', { name: '不指定日期' }));
    fireEvent.click(screen.getByRole('button', { name: '新增任務' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認任務是否新增');
    expect(screen.getByRole('button', { name: '新增任務' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '新增任務' }));
    expect(posts()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByLabelText('任務標題')).toBeNull());
    expect(posts()).toHaveLength(1);
  });
});

describe('Global Add 學校作業：寫入成功但刷新失敗', () => {
  beforeEach(() => { api.mockReset(); });

  it('表單關閉後仍提示已儲存，重新載入不重送 POST', async () => {
    api.mockResolvedValue({ id: 601 });
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    render(<GlobalAdd lists={[{ id: 1, name: '數學' }]} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: '新增' }));
    fireEvent.click(screen.getByRole('button', { name: '新增學校作業' }));
    fireEvent.change(await screen.findByPlaceholderText(/第 3 章習題/), { target: { value: '英文講義' } });
    fireEvent.change(screen.getByLabelText(/截止日期/), { target: { value: '2026-11-20' } });
    fireEvent.click(screen.getByRole('button', { name: '新增作業' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('作業已儲存，但畫面暫時無法重新載入');
    expect(screen.queryByRole('heading', { name: '新增學校作業' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(reload).toHaveBeenCalledTimes(2);
    expect(posts()).toHaveLength(1);
  });
});
