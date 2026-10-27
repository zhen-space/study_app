import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Tasks from '../tt/Tasks';

const mk = (id, title, completedAt, listId) => ({
  id, title, completed: true, completed_at: completedAt, deleted: false,
  list_id: listId, priority: 0, tags: [], subtasks: [], due_date: null,
});

describe('已完成任務排序', () => {
  beforeEach(() => localStorage.clear());

  it('固定依最近完成排序，不承接任務頁保存的科目分堆', () => {
    localStorage.setItem('taskSort', 'subjectGroup');
    render(<Tasks view={{ type: 'completed' }} tasks={[
      mk(1, '較早完成', '2026-10-20T10:00:00.000Z', 1),
      mk(2, '最近完成', '2026-10-21T10:00:00.000Z', 2),
    ]} lists={[{ id: 1, name: '數學' }, { id: 2, name: '英文' }]}
      filters={[]} reload={() => {}} title="已完成" />);

    expect(screen.getByRole('button', { name: '收合已完成' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '收合數學' })).not.toBeInTheDocument();
    expect([...document.querySelectorAll('.trow .title')].map(node => node.textContent))
      .toEqual(['最近完成', '較早完成']);
  });
});
