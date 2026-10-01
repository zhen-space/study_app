// 合併／增補目錄前端（MergeReview）：預覽分類、順序／疑似重複確認 gating、套用。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../tt/material', () => ({ mergePreview: vi.fn(), mergeApply: vi.fn() }));
const material = await import('../tt/material');
const MergeReview = (await import('../tt/MergeReview')).default;

const draft = { book: { title: 'x' }, chapters: [] };
const preview = t => ({
  chapters: [{ title: '第一課', status: 'exists', order_changed: false, items: [{ title: '1-2', kind: 'reading', status: 'new' }], children: [] }],
  counts: { new: 1, exists: 1, suspected_duplicate: 0, order_change: 0 },
  has_suspected_duplicates: false, order_status: 'ok', fingerprint: 'FP', ...t,
});

beforeEach(() => { material.mergePreview.mockReset(); material.mergeApply.mockReset(); });
afterEach(() => cleanup());

describe('MergeReview', () => {
  it('顯示分類並在無需確認時可直接套用', async () => {
    material.mergePreview.mockResolvedValue(preview());
    material.mergeApply.mockResolvedValue({ ok: true });
    const onDone = vi.fn();
    render(<MergeReview bookId={1} draft={draft} onDone={onDone} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText(/新增 1、已存在 1/)).toBeTruthy());
    fireEvent.click(screen.getByText('確認合併'));
    await waitFor(() => expect(material.mergeApply).toHaveBeenCalled());
    const args = material.mergeApply.mock.calls[0];
    expect(args[2].expectedFingerprint).toBe('FP');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('順序不可靠時，須先勾確認才能套用', async () => {
    material.mergePreview.mockResolvedValue(preview({ order_status: 'ORDER_CONFIRMATION_REQUIRED' }));
    render(<MergeReview bookId={1} draft={draft} onDone={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText('確認合併')).toBeTruthy());
    expect(screen.getByText('確認合併').disabled).toBe(true);
    fireEvent.click(screen.getByText(/新章節的順序無法自動判定/).previousSibling || screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText('確認合併').disabled).toBe(false));
  });

  it('疑似重複時，須先勾確認才能套用', async () => {
    material.mergePreview.mockResolvedValue(preview({ has_suspected_duplicates: true, counts: { new: 0, exists: 0, suspected_duplicate: 1 } }));
    render(<MergeReview bookId={1} draft={draft} onDone={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByText('確認合併')).toBeTruthy());
    expect(screen.getByText('確認合併').disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText('確認合併').disabled).toBe(false));
  });

  it('apply 成功後立刻進入不可重送狀態，即使父層刷新仍在等待', async () => {
    material.mergePreview.mockResolvedValue(preview());
    material.mergeApply.mockResolvedValue({ merged: 2 });
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const onDone = vi.fn(() => pending);
    render(<MergeReview bookId={1} draft={draft} onDone={onDone} onCancel={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '確認合併' }));

    expect(await screen.findByText('目錄已合併')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '確認合併' })).not.toBeInTheDocument();
    expect(material.mergeApply).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith({ merged: 2 });
    finish();
    await pending;
  });

  it('父層刷新失敗只重試 callback，不重送 merge apply', async () => {
    material.mergePreview.mockResolvedValue(preview());
    material.mergeApply.mockResolvedValue({ merged: 2 });
    const onDone = vi.fn()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(undefined);
    render(<MergeReview bookId={1} draft={draft} onDone={onDone} onCancel={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '確認合併' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('目錄已合併，但畫面暫時無法更新');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(material.mergeApply).toHaveBeenCalledOnce();
  });

  it('真正 apply 失敗仍保留 preview 並可重試', async () => {
    material.mergePreview.mockResolvedValue(preview());
    material.mergeApply
      .mockRejectedValueOnce(new Error('合併暫時失敗'))
      .mockResolvedValueOnce({ merged: 2 });
    render(<MergeReview bookId={1} draft={draft} onDone={vi.fn()} onCancel={() => {}} />);
    const apply = await screen.findByRole('button', { name: '確認合併' });
    fireEvent.click(apply);

    expect(await screen.findByRole('alert')).toHaveTextContent('合併暫時失敗');
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await waitFor(() => expect(material.mergeApply).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('目錄已合併')).toBeInTheDocument();
  });

  it('同步 guard 阻止重入 merge apply', async () => {
    let applyButton;
    let nested = false;
    material.mergePreview.mockResolvedValue(preview());
    material.mergeApply.mockImplementation(() => {
      if (!nested) {
        nested = true;
        fireEvent.click(applyButton);
      }
      return Promise.resolve({ merged: 2 });
    });
    render(<MergeReview bookId={1} draft={draft} onDone={vi.fn()} onCancel={() => {}} />);
    applyButton = await screen.findByRole('button', { name: '確認合併' });
    fireEvent.click(applyButton);

    await screen.findByText('目錄已合併');
    expect(material.mergeApply).toHaveBeenCalledOnce();
  });
});
