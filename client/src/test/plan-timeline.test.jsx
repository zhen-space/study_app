// 段考進度時間軸（前端）：把後端 projection 呈現成「日期區間 → 應完成內容」，
// 並分流 deadline／排不下／未排入，空狀態給加入內容／調整入口。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const PlanTimeline = (await import('../tt/PlanTimeline')).default;

const plan = { planId: 1, status: 'active' };

function mockTimeline(body) { api.mockImplementation(async () => body); }

beforeEach(() => { api.mockReset(); });
afterEach(() => cleanup());

const range = (t) => ({
  segments: [], deadlines: [], gaps: [], unscheduled: [], items: [], warnings: [],
  no_active_schedule: false, empty: false, range: null, ...t,
});

describe('PlanTimeline', () => {
  it('日期區間 → 科目 → 內容；點開顯示每日安排', async () => {
    const item = {
      task_id: 10, kind: 'material', subject_id: 1, subject_name: '數學',
      material: { book_title: '課本', path: [{ title: '第一章' }], item_title: 'Ch1 閱讀' },
      title: 'Ch1', display_mode: 'range', range_start: '2026-09-25', range_end: '2026-09-27',
      planned_minutes: 120, block_ids: [1, 2], completion: 'not_started', locked: false, warnings: [],
      day_blocks: [{ block_id: 1, date: '2026-09-25', start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
    };
    mockTimeline(range({
      items: [item],
      segments: [{ range_start: '2026-09-25', range_end: '2026-09-27', display_mode: 'range', groups: [{ subject_id: 1, subject_name: '數學', task_ids: [10] }] }],
    }));
    render(<PlanTimeline plan={plan} />);
    await waitFor(() => expect(screen.getByText('段考進度')).toBeTruthy());
    expect(screen.getByText('9/25–9/27')).toBeTruthy();
    expect(screen.getByText('數學')).toBeTruthy();
    expect(screen.getByText('第一章 · Ch1 閱讀')).toBeTruthy();
    // 展開才看每日安排
    expect(screen.queryByText(/9\/25 19:00–20:00/)).toBeNull();
    fireEvent.click(screen.getByText('展開每日安排'));
    await waitFor(() => expect(screen.getByText(/9\/25 19:00–20:00/)).toBeTruthy());
  });

  it('School Assignment 顯示「某日前」，不混進日期區間', async () => {
    const sa = { task_id: 20, kind: 'school_assignment', subject_name: '物理', title: '交物理講義', display_mode: 'deadline', deadline_date: '2026-10-01', deadline_time: '18:00', completion: 'not_started', day_blocks: [], warnings: [] };
    mockTimeline(range({ items: [sa], deadlines: [sa] }));
    render(<PlanTimeline plan={plan} />);
    await waitFor(() => expect(screen.getByText('要交／要完成')).toBeTruthy());
    expect(screen.getByText('10/1 18:00 前：交物理講義')).toBeTruthy();
  });

  it('排不下／期限衝突另列並提供調整', async () => {
    const gap = { task_id: 30, title: '排不下的內容', display_mode: 'gap', warnings: ['deadline_violation'], day_blocks: [], completion: 'not_started' };
    const onAdjust = vi.fn();
    mockTimeline(range({ items: [gap], gaps: [gap] }));
    render(<PlanTimeline plan={plan} onAdjust={onAdjust} />);
    await waitFor(() => expect(screen.getByText('需要調整（排不下或期限衝突）')).toBeTruthy());
    expect(screen.getByText('排在期限之後')).toBeTruthy();
    fireEvent.click(screen.getByText('調整計畫'));
    expect(onAdjust).toHaveBeenCalled();
  });

  it('未排入內容另列', async () => {
    const un = { task_id: 40, title: '還沒排的章節', display_mode: 'unscheduled', warnings: ['missing_estimate'], day_blocks: [], completion: 'not_started' };
    mockTimeline(range({ items: [un], unscheduled: [un] }));
    render(<PlanTimeline plan={plan} />);
    await waitFor(() => expect(screen.getByText(/尚未排入/)).toBeTruthy());
    expect(screen.getByText('缺預估時間')).toBeTruthy();
  });

  it('空狀態提供「加入內容」與「調整計畫」', async () => {
    const onAddContent = vi.fn(); const onAdjust = vi.fn();
    mockTimeline(range({ empty: true, no_active_schedule: true }));
    render(<PlanTimeline plan={plan} onAddContent={onAddContent} onAdjust={onAdjust} />);
    await waitFor(() => expect(screen.getByText('這個計畫還沒有安排')).toBeTruthy());
    fireEvent.click(screen.getByText('加入內容'));
    expect(onAddContent).toHaveBeenCalled();
  });
});
