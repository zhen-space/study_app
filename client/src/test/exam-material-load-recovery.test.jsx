// 段考建立的教材選取：API 失敗不可假裝成「沒有教材／沒有目錄」，避免使用者重複建立資料。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
vi.mock('../tt/material', () => ({
  listShelf: vi.fn(), getBookTree: vi.fn(), flattenItems: vi.fn(tree => tree?.items || []),
}));
const material = await import('../tt/material');
const ExamCreateWizard = (await import('../tt/ExamCreateWizard')).default;

const LISTS = [{ id: 1, name: '數學' }];

beforeEach(() => {
  localStorage.clear();
  material.listShelf.mockReset();
  material.getBookTree.mockReset();
});
afterEach(cleanup);

async function openMaterialPicker() {
  render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText('段考名稱'), { target: { value: '第二次段考' } });
  fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-02' } });
  fireEvent.change(screen.getByLabelText('加入科目'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: '下一步：加入各科範圍' }));
  fireEvent.click(await screen.findByRole('button', { name: '選教材／勾課章' }));
}

describe('段考教材載入失敗恢復', () => {
  it('書櫃 API 失敗時顯示重試，不誤稱這科沒有教材', async () => {
    material.listShelf
      .mockRejectedValueOnce(new Error('網路暫時中斷'))
      .mockResolvedValueOnce({ books: [{ material_book_id: 5, subject_list_id: 1, title: '數學第一冊' }] });

    await openMaterialPicker();
    expect(await screen.findByText('網路暫時中斷')).toBeInTheDocument();
    expect(screen.queryByText('這科還沒有教材')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重試載入教材' }));
    expect(await screen.findByText('數學第一冊')).toBeInTheDocument();
    expect(material.listShelf).toHaveBeenCalledTimes(2);
  });

  it('目錄 API 失敗時保留教材並可重試，不誤稱這本沒有目錄', async () => {
    material.listShelf.mockResolvedValue({ books: [{ material_book_id: 5, subject_list_id: 1, title: '數學第一冊' }] });
    material.getBookTree
      .mockRejectedValueOnce(new Error('目錄載入失敗'))
      .mockResolvedValueOnce({ items: [{ id: 81, title: '第一章', path: ['第一冊'], estimated_minutes: 60 }] });

    await openMaterialPicker();
    fireEvent.click(await screen.findByText('數學第一冊'));
    expect(await screen.findByText('目錄載入失敗')).toBeInTheDocument();
    expect(screen.queryByText('這本還沒有目錄。')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重試載入目錄' }));
    await waitFor(() => expect(screen.getByText('第一章')).toBeInTheDocument());
    expect(material.getBookTree).toHaveBeenCalledTimes(2);
  });
});
