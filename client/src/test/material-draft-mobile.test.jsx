import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import MaterialDraftEditor from '../tt/MaterialDraftEditor';

it('自訂類型隨教材送出；左滑先顯示刪除，且只刪所選內容', () => {
  const submit = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState({
      book: { title: '物理題本', book_type: '講義', subject_list_id: 2 },
      chapters: [{ title: '力學', children: [], content_items: [
        { title: '保留這題', kind: 'reading' },
        { title: '刪掉這題', kind: 'unit_exercise' },
      ] }],
    });
    return <MaterialDraftEditor value={draft} onChange={setDraft} onSubmit={submit} />;
  }
  render(<Editor />);
  fireEvent.change(screen.getByLabelText('教材類型'), { target: { value: '__custom' } });
  const save = screen.getByRole('button', { name: '建立教材' });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText('自訂教材類型名稱'), { target: { value: '老師自編' } });
  const row = screen.getByText('刪掉這題').closest('.md-swipe');
  fireEvent.touchStart(row, { touches: [{ clientX: 240, clientY: 120 }] });
  fireEvent.touchEnd(row, { changedTouches: [{ clientX: 120, clientY: 121 }] });
  expect(within(row).getByText('刪掉這題')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: '刪除', exact: true }));
  fireEvent.click(save);
  expect(submit.mock.calls[0][0].book.book_type).toBe('老師自編');
  expect(submit.mock.calls[0][0].chapters[0].content_items.map(i => i.title)).toEqual(['保留這題']);
});
