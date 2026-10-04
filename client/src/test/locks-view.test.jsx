import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const LocksView = (await import('../tt/LocksView')).default;

const tasks = [{
  id: 7,
  title: '英文複習',
  plan_id: 3,
  plan_status: 'active',
  due_date: '2030-08-15',
  deleted: false,
  completed: false,
}];

beforeEach(() => {
  api.mockReset();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
});

describe('LocksView recoverable mutations', () => {
  it('建立時鎖住重複操作，成功後刷新，並送出 canonical payload', async () => {
    let resolvePost;
    const pending = new Promise(resolve => { resolvePost = resolve; });
    let reads = 0;
    api.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') return pending;
      if (path === '/schedule/locks') {
        reads += 1;
        return reads === 1 ? [] : [{ id: 11, type: 'time', date: '2030-08-20', start_time: '18:00', end_time: '19:00' }];
      }
      return {};
    });
    render(<LocksView tasks={tasks} />);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/schedule/locks'));
    fireEvent.click(screen.getByRole('button', { name: '時段' }));
    fireEvent.change(screen.getByLabelText('鎖定日期'), { target: { value: '2030-08-20' } });
    fireEvent.change(screen.getByLabelText('鎖定開始時間'), { target: { value: '18:00' } });
    fireEvent.change(screen.getByLabelText('鎖定結束時間'), { target: { value: '19:00' } });
    fireEvent.click(screen.getByRole('button', { name: '鎖定' }));
    expect(screen.getByRole('button', { name: '鎖定中…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '鎖定中…' }));
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(api).toHaveBeenCalledWith('/schedule/locks', {
      method: 'POST',
      body: { type: 'time', date: '2030-08-20', start_time: '18:00', end_time: '19:00' },
    });
    resolvePost({ id: 11, type: 'time', date: '2030-08-20', start_time: '18:00', end_time: '19:00' });
    expect(await screen.findByText('2030-08-20 18:00–19:00')).toBeTruthy();
  });

  it('建立失敗保留輸入並顯示 alert，可直接重試', async () => {
    let attempts = 0;
    api.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') {
        attempts += 1;
        if (attempts === 1) throw new Error('網路中斷');
        return { id: 12, type: 'task', task_id: 7 };
      }
      return [];
    });
    render(<LocksView tasks={tasks} />);
    fireEvent.change(await screen.findByLabelText('選擇已排入時間的任務'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: '鎖定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('網路中斷');
    expect(screen.getByLabelText('選擇已排入時間的任務')).toHaveValue('7');
    expect(screen.getByRole('button', { name: '鎖定' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '鎖定' }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(api).toHaveBeenCalledWith('/schedule/locks', {
      method: 'POST',
      body: { type: 'task', task_id: 7 },
    });
  });

  it('解除失敗保留 lock，busy guard 防止重複；失敗後可重試', async () => {
    let deletes = 0;
    api.mockImplementation(async (path, options) => {
      if (options?.method === 'DELETE') {
        deletes += 1;
        if (deletes === 1) throw new Error('解除失敗');
        return { released: true };
      }
      return deletes >= 2 ? [] : [{ id: 13, type: 'day', date: '2030-08-21' }];
    });
    render(<LocksView tasks={tasks} />);
    expect(await screen.findByText('2030-08-21 全天')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '解除鎖定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('解除失敗');
    expect(screen.getByText('2030-08-21 全天')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '解除鎖定' }));
    await waitFor(() => expect(screen.queryByText('2030-08-21 全天')).toBeNull());
    expect(deletes).toBe(2);
  });

  it('解除已提交後直接更新本地投影，不因刷新失敗誘導重送 DELETE', async () => {
    let reads = 0;
    let deletes = 0;
    api.mockImplementation(async (path, options) => {
      if (options?.method === 'DELETE') {
        deletes += 1;
        return { ok: true };
      }
      if (path === '/schedule/locks') {
        reads += 1;
        if (reads > 1) throw new Error('重新整理失敗');
        return [{ id: 14, type: 'day', date: '2030-08-22' }];
      }
      return {};
    });
    render(<LocksView tasks={tasks} />);
    expect(await screen.findByText('2030-08-22 全天')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '解除鎖定' }));
    await waitFor(() => expect(screen.queryByText('2030-08-22 全天')).toBeNull());

    expect(deletes).toBe(1);
    expect(reads).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('建立已提交後使用 canonical response，不因刷新失敗誘導重送 POST', async () => {
    let reads = 0;
    let posts = 0;
    api.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') {
        posts += 1;
        return { id: 15, type: 'day', date: '2030-08-23', existing: false };
      }
      if (path === '/schedule/locks') {
        reads += 1;
        if (reads > 1) throw new Error('重新整理失敗');
        return [];
      }
      return {};
    });
    render(<LocksView tasks={tasks} />);
    await waitFor(() => expect(reads).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: '整天' }));
    fireEvent.change(screen.getByLabelText('鎖定日期'), { target: { value: '2030-08-23' } });
    fireEvent.click(screen.getByRole('button', { name: '鎖定' }));

    expect(await screen.findByText('2030-08-23 全天')).toBeTruthy();
    expect(posts).toBe(1);
    expect(reads).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
