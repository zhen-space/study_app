// 段考滾動排程前端：純函式（分區／override payload／confirm 條件）＋ 流程串接
// （預覽區塊、INFEASIBLE 三選項、override 需二次預覽、confirm 才 apply、stale 重新預覽、
// 不直接建立 ScheduledBlock）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { sectionize, frozenIntact, buildFreezePayload, applyPayload, canConfirm, INFEASIBLE_OPTIONS } from '../tt/rollingSchedule';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const RollingExamSchedule = (await import('../tt/RollingExamSchedule')).default;

const WIN = { freeze_start: '2026-09-12', freeze_through: '2026-09-13', rolling_start: '2026-09-14' };
const feasible = () => ({
  window: WIN, base_version_id: 5, plan_id: 7,
  frozen: [{ id: 1, task_id: 10, date: '2026-09-12', start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
  movable: [],
  blocks: [
    { task_id: 10, date: '2026-09-12', start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
    { task_id: 11, date: '2026-09-14', start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
  ],
  attach_task_ids: [],
  diff: { items: [
    { task_id: 10, type: 'unchanged', before_blocks: [{ date: '2026-09-12', start_time: '19:00', end_time: '20:00' }], after_blocks: [{ date: '2026-09-12', start_time: '19:00', end_time: '20:00' }] },
    { task_id: 11, type: 'added', before_blocks: [], after_blocks: [{ date: '2026-09-14', start_time: '19:00', end_time: '20:00' }] },
  ] },
  unplaced: false, infeasible: null,
});
const infeasible = () => ({
  ...feasible(),
  blocks: [{ task_id: 10, date: '2026-09-12', start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
  attach_task_ids: [99],
  diff: { items: [{ task_id: 10, type: 'unchanged', before_blocks: [{ date: '2026-09-12' }], after_blocks: [{ date: '2026-09-12', start_time: '19:00', end_time: '20:00' }] }] },
  infeasible: { code: 'INFEASIBLE_WITH_FREEZE', freeze_start: '2026-09-12', freeze_through: '2026-09-13', rolling_start: '2026-09-14', trigger_task_id: 99, deadline_date: '2026-09-13', deadline_time: null, required_minutes: 120, reason: 'deadline_before_rolling_start', options: ['KEEP_CURRENT', 'RELAX_FREEZE', 'SELECT_MOVABLE_BLOCKS'] },
});

/* ===== pure ===== */
describe('rollingSchedule 純函式', () => {
  it('sectionize：frozen 落在今天／明天、added 分開', () => {
    const s = sectionize(feasible());
    expect(s.frozen.map(i => i.task_id)).toEqual([10]);
    expect(s.added.map(i => i.task_id)).toEqual([11]);
  });
  it('frozenIntact：frozen 沒被 moved/removed → true', () => {
    expect(frozenIntact(feasible())).toBe(true);
    const bad = feasible(); bad.diff.items[0].type = 'moved';
    expect(frozenIntact(bad)).toBe(false);
  });
  it('buildFreezePayload：override 結構化', () => {
    expect(buildFreezePayload('RELAX_FREEZE').override).toEqual({ mode: 'relax_freeze' });
    expect(buildFreezePayload('SELECT_MOVABLE_BLOCKS', { movableBlockIds: [1, 2] }).override).toEqual({ mode: 'select_movable', movable_block_ids: [1, 2] });
  });
  it('applyPayload：帶 base_version_id / blocks / freeze_blocks / attach', () => {
    const p = applyPayload({ ...feasible(), plan_id: 7 });
    expect(p.base_version_id).toBe(5);
    expect(p.plan_id).toBe(7);
    expect(p.blocks).toHaveLength(2);
    expect(p.freeze_blocks).toHaveLength(1);
  });
  it('canConfirm：feasible → true；infeasible → false', () => {
    expect(canConfirm(feasible())).toBe(true);
    expect(canConfirm(infeasible())).toBe(false);
  });
});

/* ===== 流程 ===== */
describe('RollingExamSchedule 流程', () => {
  beforeEach(() => { api.mockReset(); });

  it('可行預覽 → 確認 → 走 /rolling/apply（不直接建立 ScheduledBlock）', async () => {
    api.mockResolvedValueOnce(feasible());       // mount preview
    api.mockResolvedValueOnce({ version_id: 42 }); // apply
    const onApplied = vi.fn();
    render(<RollingExamSchedule planId={7} onClose={() => {}} onApplied={onApplied} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '確認套用' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '確認套用' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    const applyCall = api.mock.calls.find(c => c[0] === '/schedule/rolling/apply');
    expect(applyCall).toBeTruthy();
    expect(applyCall[1].body.base_version_id).toBe(5);
    expect(applyCall[1].body.freeze_blocks).toHaveLength(1);
    // 只打 rolling preview / apply，沒有任何直接建立 block 的呼叫
    const paths = api.mock.calls.map(c => c[0]);
    expect(paths.every(p => p === '/schedule/rolling/preview' || p === '/schedule/rolling/apply')).toBe(true);
  });

  it('INFEASIBLE → 顯示三選項；確認套用被停用', async () => {
    api.mockResolvedValueOnce(infeasible());
    render(<RollingExamSchedule planId={7} triggerTaskId={99} onClose={() => {}} onApplied={() => {}} />);
    await waitFor(() => expect(screen.getByText(/在不動今天／明天的前提下排不進來/)).toBeInTheDocument());
    for (const o of INFEASIBLE_OPTIONS) expect(screen.getByRole('button', { name: o.label })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認套用' })).toBeDisabled();
  });

  it('RELAX_FREEZE → 觸發第二次預覽（不直接 apply）', async () => {
    api.mockResolvedValueOnce(infeasible());     // mount
    api.mockResolvedValueOnce(feasible());       // re-preview after relax
    render(<RollingExamSchedule planId={7} triggerTaskId={99} onClose={() => {}} onApplied={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '放寬今天／明天的凍結' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '放寬今天／明天的凍結' }));
    await waitFor(() => {
      const previews = api.mock.calls.filter(c => c[0] === '/schedule/rolling/preview');
      expect(previews).toHaveLength(2);
      expect(previews[1][1].body.freeze).toEqual({ override: { mode: 'relax_freeze' } });
    });
    // 第二次預覽 feasible 後才可確認；apply 尚未被呼叫
    expect(api.mock.calls.some(c => c[0] === '/schedule/rolling/apply')).toBe(false);
  });

  it('SELECT_MOVABLE_BLOCKS → 勾選後帶 movable_block_ids 重新預覽', async () => {
    api.mockResolvedValueOnce(infeasible());     // mount
    api.mockResolvedValueOnce(feasible());       // re-preview after select
    render(<RollingExamSchedule planId={7} triggerTaskId={99} onClose={() => {}} onApplied={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '指定可移動的安排' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '指定可移動的安排' }));
    // frozen pin id=1 出現在可勾選清單
    const cb = await screen.findByLabelText('可移動 1');
    fireEvent.click(cb);
    fireEvent.click(screen.getByRole('button', { name: '用這些可移動的安排重新預覽' }));
    await waitFor(() => {
      const previews = api.mock.calls.filter(c => c[0] === '/schedule/rolling/preview');
      expect(previews[1][1].body.freeze).toEqual({ override: { mode: 'select_movable', movable_block_ids: [1] } });
    });
  });

  it('STALE_SCHEDULE_PREVIEW → 自動重新預覽、不當成成功', async () => {
    api.mockResolvedValueOnce(feasible());        // mount preview
    const stale = new Error('stale'); stale.code = 'STALE_SCHEDULE_PREVIEW'; stale.payload = { code: 'STALE_SCHEDULE_PREVIEW' };
    api.mockRejectedValueOnce(stale);             // apply → stale
    api.mockResolvedValueOnce(feasible());        // auto re-preview
    const onApplied = vi.fn();
    render(<RollingExamSchedule planId={7} onClose={() => {}} onApplied={onApplied} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '確認套用' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '確認套用' }));
    await waitFor(() => expect(screen.getByText(/已被其他變更取代/)).toBeInTheDocument());
    expect(onApplied).not.toHaveBeenCalled();
    const previews = api.mock.calls.filter(c => c[0] === '/schedule/rolling/preview');
    expect(previews).toHaveLength(2); // mount + auto re-preview
  });
});
