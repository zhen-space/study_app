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
  it('完成按鈕使用大觸控目標並立即反映，不等待整頁重載', async () => {
    let finishPatch;
    const pending = new Promise(resolve => { finishPatch = resolve; });
    const item = { task_id: 10, kind: 'standard', title: '背英文', display_mode: 'range', range_start: '2026-10-01', range_end: '2026-10-01',
      completion: 'not_started', time_status: 'today', day_blocks: [{ block_id: 7, date: '2026-10-01' }], warnings: [] };
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item],
        segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ task_ids: [10] }] }] }));
      if (path === '/tasks/10' && options?.method === 'PATCH') return pending;
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} />);
    const check = await screen.findByRole('button', { name: '完成「背英文」' });
    expect(check).toHaveClass('timeline-check');
    fireEvent.click(check);
    expect(screen.getByRole('button', { name: '取消完成「背英文」' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('背英文')).toHaveStyle({ textDecoration: 'line-through' });
    finishPatch({ completed: true });
    await waitFor(() => expect(check).not.toBeDisabled());
  });

  it('完成寫入失敗會回復畫面並顯示錯誤', async () => {
    const item = { task_id: 11, kind: 'standard', title: '物理題目', display_mode: 'range', range_start: '2026-10-01', range_end: '2026-10-01',
      completion: 'not_started', time_status: 'today', day_blocks: [{ block_id: 8, date: '2026-10-01' }], warnings: [] };
    api.mockImplementation((path) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item],
        segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ task_ids: [11] }] }] }));
      if (path === '/tasks/11') return Promise.reject(new Error('連線失敗'));
      if (path === '/tasks') return Promise.resolve([{ id: 11, completed: false }]);
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} />);
    fireEvent.click(await screen.findByRole('button', { name: '完成「物理題目」' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('連線失敗');
    expect(screen.getByRole('button', { name: '完成「物理題目」' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('完成結果未知時鎖住原按鈕，只允許唯讀重新載入確認', async () => {
    const item = { task_id: 14, kind: 'standard', title: '化學題目', display_mode: 'range', range_start: '2026-10-01', range_end: '2026-10-01',
      completion: 'not_started', time_status: 'today', day_blocks: [{ block_id: 18, date: '2026-10-01' }], warnings: [] };
    const timeline = range({ active: true, active_version_id: 5, items: [item],
      segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ task_ids: [14] }] }] });
    api.mockImplementation((path) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(timeline);
      if (path === '/tasks/14') return Promise.reject(new Error('回應遺失'));
      if (path === '/tasks') return Promise.reject(new Error('讀回失敗'));
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} />);
    const check = await screen.findByRole('button', { name: '完成「化學題目」' });
    fireEvent.click(check);
    expect(await screen.findByRole('alert')).toHaveTextContent('確認前不會再次切換');
    expect(screen.getByRole('button', { name: '取消完成「化學題目」' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新載入確認' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '完成「化學題目」' })).not.toBeDisabled());
    expect(api.mock.calls.filter(([path]) => path === '/tasks/14')).toHaveLength(1);
  });

  it('可直接編輯任務，排定日期仍由 ScheduleVersion 調整', async () => {
    const item = { task_id: 12, kind: 'standard', title: '舊名稱', estimated_minutes: 30, display_mode: 'range', range_start: '2026-10-01', range_end: '2026-10-01',
      completion: 'not_started', day_blocks: [{ block_id: 9, date: '2026-10-01', start_time: '19:00', end_time: '19:30' }], warnings: [] };
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item],
        segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ task_ids: [12] }] }] }));
      if (path === '/tasks/12' && options?.method === 'PATCH') return Promise.resolve({ id: 12, ...options.body });
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 12, title: '舊名稱', estimated_minutes: 30 }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    const title = screen.getByLabelText('任務名稱');
    fireEvent.change(title, { target: { value: '新名稱' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存任務' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/12', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ title: '新名稱' }) })));
    expect(await screen.findByText('新名稱')).toBeInTheDocument();
  });

  it('任務編輯結果未知時禁止重送，只能重新載入或關閉', async () => {
    const item = { task_id: 15, kind: 'standard', title: '歷史作業', estimated_minutes: 30, display_mode: 'range', range_start: '2026-10-01', range_end: '2026-10-01',
      completion: 'not_started', day_blocks: [{ block_id: 19, date: '2026-10-01' }], warnings: [] };
    const timeline = range({ active: true, active_version_id: 5, items: [item],
      segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ task_ids: [15] }] }] });
    api.mockImplementation((path) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(timeline);
      if (path === '/tasks/15') return Promise.reject(new Error('回應遺失'));
      if (path === '/tasks') return Promise.reject(new Error('讀回失敗'));
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 15, title: '歷史作業', estimated_minutes: 30 }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('任務名稱'), { target: { value: '歷史作業新版' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存任務' }));
    expect(await screen.findByText('暫時無法確認儲存結果')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '儲存任務' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新載入確認' }));
    await waitFor(() => expect(screen.queryByText('暫時無法確認儲存結果')).not.toBeInTheDocument());
    expect(api.mock.calls.filter(([path]) => path === '/tasks/15')).toHaveLength(1);
  });

  it('375px 每一項仍可直接完成、編輯並開啟既有日期／時間調整交易', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const item = { task_id: 13, kind: 'standard', title: '數學練習', display_mode: 'range', range_start: '2026-10-01', range_end: '2026-10-01',
      completion: 'not_started', day_blocks: [{ block_id: 10, date: '2026-10-01', start_time: '19:00', end_time: '20:00' }], warnings: [] };
    api.mockImplementation((path) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item],
        segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ task_ids: [13] }] }] }));
      if (path === '/schedule/locks') return Promise.resolve([]);
      return Promise.resolve({ conflicts: [] });
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 13, title: '數學練習' }]} />);
    expect(await screen.findByRole('button', { name: '完成「數學練習」' })).toHaveClass('timeline-check');
    expect(screen.getByRole('button', { name: '編輯任務' })).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: '改日期／時間' }));
    expect(screen.getByRole('dialog', { name: '調整這一項' })).toBeInTheDocument();
    expect(screen.getByLabelText('日期')).toHaveValue('2026-10-01');
  });

  it('未完成任務置頂並保留科目、日期與每日安排', async () => {
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
    await waitFor(() => expect(screen.getByText('日期安排')).toBeTruthy());
    expect(screen.getByText('未完成任務（1）')).toBeTruthy();
    expect(screen.getByText('9/25–9/27')).toBeTruthy();
    expect(screen.getByText('數學')).toBeTruthy();
    expect(screen.getByText('課本 · 第一章 · Ch1 閱讀')).toBeTruthy();
    // 展開才看每日安排
    expect(screen.queryByText(/9\/25 19:00–20:00/)).toBeNull();
    fireEvent.click(screen.getByText('展開每日安排'));
    await waitFor(() => expect(screen.getByText(/9\/25 19:00–20:00/)).toBeTruthy());
  });

  it('School Assignment 在未完成區顯示「某日前」', async () => {
    const sa = { task_id: 20, kind: 'school_assignment', subject_name: '物理', title: '交物理講義', display_mode: 'deadline', deadline_date: '2026-10-01', deadline_time: '18:00', completion: 'not_started', day_blocks: [], warnings: [] };
    mockTimeline(range({ items: [sa], deadlines: [sa] }));
    render(<PlanTimeline plan={plan} />);
    await waitFor(() => expect(screen.getByText('未完成任務（1）')).toBeTruthy());
    expect(screen.getByText('交物理講義')).toBeTruthy();
    expect(screen.getByText('10/1 18:00 前')).toBeTruthy();
  });

  it('排不下／期限衝突另列並提供調整', async () => {
    const gap = { task_id: 30, title: '排不下的內容', display_mode: 'gap', warnings: ['deadline_violation'], day_blocks: [], completion: 'not_started' };
    const onAdjust = vi.fn();
    mockTimeline(range({ items: [gap], gaps: [gap] }));
    render(<PlanTimeline plan={plan} onAdjust={onAdjust} />);
    await waitFor(() => expect(screen.getByText('需要調整（排不下或期限衝突）')).toBeTruthy());
    expect(screen.getByText('目前安排超過期限')).toBeTruthy();
    fireEvent.click(screen.getByText('調整計畫'));
    expect(onAdjust).toHaveBeenCalled();
  });

  it('未排入內容另列', async () => {
    const un = { task_id: 40, title: '還沒排的章節', display_mode: 'unscheduled', time_status: 'schedule_gap', warnings: ['missing_estimate', 'schedule_gap'], day_blocks: [], completion: 'not_started' };
    mockTimeline(range({ items: [un], unscheduled: [un] }));
    render(<PlanTimeline plan={plan} />);
    await waitFor(() => expect(screen.getByText(/尚未排入/)).toBeTruthy());
    expect(screen.getByText('尚未填預估時間')).toBeTruthy();
    expect(screen.getByText('安排有缺口')).toBeTruthy();
  });

  it('未完成任務固定在已完成紀錄前，同一任務不在日期與期限區重複', async () => {
    const done = { task_id: 61, title: '昨天完成的閱讀', display_mode: 'completed', completion: 'completed',
      range_start: '2026-10-01', range_end: '2026-10-01', day_blocks: [], warnings: [] };
    const open = { task_id: 62, title: '今天要交的作業', display_mode: 'deadline', completion: 'not_started',
      deadline_date: '2026-10-02', deadline_time: '20:00', day_blocks: [], warnings: [] };
    mockTimeline(range({
      active: true, items: [done, open], deadlines: [open],
      segments: [{ range_start: '2026-10-02', range_end: '2026-10-02', groups: [{ task_ids: [62] }] }],
    }));
    render(<PlanTimeline plan={plan} />);
    const incomplete = await screen.findByText('未完成任務（1）');
    const completed = screen.getByText('已完成紀錄（1）');
    expect(incomplete.compareDocumentPosition(completed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText('今天要交的作業')).toHaveLength(1);
    expect(screen.getAllByText('昨天完成的閱讀')).toHaveLength(1);
    expect(screen.queryByText('要交／要完成')).not.toBeInTheDocument();
  });

  it('375px 未完成、gap 與 unscheduled 都維持單一列及明確警示', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const gap = { task_id: 71, title: '超過期限的數學', display_mode: 'gap', completion: 'not_started',
      time_status: 'schedule_gap', warnings: ['deadline_violation'], day_blocks: [] };
    const un = { task_id: 72, title: '尚未估時的英文', display_mode: 'unscheduled', completion: 'not_started',
      time_status: 'schedule_gap', warnings: ['missing_estimate'], day_blocks: [] };
    mockTimeline(range({ active: true, items: [gap, un], gaps: [gap], unscheduled: [un] }));
    render(<PlanTimeline plan={plan} />);
    expect(await screen.findByText('未完成任務（2）')).toBeVisible();
    expect(screen.getAllByText('超過期限的數學')).toHaveLength(1);
    expect(screen.getAllByText('尚未估時的英文')).toHaveLength(1);
    expect(screen.getByText('目前安排超過期限')).toBeVisible();
    expect(screen.getByText('尚未填預估時間')).toBeVisible();
    expect(screen.getByText('需要調整（排不下或期限衝突）')).toBeVisible();
    expect(screen.getByText('尚未排入（1）')).toBeVisible();
  });

  it('空狀態提供「加入內容」與「調整計畫」', async () => {
    const onAddContent = vi.fn(); const onAdjust = vi.fn();
    mockTimeline(range({ empty: true, no_active_schedule: true }));
    render(<PlanTimeline plan={plan} onAddContent={onAddContent} onAdjust={onAdjust} />);
    await waitFor(() => expect(screen.getByText('這個計畫還沒有確切安排')).toBeTruthy());
    fireEvent.click(screen.getByText('加入內容'));
    expect(onAddContent).toHaveBeenCalled();
  });

  it('375px 單欄完整顯示日期狀態、手動範圍與 School Assignment', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const manual = { task_id: 51, kind: 'manual', subject_name: '國文', title: '老師講義第三章', display_mode: 'range',
      range_start: '2026-10-01', range_end: '2026-10-01', time_status: 'today', completion: 'not_started', warnings: [], day_blocks: [] };
    const school = { task_id: 52, kind: 'school_assignment', subject_name: '英文', title: '英文作業', display_mode: 'deadline',
      deadline_date: '2026-09-30', deadline_time: '20:00', time_status: 'past_due', completion: 'not_started', warnings: ['past_due'], day_blocks: [] };
    mockTimeline(range({
      items: [manual, school], deadlines: [school],
      segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ subject_name: '國文', task_ids: [51] }] }],
    }));
    render(<PlanTimeline plan={plan} />);
    expect(await screen.findByText('老師指定：老師講義第三章')).toBeInTheDocument();
    expect(screen.getByText('今天')).toBeInTheDocument();
    expect(screen.getByText('英文作業')).toBeInTheDocument();
    expect(screen.getByText('9/30 20:00 前')).toBeInTheDocument();
    expect(screen.getByText('已逾期')).toBeInTheDocument();
  });

  it('API 失敗顯示 alert 並可重試，不吞錯誤', async () => {
    api.mockRejectedValueOnce(new Error('網路暫時中斷')).mockResolvedValueOnce(range({ empty: true }));
    render(<PlanTimeline plan={plan} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('網路暫時中斷');
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    expect(await screen.findByText('目前沒有可顯示的排程')).toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(2);
  });
});
