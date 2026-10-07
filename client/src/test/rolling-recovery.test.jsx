import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const RollingExamSchedule = (await import('../tt/RollingExamSchedule')).default;
const preview = () => ({
  window: { freeze_start: '2026-10-01', freeze_through: '2026-10-02', rolling_start: '2026-10-03' },
  base_version_id: 5, plan_id: 7, frozen: [], movable: [], attach_task_ids: [], task_creates: [],
  blocks: [{ task_id: 11, date: '2026-10-03', start_time: '19:00', end_time: '20:00' }],
  diff: { items: [{ task_id: 11, type: 'unchanged', before_blocks: [], after_blocks: [{ date: '2026-10-03' }] }] },
  unplaced: false, infeasible: null,
});
beforeEach(() => {
  api.mockReset();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
});
afterEach(cleanup);

async function mount(onApplied = vi.fn().mockResolvedValue(), onClose = vi.fn()) {
  render(<RollingExamSchedule planId={7} onClose={onClose} onApplied={onApplied} />);
  return { button: await screen.findByRole('button', { name: '確認套用' }), onApplied, onClose };
}

describe('RollingExamSchedule 套用恢復', () => {
  it('一般調整流程不顯示工程術語，並直接說明調整的是這次段考安排', async () => {
    api.mockResolvedValueOnce(preview());
    await mount();
    expect(screen.getByRole('heading', { name: '調整這次段考安排' })).toBeInTheDocument();
    expect(screen.queryByText(/滾動重排/)).not.toBeInTheDocument();
  });

  it('pending apply 時禁止取消與 backdrop，且只送一次', async () => {
    api.mockResolvedValueOnce(preview()).mockImplementationOnce(() => new Promise(() => {}));
    const { button, onClose } = await mount(); fireEvent.click(button);
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(cancel).toBeDisabled(); fireEvent.click(cancel);
    fireEvent.click(document.querySelector('.sheet-backdrop'));
    fireEvent.click(screen.getByRole('button', { name: '套用中…' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(api.mock.calls.filter(c => c[0] === '/schedule/rolling/apply')).toHaveLength(1);
  });

  it('apply 成功但刷新失敗只重試 callback', async () => {
    api.mockResolvedValueOnce(preview()).mockResolvedValueOnce({ version_id: 42 });
    const onApplied = vi.fn().mockRejectedValueOnce(new Error('刷新失敗')).mockResolvedValueOnce();
    const onClose = vi.fn(); const { button } = await mount(onApplied, onClose); fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('新版安排已套用，但畫面暫時無法更新');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(2));
    expect(api.mock.calls.filter(c => c[0] === '/schedule/rolling/apply')).toHaveLength(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('真正 apply 失敗保留 preview 並允許重試', async () => {
    api.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new Error('套用失敗')).mockResolvedValueOnce({ version_id: 43 });
    const { button } = await mount(); fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('套用失敗');
    expect(button).toBeEnabled(); fireEvent.click(button);
    await waitFor(() => expect(api.mock.calls.filter(c => c[0] === '/schedule/rolling/apply')).toHaveLength(2));
  });

  it('同步 guard 阻止快速重入建立兩個版本', async () => {
    let button; let nested = false;
    api.mockResolvedValueOnce(preview()).mockImplementationOnce(() => {
      if (!nested) { nested = true; fireEvent.click(button); }
      return Promise.resolve({ version_id: 44 });
    });
    ({ button } = await mount()); fireEvent.click(button);
    await screen.findByText('新版安排已套用');
    expect(api.mock.calls.filter(c => c[0] === '/schedule/rolling/apply')).toHaveLength(1);
  });
});
