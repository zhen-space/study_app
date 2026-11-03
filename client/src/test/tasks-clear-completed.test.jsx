import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Tasks from '../tt/Tasks';
import { api } from '../api';

vi.mock('../api', () => ({ api: vi.fn() }));

const mk = (id, over = {}) => ({
  id, title: `任務 ${id}`, completed: true, deleted: false, plan_id: null,
  task_kind: 'task', due_date: null, due_time: null, list_id: null,
  priority: 0, tags: [], subtasks: [], notes: '', order_index: id, ...over,
});

describe('整理已完成任務', () => {
  beforeEach(() => {
    api.mockReset();
    api.mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('只把一般任務移到垃圾桶，保留計畫任務與學校作業', async () => {
    const reload = vi.fn().mockResolvedValue();
    render(<Tasks view={{ type: 'completed' }} tasks={[
      mk(1),
      mk(2, { plan_id: 9 }),
      mk(3, { task_kind: 'school_assignment' }),
    ]} lists={[]} filters={[]} reload={reload} title="已完成" />);

    fireEvent.click(screen.getByRole('button', { name: '移到垃圾桶（1）' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/1', { method: 'DELETE' }));
    expect(api).not.toHaveBeenCalledWith('/tasks/2', expect.anything());
    expect(api).not.toHaveBeenCalledWith('/tasks/3', expect.anything());
    expect(reload).toHaveBeenCalledWith('tasks');
  });

  it('可從底部提示復原剛移動的任務', async () => {
    const reload = vi.fn().mockResolvedValue();
    render(<Tasks view={{ type: 'completed' }} tasks={[mk(1)]} lists={[]} filters={[]} reload={reload} title="已完成" />);
    fireEvent.click(screen.getByRole('button', { name: '移到垃圾桶（1）' }));
    await screen.findByText('已將 1 項已完成任務移到垃圾桶');
    fireEvent.click(screen.getByRole('button', { name: '復原' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/1', { method: 'PATCH', body: { deleted: false } }));
  });

  it('取消確認時不送出刪除', () => {
    window.confirm.mockReturnValue(false);
    render(<Tasks view={{ type: 'completed' }} tasks={[mk(1)]} lists={[]} filters={[]} reload={vi.fn()} title="已完成" />);
    fireEvent.click(screen.getByRole('button', { name: '移到垃圾桶（1）' }));
    expect(api).not.toHaveBeenCalled();
  });

  it('批次刪除回應遺失但讀回已進垃圾桶時，不誤報失敗或重送', async () => {
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/1' && options.method === 'DELETE') return Promise.reject(new Error('連線中斷'));
      if (path === '/tasks') return Promise.resolve([{ ...mk(1), deleted: true }]);
      return Promise.resolve({});
    });
    const reload = vi.fn().mockResolvedValue();
    render(<Tasks view={{ type: 'completed' }} tasks={[mk(1)]} lists={[]} filters={[]} reload={reload} title="已完成" />);

    fireEvent.click(screen.getByRole('button', { name: '移到垃圾桶（1）' }));

    expect(await screen.findByText('已將 1 項已完成任務移到垃圾桶')).toBeInTheDocument();
    expect(screen.queryByText(/另有 .* 項失敗/)).not.toBeInTheDocument();
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks/1' && options?.method === 'DELETE')).toHaveLength(1);
    expect(api.mock.calls.filter(([path]) => path === '/tasks')).toHaveLength(1);
    expect(reload).toHaveBeenCalledWith('tasks');
  });

  it('批次刪除讀回仍未提交時，保留失敗數量供安全重試', async () => {
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/1' && options.method === 'DELETE') return Promise.reject(new Error('刪除失敗'));
      if (path === '/tasks') return Promise.resolve([mk(1)]);
      return Promise.resolve({});
    });
    render(<Tasks view={{ type: 'completed' }} tasks={[mk(1)]} lists={[]} filters={[]} reload={vi.fn()} title="已完成" />);

    fireEvent.click(screen.getByRole('button', { name: '移到垃圾桶（1）' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已移動 0 項，另有 1 項失敗，請再試一次。');
    expect(screen.queryByText(/已將 .* 項已完成任務移到垃圾桶/)).not.toBeInTheDocument();
  });

  it('批次復原回應遺失但讀回已復原時，不誤報失敗或重送', async () => {
    let deleted = false;
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/1' && options.method === 'DELETE') {
        deleted = true;
        return Promise.resolve({});
      }
      if (path === '/tasks/1' && options.method === 'PATCH') {
        deleted = false;
        return Promise.reject(new Error('連線中斷'));
      }
      if (path === '/tasks') return Promise.resolve([{ ...mk(1), deleted }]);
      return Promise.resolve({});
    });
    const reload = vi.fn().mockResolvedValue();
    render(<Tasks view={{ type: 'completed' }} tasks={[mk(1)]} lists={[]} filters={[]} reload={reload} title="已完成" />);

    fireEvent.click(screen.getByRole('button', { name: '移到垃圾桶（1）' }));
    fireEvent.click(await screen.findByRole('button', { name: '復原' }));

    await waitFor(() => expect(screen.getByText('任務 1')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks/1' && options?.method === 'PATCH')).toHaveLength(1);
    expect(api.mock.calls.filter(([path]) => path === '/tasks')).toHaveLength(1);
  });

  it('批次復原部分失敗時，只讓已復原任務回到畫面並回報精確數量', async () => {
    api.mockImplementation((path, options = {}) => {
      if (options.method === 'DELETE') return Promise.resolve({});
      if (path === '/tasks/1' && options.method === 'PATCH') return Promise.resolve({});
      if (path === '/tasks/2' && options.method === 'PATCH') return Promise.reject(new Error('復原失敗'));
      if (path === '/tasks') return Promise.resolve([{ ...mk(1), deleted: false }, { ...mk(2), deleted: true }]);
      return Promise.resolve({});
    });
    const reload = vi.fn().mockResolvedValue();
    render(<Tasks view={{ type: 'completed' }} tasks={[mk(1), mk(2)]} lists={[]} filters={[]} reload={reload} title="已完成" />);

    fireEvent.click(screen.getByRole('button', { name: '移到垃圾桶（2）' }));
    fireEvent.click(await screen.findByRole('button', { name: '復原' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('有 1 項無法復原，請到垃圾桶重試');
    expect(screen.getByText('任務 1')).toBeInTheDocument();
    expect(screen.queryByText('任務 2')).not.toBeInTheDocument();
  });
});
