import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Tasks, { taskMatchesQuery } from '../tt/Tasks';

const tasks = [
  { id: 1, title: '數學第三章', notes: '複習二次函數', tags: ['重要'], list_id: 10, priority: 1, completed: false, deleted: false, due_date: '2099-01-02', subtasks: [] },
  { id: 2, title: '整理講義', notes: '圈出生字', tags: ['閱讀'], list_id: 20, priority: 0, completed: false, deleted: false, due_date: '2099-01-03', subtasks: [] },
];
const lists = [{ id: 10, name: '數學' }, { id: 20, name: '英文' }];

describe('任務 Quick Find', () => {
  it('可搜尋標題、備註、標籤、科目，並正規化全形字元', () => {
    expect(taskMatchesQuery(tasks[0], '二次函數', '數學')).toBe(true);
    expect(taskMatchesQuery(tasks[0], '重要', '數學')).toBe(true);
    expect(taskMatchesQuery(tasks[0], '數學', '數學')).toBe(true);
    expect(taskMatchesQuery({ ...tasks[0], title: 'Chapter 3' }, 'Ｃｈａｐｔｅｒ', '數學')).toBe(true);
    expect(taskMatchesQuery(tasks[0], '英文', '數學')).toBe(false);
  });

  it('在任務頁直接篩選目前清單，並可一鍵清除', () => {
    render(<Tasks view={{ type: 'tasks' }} tasks={tasks} lists={lists} filters={[]} reload={() => {}} title="所有任務" />);

    const search = screen.getByRole('search');
    fireEvent.change(within(search).getByLabelText('搜尋目前任務'), { target: { value: '英文' } });
    expect(screen.queryByText('數學第三章')).not.toBeInTheDocument();
    expect(screen.getByText('整理講義')).toBeInTheDocument();

    fireEvent.click(within(search).getByRole('button', { name: '清除任務搜尋' }));
    expect(screen.getByText('數學第三章')).toBeInTheDocument();
    expect(screen.getByText('整理講義')).toBeInTheDocument();
  });

  it.each([
    ['completed', { ...tasks[0], completed: true }, '已完成'],
    ['trash', { ...tasks[0], deleted: true }, '垃圾桶'],
  ])('在 %s 視圖也能搜尋歷史任務', (type, task, title) => {
    render(<Tasks view={{ type }} tasks={[task, { ...task, id: 9, title: '英文作文', list_id: 20 }]} lists={lists}
      filters={[]} reload={() => {}} title={title} />);

    fireEvent.change(screen.getByLabelText('搜尋目前任務'), { target: { value: '數學' } });
    expect(screen.getByText('數學第三章')).toBeInTheDocument();
    expect(screen.queryByText('英文作文')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('搜尋目前任務'), { target: { value: '不存在' } });
    expect(screen.getByText('找不到符合搜尋的任務')).toBeInTheDocument();
  });
});
