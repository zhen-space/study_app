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
});
