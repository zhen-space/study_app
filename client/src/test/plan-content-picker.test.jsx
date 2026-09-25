import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

describe('PlanContentPicker', () => {
  beforeEach(() => vi.clearAllMocks());

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
});
