import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const { SegmentSheet } = await import('../tt/ProgressPlan');
const saved = { segments: [{ id: 8, title: '第一課' }], summary: {} };

function mount(onSaved = vi.fn().mockResolvedValue(), onClose = vi.fn()) {
  render(<SegmentSheet planId={1} lists={[]} selection={[]} initial={null} onSaved={onSaved} onClose={onClose} />);
  fireEvent.change(screen.getByPlaceholderText('例：數學第一課～第二課'), { target: { value: '第一課' } });
  fireEvent.change(screen.getByLabelText('在這天以前讀完'), { target: { value: '2026-10-10' } });
  return { onSaved, onClose };
}
const save = () => fireEvent.click(screen.getByRole('button', { name: '儲存' }));
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  api.mockReset();
});
afterEach(cleanup);

describe('進度段儲存恢復', () => {
  it('pending POST 時不可由取消或 backdrop 關閉，快速重入只送一次', async () => {
    api.mockImplementation(() => new Promise(() => {}));
    const { onClose } = mount(); save();
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    fireEvent.click(document.querySelector('.sheet-backdrop'));
    fireEvent.click(screen.getByRole('button', { name: '儲存中…' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledOnce();
  });

  it('API 成功後 callback 失敗只重試 callback', async () => {
    api.mockResolvedValue(saved);
    const onSaved = vi.fn().mockRejectedValueOnce(new Error('刷新失敗')).mockResolvedValueOnce();
    mount(onSaved); save();
    expect(await screen.findByRole('alert')).toHaveTextContent('進度安排已儲存，但畫面暫時無法更新');
    expect(screen.queryByRole('button', { name: '儲存' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api).toHaveBeenCalledOnce();
  });

  it('真正 API 失敗保留輸入並允許重試', async () => {
    api.mockRejectedValueOnce(new Error('伺服器忙碌')).mockResolvedValueOnce(saved);
    mount(); save();
    expect(await screen.findByText('伺服器忙碌')).toBeInTheDocument();
    expect(screen.getByDisplayValue('第一課')).toBeInTheDocument();
    save();
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  });

  it('同步 guard 阻止同一 event turn 重送', async () => {
    let button; let nested = false;
    api.mockImplementation(() => {
      if (!nested) { nested = true; fireEvent.click(button); }
      return Promise.resolve(saved);
    });
    mount(); button = screen.getByRole('button', { name: '儲存' }); fireEvent.click(button);
    await screen.findByText('進度安排已儲存');
    expect(api).toHaveBeenCalledOnce();
  });
});
