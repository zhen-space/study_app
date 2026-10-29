import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Tasks from '../tt/Tasks';
import { api } from '../api';

vi.mock('../api', () => ({ api: vi.fn() }));

const baseTask = {
  id: 1,
  title: '整理物理筆記',
  list_id: 10,
  notes: '補上公式',
  due_date: '2026-10-28',
  due_time: '19:30',
  priority: 2,
  tags: ['複習'],
  subtasks: [{ title: '第一章', done: false }, { title: '第二章', done: true }],
  recurring: 'weekly',
  miss_policy: 'keep',
  estimated_minutes: 45,
  completed: false,
  deleted: false,
  task_kind: 'task',
};

describe('複製任務', () => {
  beforeEach(() => {
    localStorage.clear();
    api.mockReset();
    api.mockImplementation(url => url.includes('attachments') || url === '/study-sessions' ? Promise.resolve([]) : Promise.resolve({}));
  });

  it('保留一般任務內容，但不複製已完成子任務', async () => {
    const reload = vi.fn().mockResolvedValue();
    render(<Tasks view={{ type: 'tasks' }} tasks={[baseTask]} lists={[{ id: 10, name: '物理' }]} filters={[]} reload={reload} title="任務" />);
    fireEvent.click(screen.getByText('整理物理筆記'));
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '複製任務' }));

    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks', {
      method: 'POST',
      body: expect.objectContaining({
        title: '整理物理筆記', list_id: 10, notes: '補上公式', due_date: '2026-10-28',
        due_time: '19:30', priority: 2, tags: ['複習'], recurring: 'weekly', estimated_minutes: 45,
        subtasks: [{ title: '第一章', done: false }], task_kind: 'task',
      }),
    }));
    expect(reload).toHaveBeenCalledWith('tasks');
    expect(await screen.findByText('已複製「整理物理筆記」')).toBeInTheDocument();
  });

  it('計畫任務不提供複製，避免繞過排程器', () => {
    render(<Tasks view={{ type: 'tasks' }} tasks={[{ ...baseTask, plan_id: 8, plan_status: 'active' }]} lists={[{ id: 10, name: '物理' }]} filters={[]} reload={vi.fn()} title="任務" />);
    fireEvent.click(screen.getByText('整理物理筆記'));
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    expect(screen.queryByRole('menuitem', { name: '複製任務' })).not.toBeInTheDocument();
  });

  it('POST 已寫入但回應遺失時讀回確認，不會再次複製', async () => {
    const copied = { ...baseTask, id: 2, subtasks: [{ title: '第一章', done: false }] };
    api.mockImplementation((url, options) => {
      if (url === '/tasks' && options?.method === 'POST') return Promise.reject(new Error('回應中斷'));
      if (url === '/tasks') return Promise.resolve([baseTask, copied]);
      return Promise.resolve([]);
    });
    const reload = vi.fn().mockResolvedValue();
    render(<Tasks view={{ type: 'tasks' }} tasks={[baseTask]} lists={[{ id: 10, name: '物理' }]} filters={[]} reload={reload} title="任務" />);
    fireEvent.click(screen.getByText('整理物理筆記'));
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '複製任務' }));

    expect(await screen.findByText('已複製「整理物理筆記」')).toBeInTheDocument();
    expect(api.mock.calls.filter(([url, options]) => url === '/tasks' && options?.method === 'POST')).toHaveLength(1);
    expect(reload).toHaveBeenCalledWith('tasks');
  });

  it('POST 與確認讀取都失敗時鎖住重送，重新載入後才解除', async () => {
    let postCount = 0;
    api.mockImplementation((url, options) => {
      if (url === '/tasks' && options?.method === 'POST') {
        postCount += 1;
        return Promise.reject(new Error('回應中斷'));
      }
      if (url === '/tasks') return Promise.reject(new Error('離線'));
      return Promise.resolve([]);
    });
    const reload = vi.fn().mockResolvedValue();
    render(<Tasks view={{ type: 'tasks' }} tasks={[baseTask]} lists={[{ id: 10, name: '物理' }]} filters={[]} reload={reload} title="任務" />);
    fireEvent.click(screen.getByText('整理物理筆記'));
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '複製任務' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認任務是否已複製');
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '複製任務' }));
    expect(postCount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(reload).toHaveBeenCalledWith('tasks');
  });
});
