// 段考進度（A 層）前端：把後端投影呈現成「日期區間 → 教材範圍 + 完成/落後」，
// 空狀態給「安排進度」入口；現役計畫可新增一段。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const ProgressPlan = (await import('../tt/ProgressPlan')).default;

const activePlan = { planId: 1, status: 'active' };
const donePlan = { planId: 2, status: 'ended' };

// 依 path 回不同資料：progress-segments 投影 / material-items 選取。
function mockApi({ segments = null, selection = [] } = {}) {
  api.mockImplementation(async (path, opts) => {
    if (path.includes('/material-items')) return selection;
    if (path.includes('/progress-segments')) {
      if (opts?.method === 'POST' || opts?.method === 'PATCH') return segments; // echo back
      return segments;
    }
    return {};
  });
}

const proj = t => ({ segments: [], summary: { segment_count: 0, behind_count: 0, needs_attention: false }, empty: true, ...t });

beforeEach(() => { api.mockReset(); });
afterEach(() => cleanup());

describe('ProgressPlan', () => {
  it('顯示每段：日期區間、科目、完成度與落後狀態', async () => {
    mockApi({ segments: proj({
      empty: false,
      summary: { segment_count: 1, behind_count: 1, needs_attention: true },
      segments: [{
        id: 5, title: '數學第一課～第二課', kind: 'study',
        start_date: '2026-09-28', end_date: '2026-10-02', subject_name: '數學',
        scope: [1, 2, 3, 4], total: 4, completed_count: 1, percent: 25,
        expected_percent: 50, time_status: 'active', status: 'behind', behind: true,
      }],
    }) });
    render(<ProgressPlan plan={activePlan} lists={[]} />);
    await waitFor(() => expect(screen.getByText('數學第一課～第二課')).toBeTruthy());
    expect(screen.getByText('9/28–10/2')).toBeTruthy();
    expect(screen.getByText('數學')).toBeTruthy();
    expect(screen.getByText('落後')).toBeTruthy();
    expect(screen.getByText(/1 \/ 4 範圍已完成（25%）/)).toBeTruthy();
    // 摘要提示落後
    expect(screen.getByText(/有 1 段進度落後/)).toBeTruthy();
  });

  it('空狀態：現役計畫給「安排進度」入口', async () => {
    mockApi({ segments: proj({ empty: true, segments: [] }) });
    render(<ProgressPlan plan={activePlan} lists={[]} />);
    await waitFor(() => expect(screen.getByText('還沒有安排段考進度')).toBeTruthy());
    expect(screen.getByText('安排進度')).toBeTruthy();
  });

  it('歷史計畫唯讀：沒有新增／安排入口', async () => {
    mockApi({ segments: proj({ empty: true, segments: [] }) });
    render(<ProgressPlan plan={donePlan} lists={[]} />);
    await waitFor(() => expect(screen.getByText('還沒有安排段考進度')).toBeTruthy());
    expect(screen.queryByText('安排進度')).toBeNull();
    expect(screen.queryByText('新增一段')).toBeNull();
  });

  it('點「新增一段」開表單', async () => {
    mockApi({ segments: proj({ empty: true, segments: [] }) });
    render(<ProgressPlan plan={activePlan} lists={[{ id: 1, name: '數學' }]} />);
    await waitFor(() => expect(screen.getByText('新增一段')).toBeTruthy());
    fireEvent.click(screen.getByText('新增一段'));
    await waitFor(() => expect(screen.getByText('新增一段進度')).toBeTruthy());
    expect(screen.getByPlaceholderText('例：數學第一課～第二課')).toBeTruthy();
  });
});
