// §E：任務總表第一層 filters（全部／今天／逾期／未排程）＋ 列的兩層資訊（科目名，非神秘色點）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn(() => Promise.resolve([])) }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

const TD = today();
const lists = [{ id: 1, name: '數學', color: '#3b82f6' }];
const mk = (id, over) => ({ id, title: 't' + id, due_date: null, due_time: null, list_id: null, completed: 0, deleted: 0, tags: [], subtasks: [], priority: 0, order_index: id, notes: '', ...over });
const tasks = [
  mk(1, { title: '今天要做', due_date: TD, list_id: 1, priority: 3 }),
  mk(2, { title: '逾期沒做', due_date: addDays(TD, -2), list_id: 1 }),
  mk(3, { title: '還沒排時間' }),
  mk(4, { title: '每天背單字', due_date: addDays(TD, 2), recurring: 'daily' }),
];

beforeEach(() => { try { localStorage.clear(); } catch {} api.mockReset(); api.mockResolvedValue([]); });
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
    expect(screen.getByText('每天背單字')).toBeTruthy();
  });

  it('點「逾期」只留逾期那一筆', () => {
    mount();
    const tabs = screen.getByRole('tablist', { name: '任務篩選' });
    fireEvent.click(within(tabs).getByRole('tab', { name: /逾期/ }));
    expect(screen.getByText('逾期沒做')).toBeTruthy();
    expect(screen.queryByText('今天要做')).toBeNull();
    expect(screen.queryByText('還沒排時間')).toBeNull();
  });

  it('逾期篩選可將一般任務安全批次移到今天', async () => {
    const reload = vi.fn().mockResolvedValue();
    render(<Tasks view={{ type: 'tasks' }} tasks={tasks} lists={lists} filters={[]} reload={reload} title="任務" />);
    fireEvent.click(within(screen.getByRole('tablist', { name: '任務篩選' })).getByRole('tab', { name: /逾期/ }));
    fireEvent.click(screen.getByRole('button', { name: '全部移到今天（1）' }));

    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/2', { method: 'PATCH', body: { due_date: TD } }));
    expect(reload).toHaveBeenCalledWith('tasks');
  });

  it('批次重新安排不包含計畫管理任務與學校作業', () => {
    const protectedTasks = [
      mk(7, { title: '計畫進度', due_date: addDays(TD, -1), plan_id: 9 }),
      mk(8, { title: '學校作業', due_date: addDays(TD, -1), task_kind: 'school_assignment' }),
    ];
    render(<Tasks view={{ type: 'tasks' }} tasks={protectedTasks} lists={lists} filters={[]} reload={vi.fn()} title="任務" />);
    fireEvent.click(within(screen.getByRole('tablist', { name: '任務篩選' })).getByRole('tab', { name: /逾期/ }));
    expect(screen.queryByRole('button', { name: /全部移到今天/ })).toBeNull();
  });

  it('點「有優先級」只顯示已設定優先級的任務', () => {
    mount();
    const tabs = screen.getByRole('tablist', { name: '任務篩選' });
    fireEvent.click(within(tabs).getByRole('tab', { name: /有優先級/ }));
    expect(screen.getByText('今天要做')).toBeTruthy();
    expect(screen.queryByText('逾期沒做')).toBeNull();
    expect(screen.queryByText('還沒排時間')).toBeNull();
    expect(screen.queryByText('每天背單字')).toBeNull();
  });

  it('點「重複」只顯示有重複規則的任務', () => {
    mount();
    const tabs = screen.getByRole('tablist', { name: '任務篩選' });
    fireEvent.click(within(tabs).getByRole('tab', { name: /重複/ }));
    expect(screen.getByText('每天背單字')).toBeTruthy();
    expect(screen.queryByText('今天要做')).toBeNull();
    expect(screen.queryByText('逾期沒做')).toBeNull();
    expect(screen.queryByText('還沒排時間')).toBeNull();
  });

  it('可一鍵清除疊加的搜尋、日期與科目篩選', () => {
    mount();
    fireEvent.change(screen.getByLabelText('搜尋目前任務'), { target: { value: '今天' } });
    fireEvent.click(within(screen.getByRole('tablist', { name: '任務篩選' })).getByRole('tab', { name: /今天/ }));
    fireEvent.change(screen.getByLabelText('依科目篩選'), { target: { value: '1' } });

    fireEvent.click(screen.getByRole('button', { name: '清除篩選' }));

    expect(screen.getByLabelText('搜尋目前任務')).toHaveValue('');
    expect(screen.getByLabelText('依科目篩選')).toHaveValue('');
    expect(within(screen.getByRole('tablist', { name: '任務篩選' })).getByRole('tab', { name: /全部/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('今天要做')).toBeTruthy();
    expect(screen.getByText('逾期沒做')).toBeTruthy();
    expect(screen.getByText('還沒排時間')).toBeTruthy();
  });

  it('會記住科目篩選，清除後也同步移除記憶', () => {
    mount();
    fireEvent.change(screen.getByLabelText('依科目篩選'), { target: { value: '1' } });
    expect(localStorage.getItem('taskSubjectFilter')).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: '清除篩選' }));
    expect(localStorage.getItem('taskSubjectFilter')).toBe('');
  });

  it('可只看未分科目的收件匣任務', () => {
    mount();
    fireEvent.change(screen.getByLabelText('依科目篩選'), { target: { value: '__none__' } });

    expect(screen.getByText('還沒排時間')).toBeTruthy();
    expect(screen.getByText('每天背單字')).toBeTruthy();
    expect(screen.queryByText('今天要做')).toBeNull();
    expect(screen.queryByText('逾期沒做')).toBeNull();
    expect(localStorage.getItem('taskSubjectFilter')).toBe('__none__');
  });

  it('列第二層直接寫科目名，不是只有一顆要記色碼的圓點', () => {
    mount();
    // 兩筆掛在「數學」，科目名應該看得到
    expect(screen.getAllByText('數學').length).toBeGreaterThanOrEqual(1);
  });
});
