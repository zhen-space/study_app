import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Detail } from '../tt/Tasks';

vi.mock('../api', () => ({ api: vi.fn(() => Promise.resolve([])) }));

const base = {
  id: 7, title: '英文作業', notes: '', priority: 0, tags: [],
  subtasks: [{ title: '第一題', done: false }], list_id: 1,
  task_kind: 'school_assignment', school_assignment_type: 'homework',
  deadline_date: '2030-08-20', deadline_time: '20:00', estimated_minutes: 30,
};

describe('Task Detail 中文 IME autosave', () => {
  it('標題組字中只更新草稿，compositionEnd 才儲存一次且期間不能完成', () => {
    const onSave = vi.fn(); const onClose = vi.fn();
    render(<Detail task={base} lists={[]} onSave={onSave} onDelete={vi.fn()} onClose={onClose} />);
    const title = screen.getByDisplayValue('英文作業');
    const done = screen.getByTitle('完成編輯');

    fireEvent.compositionStart(title);
    fireEvent.change(title, { target: { value: '英文ㄗ' } });
    expect(title).toHaveValue('英文ㄗ');
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: '2' } });
    expect(onSave).not.toHaveBeenCalled();
    expect(done).toBeDisabled();
    fireEvent.click(done);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.compositionEnd(title, { data: '作業', target: { value: '英文作業更新' } });
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ title: '英文作業更新' }));
  });

  it('既有子任務組字結束後只儲存 final value 一次', () => {
    const onSave = vi.fn();
    render(<Detail task={{ ...base, task_kind: 'task' }} lists={[]} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} />);
    const subtask = screen.getByDisplayValue('第一題');
    fireEvent.compositionStart(subtask);
    fireEvent.change(subtask, { target: { value: '第一ㄊ' } });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.compositionEnd(subtask, { data: '題', target: { value: '第一題更新' } });
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0].subtasks[0].title).toBe('第一題更新');
  });
});
