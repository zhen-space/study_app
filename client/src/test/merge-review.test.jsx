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
});
