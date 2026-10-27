// 科目篩選指向「目前清單裡沒有的選項」時（科目被刪、科目清單尚未載入、最後一筆未分科目
// 被移走），下拉必須如實顯示目前的篩選，不能視覺上退回「全部科目」卻仍把清單濾成空的；
// 也不能自動清掉——那可能只是暫時零結果的合法篩選。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn(() => Promise.resolve([])) }));
const Tasks = (await import('../tt/Tasks')).default;

const lists = [{ id: 1, name: '數學', color: '#3b82f6' }];
const mk = (id, over) => ({ id, title: 't' + id, due_date: null, due_time: null, list_id: null, completed: 0, deleted: 0, tags: [], subtasks: [], priority: 0, order_index: id, notes: '', ...over });
const props = over => ({ view: { type: 'tasks' }, lists, filters: [], habits: [], reload: vi.fn(), title: '任務', ...over });
const selectedLabel = select => select.options[select.selectedIndex]?.textContent;

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
});

describe('375px 任務科目篩選：選項消失時不冒充「全部科目」', () => {
  it('記住的科目已不存在：下拉顯示實際篩選，改選「全部科目」即可恢復', () => {
    localStorage.setItem('taskSubjectFilter', '9');
    render(<Tasks {...props({ tasks: [mk(1, { title: '微積分', list_id: 1 })] })} />);

    const select = screen.getByLabelText('依科目篩選');
    expect(select).toHaveValue('9');
    expect(selectedLabel(select)).toBe('找不到的科目');
    expect(selectedLabel(select)).not.toBe('全部科目');
    expect(screen.queryByText('微積分')).toBeNull();
    // 不自動清除記憶
    expect(localStorage.getItem('taskSubjectFilter')).toBe('9');

    // 「全部科目」此時是另一個選項，選它會真的改變值（瀏覽器才會觸發 change）
    expect(select.value).not.toBe('');
    fireEvent.change(select, { target: { value: '' } });
    expect(select).toHaveValue('');
    expect(screen.getByText('微積分')).toBeTruthy();
    expect(localStorage.getItem('taskSubjectFilter')).toBe('');
    expect(screen.queryByRole('option', { name: '找不到的科目' })).toBeNull();
  });

  it('刷新後科目清單尚未載入：保留記住的篩選，載入後對回原科目', () => {
    localStorage.setItem('taskSubjectFilter', '1');
    const tasks = [mk(1, { title: '微積分', list_id: 1 })];
    const { rerender } = render(<Tasks {...props({ tasks, lists: [] })} />);

    // 載入前：下拉仍在、如實顯示篩選中，記憶不被清掉
    const loading = screen.getByLabelText('依科目篩選');
    expect(loading).toHaveValue('1');
    expect(selectedLabel(loading)).not.toBe('全部科目');
    expect(screen.getByRole('button', { name: '清除篩選' })).toBeTruthy();
    expect(localStorage.getItem('taskSubjectFilter')).toBe('1');

    rerender(<Tasks {...props({ tasks })} />);
    const loaded = screen.getByLabelText('依科目篩選');
    expect(loaded).toHaveValue('1');
    expect(selectedLabel(loaded)).toBe('數學');
    expect(screen.queryByRole('option', { name: '找不到的科目' })).toBeNull();
    expect(screen.getByText('微積分')).toBeTruthy();
    expect(localStorage.getItem('taskSubjectFilter')).toBe('1');
  });

  it('最後一筆未分科目被移走：仍顯示「未分科目」篩選（暫時零結果），不自動清除', () => {
    const before = [mk(1, { title: '收件匣雜事' }), mk(2, { title: '微積分', list_id: 1 })];
    const { rerender } = render(<Tasks {...props({ tasks: before })} />);
    fireEvent.change(screen.getByLabelText('依科目篩選'), { target: { value: '__none__' } });
    expect(screen.getByText('收件匣雜事')).toBeTruthy();

    // 使用者把它歸到「數學」，重抓後已沒有任何未分科目任務
    rerender(<Tasks {...props({ tasks: [mk(1, { title: '收件匣雜事', list_id: 1 }), before[1]] })} />);
    const select = screen.getByLabelText('依科目篩選');
    expect(select).toHaveValue('__none__');
    expect(selectedLabel(select)).toBe('未分科目');
    expect(screen.queryByText('收件匣雜事')).toBeNull();
    expect(screen.queryByText('微積分')).toBeNull();
    expect(localStorage.getItem('taskSubjectFilter')).toBe('__none__');

    fireEvent.change(select, { target: { value: '' } });
    expect(screen.getByText('收件匣雜事')).toBeTruthy();
    expect(screen.getByText('微積分')).toBeTruthy();
    // 篩選解除後，沒有未分科目任務就不再列出這個選項
    expect(screen.queryByRole('option', { name: '未分科目' })).toBeNull();
  });

  it('沒有任何科目與未分科目任務時，有效的科目篩選仍可從下拉解除', () => {
    localStorage.setItem('taskSubjectFilter', '__none__');
    render(<Tasks {...props({ tasks: [], lists: [] })} />);
    const select = screen.getByLabelText('依科目篩選');
    expect(select).toHaveValue('__none__');
    fireEvent.change(select, { target: { value: '' } });
    expect(localStorage.getItem('taskSubjectFilter')).toBe('');
    // 回到預設、無任何科目可選時，下拉照舊收起
    expect(screen.queryByLabelText('依科目篩選')).toBeNull();
  });
});
