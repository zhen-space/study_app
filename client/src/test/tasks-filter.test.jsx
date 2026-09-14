// §E：任務總表第一層 filters（全部／今天／逾期／未排程）＋ 列的兩層資訊（科目名，非神秘色點）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn(() => Promise.resolve([])) }));
const Tasks = (await import('../tt/Tasks')).default;

const TD = today();
const lists = [{ id: 1, name: '數學', color: '#3b82f6' }];
const mk = (id, over) => ({ id, title: 't' + id, due_date: null, due_time: null, list_id: null, completed: 0, deleted: 0, tags: [], subtasks: [], priority: 0, order_index: id, notes: '', ...over });
const tasks = [
  mk(1, { title: '今天要做', due_date: TD, list_id: 1 }),
  mk(2, { title: '逾期沒做', due_date: addDays(TD, -2), list_id: 1 }),
  mk(3, { title: '還沒排時間' }),
];

beforeEach(() => { try { localStorage.clear(); } catch {} });
const mount = () => render(<Tasks view={{ type: 'tasks' }} tasks={tasks} lists={lists} filters={[]} reload={() => {}} title="任務" />);

describe('§E 任務第一層 filters', () => {
  it('顯示 全部／今天／逾期／未排程，帶數量；預設全部都在', () => {
    mount();
    const tabs = screen.getByRole('tablist', { name: '任務篩選' });
    expect(within(tabs).getByRole('tab', { name: /全部/ })).toBeTruthy();
    expect(within(tabs).getByRole('tab', { name: /今天/ }).textContent).toContain('1');
    expect(within(tabs).getByRole('tab', { name: /逾期/ }).textContent).toContain('1');
    expect(screen.getByText('今天要做')).toBeTruthy();
    expect(screen.getByText('逾期沒做')).toBeTruthy();
    expect(screen.getByText('還沒排時間')).toBeTruthy();
  });

  it('點「逾期」只留逾期那一筆', () => {
    mount();
    const tabs = screen.getByRole('tablist', { name: '任務篩選' });
    fireEvent.click(within(tabs).getByRole('tab', { name: /逾期/ }));
    expect(screen.getByText('逾期沒做')).toBeTruthy();
    expect(screen.queryByText('今天要做')).toBeNull();
    expect(screen.queryByText('還沒排時間')).toBeNull();
  });

  it('列第二層直接寫科目名，不是只有一顆要記色碼的圓點', () => {
    mount();
    // 兩筆掛在「數學」，科目名應該看得到
    expect(screen.getAllByText('數學').length).toBeGreaterThanOrEqual(1);
  });
});
