import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Tasks from '../tt/Tasks';

const lists = [{ id: 10, name: '物理' }, { id: 20, name: '英文' }];
const tasks = [
  { id: 1, title: '牛頓運動定律', list_id: 10, priority: 0, completed: false, deleted: false, tags: [], subtasks: [] },
  { id: 2, title: '閱讀第二課', list_id: 20, priority: 0, completed: false, deleted: false, tags: [], subtasks: [] },
];

describe('任務群組收合', () => {
  it('照科目分堆後可個別收合與展開，不改動其他群組', () => {
    render(<Tasks view={{ type: 'tasks' }} tasks={tasks} lists={lists} filters={[]} reload={vi.fn()} title="任務" />);
    fireEvent.change(screen.getByLabelText('排序方式'), { target: { value: 'subjectGroup' } });

    const physics = screen.getByRole('button', { name: '收合物理' });
    expect(physics).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(physics);

    expect(screen.queryByText('牛頓運動定律')).not.toBeInTheDocument();
    expect(screen.getByText('閱讀第二課')).toBeInTheDocument();
    const reopen = screen.getByRole('button', { name: '展開物理' });
    expect(reopen).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(reopen);
    expect(screen.getByText('牛頓運動定律')).toBeInTheDocument();
  });
});
