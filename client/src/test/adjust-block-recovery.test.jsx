import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const AdjustBlockSheet = (await import('../tt/AdjustBlockSheet')).default;

const block = { id: 11, date: '2026-10-01', start_time: '19:00', end_time: '20:00' };
const task = { id: 7, title: '英文練習', list_id: 3 };
const isWrite = ([url, options]) => url === '/schedule/manual' && options?.body?.dry_run !== true;

beforeEach(() => {
  api.mockReset();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  api.mockImplementation((url, options) => {
    if (url === '/schedule/locks') return Promise.resolve([]);
    if (url === '/schedule/manual' && options?.body?.dry_run) return Promise.resolve({ conflicts: [] });
    return Promise.resolve({ version_id: 9 });
  });
});
afterEach(cleanup);

async function mount(reload = vi.fn().mockResolvedValue(), onClose = vi.fn()) {
  render(<AdjustBlockSheet block={block} task={task} lists={[{ id: 3, name: '英文' }]}
    versionId={5} reload={reload} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-10-02' } });
  const save = await screen.findByRole('button', { name: '儲存新安排' });
  await waitFor(() => expect(save).toBeEnabled(), { timeout: 1200 });
  return { save, reload, onClose };
}

describe('AdjustBlockSheet 儲存恢復', () => {
  it('pending save 時禁止 backdrop、Escape、關閉，且只 POST 一次', async () => {
    let resolveWrite;
    api.mockImplementation((url, options) => {
      if (url === '/schedule/locks') return Promise.resolve([]);
      if (options?.body?.dry_run) return Promise.resolve({ conflicts: [] });
      return new Promise(resolve => { resolveWrite = resolve; });
    });
    const { save, onClose } = await mount();
    fireEvent.click(save);
    fireEvent.click(document.querySelector('.sheet-backdrop'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '關閉' }));
    fireEvent.click(screen.getByRole('button', { name: '儲存中…' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(api.mock.calls.filter(isWrite)).toHaveLength(1);
    resolveWrite({ version_id: 9 });
  });

  it('write 成功但 reload 失敗只重試 reload', async () => {
    const reload = vi.fn().mockRejectedValueOnce(new Error('刷新失敗')).mockResolvedValueOnce();
    const onClose = vi.fn();
    const { save } = await mount(reload, onClose);
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('新安排已儲存，但畫面暫時無法更新');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(api.mock.calls.filter(isWrite)).toHaveLength(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('真正 write failure 保留表單並可重試', async () => {
    let writes = 0;
    api.mockImplementation((url, options) => {
      if (url === '/schedule/locks') return Promise.resolve([]);
      if (options?.body?.dry_run) return Promise.resolve({ conflicts: [] });
      writes += 1;
      return writes === 1 ? Promise.reject(new Error('儲存失敗')) : Promise.resolve({ version_id: 10 });
    });
    const { save } = await mount();
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('日期')).toHaveValue('2026-10-02');
    fireEvent.click(save);
    await waitFor(() => expect(api.mock.calls.filter(isWrite)).toHaveLength(2));
  });

  it('同步 guard 阻止重入建立兩個版本', async () => {
    let save;
    api.mockImplementation((url, options) => {
      if (url === '/schedule/locks') return Promise.resolve([]);
      if (options?.body?.dry_run) return Promise.resolve({ conflicts: [] });
      fireEvent.click(save);
      return Promise.resolve({ version_id: 11 });
    });
    ({ save } = await mount());
    fireEvent.click(save);
    await screen.findByText('新安排已儲存');
    expect(api.mock.calls.filter(isWrite)).toHaveLength(1);
  });
});
