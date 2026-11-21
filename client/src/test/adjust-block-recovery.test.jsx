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
      if (writes === 1) {
        const error = new Error('儲存失敗'); error.status = 422;
        return Promise.reject(error);
      }
      return Promise.resolve({ version_id: 10 });
    });
    const { save } = await mount();
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('日期')).toHaveValue('2026-10-02');
    fireEvent.click(save);
    await waitFor(() => expect(api.mock.calls.filter(isWrite)).toHaveLength(2));
  });

  it('回應遺失時鎖住 mutation，只能重新載入確認', async () => {
    api.mockImplementation((url, options) => {
      if (url === '/schedule/locks') return Promise.resolve([]);
      if (options?.body?.dry_run) return Promise.resolve({ conflicts: [] });
      return Promise.reject(new Error('連線中斷'));
    });
    const reload = vi.fn().mockResolvedValue();
    const onClose = vi.fn();
    const { save } = await mount(reload, onClose);
    fireEvent.click(save);

    expect(await screen.findByText('暫時無法確認儲存結果')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('確認前不會再次送出');
    expect(screen.queryByRole('button', { name: '儲存新安排' })).toBeNull();
    expect(screen.getByRole('button', { name: '關閉' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '先關閉' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.mock.calls.filter(isWrite)).toHaveLength(1);
    expect(reload).toHaveBeenCalledOnce();
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

describe('AdjustBlockSheet 鎖定恢復', () => {
  it('建立已提交後使用 canonical response，不再用額外 GET 冒充失敗', async () => {
    let reads = 0;
    api.mockImplementation(async (url, options) => {
      if (url === '/schedule/locks' && !options) {
        reads += 1;
        return [];
      }
      if (url === '/schedule/locks' && options?.method === 'POST') {
        return { id: 21, type: 'task', task_id: 7, existing: false };
      }
      return {};
    });
    render(<AdjustBlockSheet block={block} task={task} lists={[]}
      versionId={5} reload={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(reads).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: '鎖定這一項' }));

    expect(await screen.findByRole('button', { name: '解除鎖定' })).toBeEnabled();
    expect(screen.getByText(/已鎖定：AI 重新排程時不會改動這一項/)).toBeInTheDocument();
    expect(reads).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('解除已提交後直接清除本地投影，不再用額外 GET 冒充失敗', async () => {
    let reads = 0;
    let deletes = 0;
    api.mockImplementation(async (url, options) => {
      if (url === '/schedule/locks' && !options) {
        reads += 1;
        return [{ id: 22, type: 'task', task_id: 7 }];
      }
      if (url === '/schedule/locks/22' && options?.method === 'DELETE') {
        deletes += 1;
        return { ok: true, existing: false };
      }
      return {};
    });
    render(<AdjustBlockSheet block={block} task={task} lists={[]}
      versionId={5} reload={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: '解除鎖定' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '解除鎖定' }));

    expect(await screen.findByRole('button', { name: '鎖定這一項' })).toBeEnabled();
    expect(deletes).toBe(1);
    expect(reads).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
