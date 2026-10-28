// 學校作業表單寫入／刷新邊界（作業頁、Today、行事曆）：POST/PATCH 已成功但
// reload 失敗時，表單照常關閉（不能留著讓人重送），但呼叫端必須提示「已儲存、
// 畫面未更新」並只提供重新載入——不能默默停在舊畫面，讓使用者以為沒存到。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { nowTW } from '../tt/schoolAssignment';
import { today } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const SchoolAssignmentView = (await import('../tt/SchoolAssignmentView')).default;
const { SchoolAssignmentToday } = await import('../tt/SchoolAssignmentView');
const CalendarView = (await import('../tt/CalendarView')).default;

const sa = (o = {}) => ({
  id: 1, task_kind: 'school_assignment', school_assignment_type: 'homework',
  title: '作業', list_id: 1, deadline_date: '2026-09-10', deadline_time: null,
  completed: 0, cancelled: 0, deleted: 0, tags: [], subtasks: [], ...o,
});
const lists = [{ id: 1, name: '數學' }];
const writes = () => api.mock.calls.filter(([path, opts]) => String(path).startsWith('/tasks') && ['POST', 'PATCH'].includes(opts?.method));

async function expectRecoverable(reload, form) {
  expect(await screen.findByRole('alert')).toHaveTextContent('作業已儲存，但畫面暫時無法重新載入');
  // 表單已關閉，沒有可再按一次的送出鈕
  expect(document.querySelector(form)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(reload).toHaveBeenCalledTimes(2);
  expect(writes()).toHaveLength(1);
}

describe('學校作業表單：寫入成功但刷新失敗要可見且可重試', () => {
  beforeEach(() => { api.mockReset(); });

  it('作業頁新增：POST 成功、reload 失敗 → 提示並只重試 reload', async () => {
    api.mockResolvedValue({ id: 301 });
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    render(<SchoolAssignmentView tasks={[]} lists={lists} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增第一份作業' }));
    fireEvent.change(screen.getByPlaceholderText(/第 3 章習題/), { target: { value: '講義第 5 頁' } });
    fireEvent.change(screen.getByLabelText(/截止日期/), { target: { value: '2026-09-20' } });
    fireEvent.click(screen.getByRole('button', { name: '新增作業' }));
    await expectRecoverable(reload, '.sa-form');
    expect(reload).toHaveBeenNthCalledWith(1, 'tasks');
    expect(writes()[0][1].method).toBe('POST');
  });

  it('作業頁編輯：PATCH 成功、reload 失敗 → 提示並只重試 reload', async () => {
    api.mockResolvedValue({ id: 302 });
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    render(<SchoolAssignmentView tasks={[sa({ id: 302, title: '舊標題', deadline_date: '2099-01-01' })]} lists={lists} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: '編輯 舊標題' }));
    fireEvent.change(screen.getByDisplayValue('舊標題'), { target: { value: '新標題' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await expectRecoverable(reload, '.sa-form');
    expect(writes()[0][0]).toBe('/tasks/302');
  });

  it('Today 編輯：PATCH 成功、reload 失敗 → 提示並只重試 reload', async () => {
    api.mockResolvedValue({ id: 303 });
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    const t = sa({ id: 303, title: '今天的作業', deadline_date: nowTW().date, deadline_time: '23:59' });
    render(<SchoolAssignmentToday tasks={[t]} lists={lists} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: '編輯 今天的作業' }));
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await expectRecoverable(reload, '.sa-form');
  });

  it('行事曆編輯：PATCH 成功、reload 失敗 → 提示並只重試 reload', async () => {
    api.mockImplementation((path, opts) => Promise.resolve(opts?.method === 'PATCH' ? { id: 304 } : []));
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    const t = sa({ id: 304, title: '物理報告', school_assignment_type: 'report', deadline_date: today() });
    render(<CalendarView tasks={[t]} reload={reload} lists={lists} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'day' } });
    // Calendar 掛載後會非同步讀取排程資料並重繪；等初始讀取完成後再取目前的期限標記，
    // 避免點到重繪前已脫離 DOM 的節點。
    await waitFor(() => expect(api).toHaveBeenCalled());
    fireEvent.click(screen.getByTitle(/截止：物理報告/));
    fireEvent.click(await screen.findByRole('button', { name: '儲存' }));
    await expectRecoverable(reload, '.sa-form');
  });

  it('刷新成功時不顯示任何錯誤', async () => {
    api.mockResolvedValue({ id: 305 });
    const reload = vi.fn().mockResolvedValue(undefined);
    render(<SchoolAssignmentView tasks={[sa({ id: 305, title: '正常作業', deadline_date: '2099-01-01' })]} lists={lists} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: '編輯 正常作業' }));
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(document.querySelector('.sa-form')).toBeNull());
    expect(reload).toHaveBeenCalledWith('tasks');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
