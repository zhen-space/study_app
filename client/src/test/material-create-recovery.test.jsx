import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tt/material', () => ({
  importPreview: vi.fn(),
  commitDraft: vi.fn(),
  nameCheck: vi.fn(),
  ITEM_LABEL: {
    reading: '課本內容', example: '範例', example_problem: '例題',
    unit_exercise: '單元練習', past_exam: '歷屆試題',
  },
}));
vi.mock('../tt/vocabImport', () => ({ fileToPayload: vi.fn() }));

import AddMaterialFlow from '../tt/AddMaterialFlow';
import { commitDraft, importPreview, nameCheck } from '../tt/material';
import { fileToPayload } from '../tt/vocabImport';

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function readyManual(props = {}) {
  render(<AddMaterialFlow lists={[{ id: 1, name: '英文' }]} onCancel={vi.fn()} {...props} />);
  fireEvent.click(screen.getByText('自己建立教材'));
  fireEvent.change(screen.getByLabelText('教材名稱'), { target: { value: '英文課本' } });
  fireEvent.change(screen.getByLabelText('第 1 章名稱'), { target: { value: '第一課' } });
  fireEvent.click(screen.getByRole('button', { name: '第 1 章：加入單元練習' }));
  return screen.getByRole('button', { name: '建立教材' });
}

describe('AddMaterialFlow committed recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nameCheck.mockResolvedValue({ has_conflict: false, same_name_books: [] });
    commitDraft.mockResolvedValue({ book: { id: 77, title: '英文課本' } });
    fileToPayload.mockImplementation(async file => ({ filename: file.name, mime: file.type, data: 'AAAA' }));
    importPreview.mockResolvedValue({
      draft: {
        book: { title: '英文課本', publisher: '龍騰', subject_list_id: 1 },
        chapters: [{ title: '第一課', content_items: [{ kind: 'reading', title: 'L1' }], children: [] }],
      },
      problems: [], warnings: [],
    });
  });

  it('moves to a non-repeatable committed state while the parent refresh is pending', async () => {
    const refresh = deferred();
    const onCreated = vi.fn(() => refresh.promise);
    const submit = readyManual({ onCreated });

    fireEvent.click(submit);
    expect(await screen.findByText('教材已建立')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '建立教材' })).not.toBeInTheDocument();
    expect(commitDraft).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith({ book: { id: 77, title: '英文課本' } });

    refresh.resolve();
    await act(async () => { await refresh.promise; });
  });

  it('retries only the parent refresh after commit succeeded', async () => {
    const onCreated = vi.fn()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(undefined);
    const submit = readyManual({ onCreated });
    fireEvent.click(submit);

    expect(await screen.findByRole('alert')).toHaveTextContent('教材已建立，但畫面暫時無法更新');
    expect(screen.getByText(/不需要再次建立/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新載入' })); });

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2));
    expect(commitDraft).toHaveBeenCalledOnce();
  });

  it('keeps the draft editable and retryable after a real commit failure', async () => {
    commitDraft
      .mockRejectedValueOnce(new Error('建立失敗'))
      .mockResolvedValueOnce({ book: { id: 77, title: '英文課本' } });
    const onCreated = vi.fn();
    const submit = readyManual({ onCreated });

    fireEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('建立失敗');
    expect(screen.getByLabelText('教材名稱')).toHaveValue('英文課本');
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(commitDraft).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('教材已建立')).toBeInTheDocument();
  });

  it('synchronously guards a re-entrant commit', async () => {
    let submit;
    let nested = false;
    nameCheck.mockImplementation(() => {
      if (!nested) {
        nested = true;
        fireEvent.click(submit);
      }
      return Promise.resolve({ has_conflict: false, same_name_books: [] });
    });
    submit = readyManual({ onCreated: vi.fn() });
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByText('教材已建立')).toBeInTheDocument());
    expect(commitDraft).toHaveBeenCalledOnce();
  });

  it.each([
    ['單張照片', [new File(['a'], 'one.jpg', { type: 'image/jpeg' })]],
    ['多張照片', [new File(['a'], 'one.jpg', { type: 'image/jpeg' }), new File(['b'], 'two.png', { type: 'image/png' })]],
    ['PDF', [new File(['pdf'], 'toc.pdf', { type: 'application/pdf' })]],
  ])('%s uses the same non-repeatable committed path', async (_label, files) => {
    const refresh = deferred();
    render(<AddMaterialFlow lists={[{ id: 1, name: '英文' }]} onCancel={vi.fn()} onCreated={() => refresh.promise} />);
    fireEvent.click(screen.getByText('拍照／匯入教材目錄'));
    fireEvent.change(screen.getByLabelText('選多張照片'), { target: { files } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /確認送出/ })); });
    const submit = await screen.findByRole('button', { name: '建立教材' });
    fireEvent.click(submit);

    expect(await screen.findByText('教材已建立')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '建立教材' })).not.toBeInTheDocument();
    expect(commitDraft).toHaveBeenCalledOnce();
    expect(importPreview).toHaveBeenCalledWith(expect.objectContaining({
      files: expect.arrayContaining(files.map(file => expect.objectContaining({ filename: file.name }))),
    }));
    refresh.resolve();
    await act(async () => { await refresh.promise; });
  });
});
