import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Tasks from '../tt/Tasks';

const lists = [{ id: 1, name: '物理', color: '#06c' }];
const task = (id, title, tags) => ({
  id, title, tags, list_id: 1, completed: false, deleted: false,
  due_date: '2099-01-01', due_time: null, priority: 0, subtasks: [], notes: '',
});

describe('任務標籤篩選', () => {
  beforeEach(() => localStorage.clear());

  it('可用既有標籤縮小清單，並記住選擇', () => {
    const props = {
      view: { type: 'tasks' },
      tasks: [task(1, '複習力學', ['複習']), task(2, '完成講義', ['作業'])],
      lists, filters: {}, habits: [], reload: vi.fn(), title: '任務',
    };
    const { unmount } = render(<Tasks {...props} />);

    fireEvent.change(screen.getByLabelText('依標籤篩選'), { target: { value: '複習' } });
    expect(screen.getByText('複習力學')).toBeInTheDocument();
    expect(screen.queryByText('完成講義')).not.toBeInTheDocument();
    expect(localStorage.getItem('taskTagFilter')).toBe('複習');

    unmount();
    render(<Tasks {...props} />);
    expect(screen.getByLabelText('依標籤篩選')).toHaveValue('複習');
    expect(screen.queryByText('完成講義')).not.toBeInTheDocument();
  });
});
