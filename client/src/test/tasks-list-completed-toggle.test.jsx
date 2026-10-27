import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Tasks from '../tt/Tasks';
import { api } from '../api';

vi.mock('../api', () => ({ api: vi.fn() }));

const lists = [{ id: 10, name: '物理' }, { id: 20, name: '英文' }];
const tasks = [
  { id: 1, title: '牛頓運動定律', list_id: 10, priority: 0, completed: false, deleted: false, tags: [], subtasks: [] },
  { id: 2, title: '動量守恆', list_id: 10, priority: 0, completed: true, deleted: false, tags: [], subtasks: [] },
  { id: 3, title: '英文閱讀', list_id: 20, priority: 0, completed: true, deleted: false, tags: [], subtasks: [] },
];

describe('科目清單顯示已完成任務', () => {
  beforeEach(() => {
    localStorage.clear();
    api.mockReset();
    api.mockResolvedValue({});
  });

  it('只顯示目前科目的已完成任務，並可再次隱藏', () => {
    render(<Tasks view={{ type: 'list', id: 10 }} tasks={tasks} lists={lists} filters={[]} reload={vi.fn()} title="物理" />);

    expect(screen.queryByText('動量守恆')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '顯示已完成（1）' }));

    expect(screen.getByText('動量守恆')).toBeInTheDocument();
    expect(screen.queryByText('英文閱讀')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '隱藏已完成' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '隱藏已完成' }));
    expect(screen.queryByText('動量守恆')).not.toBeInTheDocument();
  });

  it('取消完成後任務仍留在目前科目清單', async () => {
    render(<Tasks view={{ type: 'list', id: 10 }} tasks={tasks} lists={lists} filters={[]} reload={vi.fn().mockResolvedValue()} title="物理" />);
    fireEvent.click(screen.getByRole('button', { name: '顯示已完成（1）' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '取消完成「動量守恆」' }));

    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/2', { method: 'PATCH', body: { completed: false } }));
    expect(screen.getByText('動量守恆')).toBeInTheDocument();
  });

  it('記住顯示已完成偏好，重新開啟科目清單仍沿用', () => {
    const first = render(<Tasks view={{ type: 'list', id: 10 }} tasks={tasks} lists={lists} filters={[]} reload={vi.fn()} title="物理" />);
    fireEvent.click(screen.getByRole('button', { name: '顯示已完成（1）' }));
    expect(localStorage.getItem('taskShowCompletedInList')).toBe('true');
    first.unmount();

    render(<Tasks view={{ type: 'list', id: 10 }} tasks={tasks} lists={lists} filters={[]} reload={vi.fn()} title="物理" />);
    expect(screen.getByText('動量守恆')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '隱藏已完成' })).toHaveAttribute('aria-pressed', 'true');
  });
});
