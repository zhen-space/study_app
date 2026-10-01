import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
vi.mock('../tt/calendarBusy', () => ({ fetchExternalBusy: vi.fn(() => Promise.resolve({})) }));
vi.mock('../tt/wizardApply', () => ({ applyWizardSchedule: vi.fn() }));
vi.mock('../tt/schedulePreview', () => ({
  buildSchedulePreviewRequest: vi.fn(x => x),
  planScheduleConditions: vi.fn(() => ({ conditions: { timed: false }, minutes: {}, missing: [], complete: true })),
  CONDITION_LABEL: {},
}));
const { api } = await import('../api');
const { applyWizardSchedule } = await import('../tt/wizardApply');
const ReplanSheet = (await import('../tt/ReplanSheet')).default;
const plan = { planId: 7, name: '段考', items: [{ id: 11, list_id: 2, title: '力學', completed: 0, deleted: 0 }] };
const preview = { blocks: [{ task_id: 11, subject_id: 2, title: '力學', date: '2026-10-03' }] };

function mount(reload = vi.fn().mockResolvedValue(), onClose = vi.fn()) {
  render(<ReplanSheet plan={plan} health={{ reasons: [] }} raw={{ target_date: '2026-10-10' }}
    reload={reload} onClose={onClose} onEditConditions={vi.fn()} />);
  return { reload, onClose };
}
async function openPreview() {
  fireEvent.click(screen.getByRole('button', { name: '重新安排' }));
  await screen.findByText('新的安排已準備好');
  return screen.getByRole('button', { name: '套用新版安排' });
}
beforeEach(() => {
  api.mockReset(); applyWizardSchedule.mockReset();
  api.mockImplementation(path => path === '/schedule/preview' ? Promise.resolve(structuredClone(preview)) : Promise.resolve({}));
});
afterEach(cleanup);

describe('ReplanSheet 套用後恢復', () => {
  it('寫入成功後立刻不可重送，即使 reload 還在等待', async () => {
    let finish;
    const reload = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    applyWizardSchedule.mockResolvedValue({ planId: 7 }); mount(reload);
    fireEvent.click(await openPreview());
    expect(await screen.findByText('新版安排已套用')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '套用新版安排' })).not.toBeInTheDocument();
    expect(applyWizardSchedule).toHaveBeenCalledOnce(); finish();
  });

  it('reload 失敗只重試 reload', async () => {
    const reload = vi.fn().mockRejectedValueOnce(new Error('網路中斷')).mockResolvedValueOnce();
    const onClose = vi.fn(); applyWizardSchedule.mockResolvedValue({ planId: 7 }); mount(reload, onClose);
    fireEvent.click(await openPreview());
    expect(await screen.findByRole('alert')).toHaveTextContent('新版安排已套用，但畫面暫時無法更新');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(applyWizardSchedule).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
  });

  it('真正套用失敗保留預覽並允許重試', async () => {
    applyWizardSchedule.mockRejectedValueOnce(new Error('套用失敗')).mockResolvedValueOnce({ planId: 7 }); mount();
    const button = await openPreview(); fireEvent.click(button);
    expect(await screen.findByText('套用失敗')).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(applyWizardSchedule).toHaveBeenCalledTimes(2));
  });

  it('同步 guard 阻止快速重入', async () => {
    let button; let nested = false;
    applyWizardSchedule.mockImplementation(() => {
      if (!nested) { nested = true; fireEvent.click(button); }
      return Promise.resolve({ planId: 7 });
    });
    mount(); button = await openPreview(); fireEvent.click(button);
    await screen.findByText('新版安排已套用');
    expect(applyWizardSchedule).toHaveBeenCalledOnce();
  });
});
