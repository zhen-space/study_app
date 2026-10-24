import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../tt/material', () => ({
  listShelf: vi.fn(), getBookTree: vi.fn(),
  flattenItems: tree => tree.items || [],
}));
const material = await import('../tt/material');
const PlanContentPicker = (await import('../tt/PlanContentPicker')).default;

const tasks = [
  { id: 1, title: '整理數學筆記', list_id: 10, plan_id: null, task_kind: 'standard' },
  { id: 2, title: '物理作業', list_id: 11, plan_id: null, task_kind: 'school_assignment', deadline_date: '2026-10-01' },
  { id: 3, title: '已在計畫', list_id: 10, plan_id: 9, task_kind: 'standard' },
];
const lists = [{ id: 10, name: '數學' }, { id: 11, name: '物理' }];

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

describe('PlanContentPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    material.listShelf.mockReset();
    material.getBookTree.mockReset();
  });

  it('選 existing Task 後只產生 preview intent，不直接寫 Task', () => {
    const onPreview = vi.fn();
    render(<PlanContentPicker planId={9} tasks={tasks} lists={lists} onClose={() => {}} onPreview={onPreview} />);
    fireEvent.click(screen.getByText('整理數學筆記'));
    fireEvent.click(screen.getByRole('button', { name: '預覽安排（1）' }));
    expect(onPreview).toHaveBeenCalledWith({ addTaskIds: [1], materialSelections: [] });
  });

  it('學校作業與已在其他 Plan 的任務分開，不能誤選', () => {
    render(<PlanContentPicker planId={9} tasks={tasks} lists={lists} onClose={() => {}} onPreview={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '學校作業' }));
    expect(screen.getByText('物理作業')).toBeInTheDocument();
    expect(screen.queryByText('已在計畫')).not.toBeInTheDocument();
  });

  it('教材選取只送 content identity，不先寫 selection', async () => {
    material.listShelf.mockResolvedValue({ books: [{ material_book_id: 5, title: '數學第一冊' }] });
    material.getBookTree.mockResolvedValue({ items: [{ id: 81, title: '第一章', estimated_minutes: 60, path: ['Ch1'], completed: false, selected: false }] });
    const onPreview = vi.fn();
    render(<PlanContentPicker planId={9} tasks={tasks} lists={lists} onClose={() => {}} onPreview={onPreview} />);
    fireEvent.click(screen.getByRole('button', { name: '教材範圍' }));
    fireEvent.click(await screen.findByText('數學第一冊'));
    fireEvent.click(await screen.findByText('第一章'));
    await waitFor(() => expect(screen.getByRole('button', { name: '預覽安排（1）' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '預覽安排（1）' }));
    expect(onPreview).toHaveBeenCalledWith({ addTaskIds: [], materialSelections: [{ content_item_id: 81, client_key: 'mat-81' }] });
  });

  it('教材清單讀取失敗時不誤報為沒有教材，且可直接重試', async () => {
    material.listShelf
      .mockRejectedValueOnce(new Error('暫時無法讀取教材'))
      .mockResolvedValueOnce({ books: [{ material_book_id: 5, title: '數學第一冊' }] });
    render(<PlanContentPicker planId={9} tasks={tasks} lists={lists} onClose={() => {}} onPreview={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '教材範圍' }));
    expect(await screen.findByText('暫時無法讀取教材')).toBeInTheDocument();
    expect(screen.queryByText('沒有可用教材')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重試載入教材' }));
    expect(await screen.findByText('數學第一冊')).toBeInTheDocument();
    expect(material.listShelf).toHaveBeenCalledTimes(2);
  });

  it('教材內容讀取失敗時不誤報為空內容，且可直接重試', async () => {
    material.listShelf.mockResolvedValue({ books: [{ material_book_id: 5, title: '數學第一冊' }] });
    material.getBookTree
      .mockRejectedValueOnce(new Error('暫時無法讀取內容'))
      .mockResolvedValueOnce({ items: [{ id: 81, title: '第一章', estimated_minutes: 60, path: ['Ch1'], completed: false, selected: false }] });
    render(<PlanContentPicker planId={9} tasks={tasks} lists={lists} onClose={() => {}} onPreview={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '教材範圍' }));
    fireEvent.click(await screen.findByText('數學第一冊'));
    expect(await screen.findByText('暫時無法讀取內容')).toBeInTheDocument();
    expect(screen.queryByText('這本教材沒有可加入的內容')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重試載入內容' }));
    expect(await screen.findByText('第一章')).toBeInTheDocument();
    expect(material.getBookTree).toHaveBeenCalledTimes(2);
  });

  it('返回後改選另一本教材時，較慢的舊回應不會覆蓋目前範圍', async () => {
    const first = deferred();
    const second = deferred();
    material.listShelf.mockResolvedValue({ books: [
      { material_book_id: 5, title: '數學第一冊' },
      { material_book_id: 6, title: '數學第二冊' },
    ] });
    material.getBookTree.mockImplementation(id => id === 5 ? first.promise : second.promise);
    render(<PlanContentPicker planId={9} tasks={tasks} lists={lists} onClose={() => {}} onPreview={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '教材範圍' }));
    fireEvent.click(await screen.findByText('數學第一冊'));
    fireEvent.click(screen.getByRole('button', { name: '← 選其他教材' }));
    fireEvent.click(screen.getByText('數學第二冊'));

    await act(async () => second.resolve({ items: [
      { id: 82, title: '第二冊目前範圍', estimated_minutes: 40, path: ['Ch2'], completed: false, selected: false },
    ] }));
    expect(await screen.findByText('第二冊目前範圍')).toBeInTheDocument();

    await act(async () => first.resolve({ items: [
      { id: 81, title: '第一冊過期範圍', estimated_minutes: 60, path: ['Ch1'], completed: false, selected: false },
    ] }));
    expect(screen.getByText('第二冊目前範圍')).toBeInTheDocument();
    expect(screen.queryByText('第一冊過期範圍')).not.toBeInTheDocument();
  });
});
