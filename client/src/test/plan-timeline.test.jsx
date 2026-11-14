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

  it('同一個編輯任務畫面可改內容、日期與時間', async () => {
    const item = { task_id: 12, kind: 'standard', title: '舊名稱', estimated_minutes: 30, display_mode: 'range', range_start: '2026-10-01', range_end: '2026-10-01',
      completion: 'not_started', day_blocks: [{ block_id: 9, date: '2026-10-01', start_time: '19:00', end_time: '19:30' }], warnings: [] };
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item],
        segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ task_ids: [12] }] }] }));
      if (path === '/schedule/manual') return Promise.resolve(options?.body?.dry_run ? { conflicts: [] } : { ok: true });
      if (path === '/tasks/12' && options?.method === 'PATCH') return Promise.resolve({ id: 12, ...options.body });
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 12, title: '舊名稱', estimated_minutes: 30 }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    const title = screen.getByLabelText('任務名稱');
    fireEvent.change(title, { target: { value: '新名稱' } });
    expect(screen.getByLabelText('日期')).toHaveValue('2026-10-01');
    expect(screen.getByLabelText('開始時間')).toHaveValue('19:00');
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-10-02' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '儲存變更' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/schedule/manual', expect.objectContaining({
      method: 'POST', body: expect.objectContaining({ base_version_id: 5, moves: [{ block_id: 9, date: '2026-10-02', start_time: '19:00', end_time: '19:30' }] }),
    })));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/12', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ title: '新名稱' }) })));
  });

  it('任務編輯結果未知時禁止重送，只能重新載入或關閉', async () => {
    const item = { task_id: 15, kind: 'standard', title: '歷史作業', estimated_minutes: 30, deadline_date: '2026-10-05', deadline_time: '18:00', display_mode: 'range', range_start: '2026-10-01', range_end: '2026-10-01',
      completion: 'not_started', day_blocks: [{ block_id: 19, date: '2026-10-01' }], warnings: [] };
    const timeline = range({ active: true, active_version_id: 5, items: [item],
      segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ task_ids: [15] }] }] });
    api.mockImplementation((path) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(timeline);
      if (path === '/tasks/15') return Promise.reject(new Error('回應遺失'));
      if (path === '/tasks') return Promise.reject(new Error('讀回失敗'));
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 15, title: '歷史作業', estimated_minutes: 30, deadline_date: '2026-10-05', deadline_time: '18:00' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('任務名稱'), { target: { value: '歷史作業新版' } });
    expect(screen.getByLabelText('最晚完成時間')).toHaveValue('18:00');
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    expect(await screen.findByText('暫時無法確認儲存結果')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '儲存變更' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新載入確認' }));
    await waitFor(() => expect(screen.queryByText('暫時無法確認儲存結果')).not.toBeInTheDocument());
    expect(api.mock.calls.filter(([path]) => path === '/tasks/15')).toHaveLength(1);
  });

  it('期限任務在同一編輯畫面修改截止日期與時間，PATCH 不遺失 deadline_time', async () => {
    const item = { task_id: 17, kind: 'school_assignment', title: '交報告', display_mode: 'deadline',
      deadline_date: '2026-10-03', deadline_time: '18:00', completion: 'not_started', day_blocks: [], warnings: [] };
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item], deadlines: [item] }));
      if (path === '/tasks/17' && options?.method === 'PATCH') return Promise.resolve({ id: 17, ...options.body });
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 17, title: '交報告', deadline_date: '2026-10-03', deadline_time: '18:00' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    // 沒有 active block：同一張表單仍可選日期重新安排；不選日期就只改截止。
    expect(screen.getByLabelText('日期')).toHaveValue('');
    expect(screen.getByLabelText('最晚完成日')).toHaveValue('2026-10-03');
    expect(screen.getByLabelText('最晚完成時間')).toHaveValue('18:00');
    fireEvent.change(screen.getByLabelText('最晚完成日'), { target: { value: '2026-10-04' } });
    fireEvent.change(screen.getByLabelText('最晚完成時間'), { target: { value: '20:30' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/17', expect.objectContaining({
      method: 'PATCH', body: expect.objectContaining({ deadline_date: '2026-10-04', deadline_time: '20:30' }),
    })));
    expect(api.mock.calls.filter(([path]) => path === '/schedule/manual')).toHaveLength(0);
  });

  it('期限任務只改名稱時保留原截止時間', async () => {
    const item = { task_id: 18, title: '舊作業', display_mode: 'deadline', deadline_date: '2026-10-03',
      deadline_time: '18:00', completion: 'not_started', day_blocks: [], warnings: [] };
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, items: [item], deadlines: [item] }));
      if (path === '/tasks/18' && options?.method === 'PATCH') return Promise.resolve({ id: 18, ...options.body });
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 18, title: '舊作業', deadline_date: '2026-10-03', deadline_time: '18:00' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('任務名稱'), { target: { value: '新作業' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/18', expect.objectContaining({
      body: expect.objectContaining({ title: '新作業', deadline_time: '18:00' }),
    })));
  });

  it.each([true, false])('只改截止時間會送出，讀回確認必須核對時間（符合：%s）', async matches => {
    const item = { task_id: 19, title: '報告', display_mode: 'deadline', deadline_date: '2026-10-03',
      deadline_time: '18:00', completion: 'not_started', day_blocks: [], warnings: [] };
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, items: [item] }));
      if (path === '/tasks/19' && options?.method === 'PATCH') return Promise.reject(new Error('回應遺失'));
      if (path === '/tasks') return Promise.resolve([{ id: 19, title: '報告', deadline_date: '2026-10-03',
        deadline_time: matches ? '20:30:00' : '18:00:00', estimated_minutes: null }]);
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('最晚完成時間'), { target: { value: '20:30' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/19', expect.objectContaining({
      body: expect.objectContaining({ deadline_time: '20:30' }),
    })));
    if (matches) await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    else expect(await screen.findByRole('alert')).toHaveTextContent('回應遺失');
    expect(api.mock.calls.filter(([path]) => path === '/tasks/19')).toHaveLength(1);
  });

  it('375px 每一項仍可直接完成，編輯任務內含日期／時間', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const item = { task_id: 13, kind: 'standard', title: '數學練習', display_mode: 'range', range_start: '2026-10-01', range_end: '2026-10-01',
      completion: 'not_started', day_blocks: [{ block_id: 10, date: '2026-10-01', start_time: '19:00', end_time: '20:00' }], warnings: [] };
    api.mockImplementation((path) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item],
        segments: [{ range_start: '2026-10-01', range_end: '2026-10-01', groups: [{ task_ids: [13] }] }] }));
      return Promise.resolve({ conflicts: [] });
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 13, title: '數學練習' }]} />);
    expect(await screen.findByRole('button', { name: '完成「數學練習」' })).toHaveClass('timeline-check');
    expect(screen.getByRole('button', { name: '編輯任務' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '改日期／時間' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '編輯任務' }));
    expect(screen.getByRole('dialog', { name: '編輯任務' })).toBeInTheDocument();
    expect(screen.getByLabelText('日期')).toHaveValue('2026-10-01');
    expect(screen.getByLabelText('開始時間')).toHaveValue('19:00');
  });

  it('日期時間寫入結果未知時不重送 manual transaction', async () => {
    const item = { task_id: 16, title: '英文閱讀', display_mode: 'range', completion: 'not_started',
      day_blocks: [{ block_id: 20, date: '2026-10-01', start_time: '19:00', end_time: '20:00' }], warnings: [] };
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item] }));
      if (path === '/schedule/manual' && options?.body?.dry_run) return Promise.resolve({ conflicts: [] });
      if (path === '/schedule/manual') return Promise.reject(new Error('回應遺失'));
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 16, title: '英文閱讀' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-10-02' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '儲存變更' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    expect(await screen.findByText('暫時無法確認儲存結果')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '儲存變更' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新載入確認' }));
    await waitFor(() => expect(screen.queryByText('暫時無法確認儲存結果')).not.toBeInTheDocument());
    expect(api.mock.calls.filter(([path, options]) => path === '/schedule/manual' && !options?.body?.dry_run)).toHaveLength(1);
  });

  it('dry-run 回報衝突時不能儲存，也不會送出正式 manual transaction', async () => {
    const item = { task_id: 21, title: '數學複習', display_mode: 'range', completion: 'not_started',
      day_blocks: [{ block_id: 30, date: '2026-10-01', start_time: '19:00', end_time: '20:00' }], warnings: [] };
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item] }));
      if (path === '/schedule/manual' && options?.body?.dry_run) return Promise.resolve({ conflicts: [{ type: 'overlap', date: '2026-10-02' }] });
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 21, title: '數學複習' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-10-02' } });
    expect(await screen.findByText('這個時間放不下')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    expect(screen.getByRole('button', { name: '儲存變更' })).toBeDisabled();
    expect(api.mock.calls.filter(([path, options]) => path === '/schedule/manual' && !options?.body?.dry_run)).toHaveLength(0);
  });

  it('正式寫入遇到 stale 409 不能重送舊 block，只能重新載入', async () => {
    const item = { task_id: 22, title: '英文單字', display_mode: 'range', completion: 'not_started',
      day_blocks: [{ block_id: 31, date: '2026-10-01', start_time: '19:00', end_time: '20:00' }], warnings: [] };
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item] }));
      if (path === '/schedule/manual' && options?.body?.dry_run) return Promise.resolve({ conflicts: [] });
      if (path === '/schedule/manual') return Promise.reject(Object.assign(new Error('排程已被其他變更取代'), { status: 409 }));
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 22, title: '英文單字' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-10-02' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '儲存變更' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    expect(await screen.findByText('排程已被其他變更取代')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '儲存變更' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.mock.calls.filter(([path, options]) => path === '/schedule/manual' && !options?.body?.dry_run)).toHaveLength(1);
    expect(api.mock.calls.filter(([path]) => path === '/tasks/22')).toHaveLength(0);
  });

  it('結果未知時先關閉，列表鎖住該項直到重新載入確認', async () => {
    const item = { task_id: 23, title: '國文默寫', display_mode: 'range', completion: 'not_started',
      day_blocks: [{ block_id: 32, date: '2026-10-01' }], warnings: [] };
    api.mockImplementation((path) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(range({ active: true, active_version_id: 5, items: [item] }));
      if (path === '/tasks/23') return Promise.reject(new Error('回應遺失'));
      if (path === '/tasks') return Promise.reject(new Error('讀回失敗'));
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={plan} tasks={[{ id: 23, title: '國文默寫' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('任務名稱'), { target: { value: '國文默寫二' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    fireEvent.click(await screen.findByRole('button', { name: '先關閉' }));
    expect(screen.getByRole('button', { name: '編輯任務' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '完成「國文默寫」' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新載入確認' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '編輯任務' })).not.toBeDisabled());
    expect(api.mock.calls.filter(([path]) => path === '/tasks/23')).toHaveLength(1);
  });

  it('多日安排依每天日期分區，同一任務在各日顯示當日時間', async () => {
    const item = {
      task_id: 10, kind: 'material', subject_id: 1, subject_name: '數學',
      material: { book_title: '課本', path: [{ title: '第一章' }], item_title: 'Ch1 閱讀' },
      title: 'Ch1', display_mode: 'range', range_start: '2026-09-25', range_end: '2026-09-27',
      planned_minutes: 120, block_ids: [1, 2], completion: 'not_started', locked: false, warnings: [],
      day_blocks: [
        { block_id: 1, date: '2026-09-25', start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
        { block_id: 2, date: '2026-09-27', start_time: '20:00', end_time: '21:00', planned_minutes: 60 },
      ],
    };
    mockTimeline(range({
      items: [item],
      segments: [{ range_start: '2026-09-25', range_end: '2026-09-27', display_mode: 'range', groups: [{ subject_id: 1, subject_name: '數學', task_ids: [10] }] }],
    }));
    render(<PlanTimeline plan={plan} />);
    await waitFor(() => expect(screen.getByText('日期安排')).toBeTruthy());
    expect(screen.getByRole('region', { name: '9/25安排' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '9/27安排' })).toBeInTheDocument();
    expect(screen.getAllByText('課本 · 第一章 · Ch1 閱讀')).toHaveLength(2);
    expect(screen.getByText('19:00–20:00')).toBeInTheDocument();
    expect(screen.getByText('20:00–21:00')).toBeInTheDocument();
  });

  it('School Assignment 依期限日期分區並顯示「某日前」', async () => {
    const sa = { task_id: 20, kind: 'school_assignment', subject_name: '物理', title: '交物理講義', display_mode: 'deadline', deadline_date: '2026-10-01', deadline_time: '18:00', completion: 'not_started', day_blocks: [], warnings: [] };
    mockTimeline(range({ items: [sa], deadlines: [sa] }));
    render(<PlanTimeline plan={plan} />);
    await waitFor(() => expect(screen.getByRole('region', { name: '10/1安排' })).toBeTruthy());
    expect(screen.getByText('交物理講義')).toBeTruthy();
    expect(screen.getByText('10/1 18:00 前')).toBeTruthy();
  });

  it('未指定日期的任務仍可見，但不顯示 gap 或未填預估時間文案', async () => {
    const un = { task_id: 40, title: '還沒排的章節', display_mode: 'unscheduled', time_status: 'schedule_gap', warnings: ['missing_estimate', 'schedule_gap'], day_blocks: [], completion: 'not_started' };
    mockTimeline(range({ items: [un], unscheduled: [un] }));
    render(<PlanTimeline plan={plan} />);
    await waitFor(() => expect(screen.getByText('未指定日期')).toBeTruthy());
    expect(screen.getByText('還沒排的章節')).toBeTruthy();
    expect(screen.queryByText('尚未填預估時間')).not.toBeInTheDocument();
    expect(screen.queryByText('安排有缺口')).not.toBeInTheDocument();
    expect(screen.queryByText(/⚠️/)).not.toBeInTheDocument();
  });

  it('只有已逾期置頂，今天與未來任務留在每日日期區', async () => {
    const done = { task_id: 61, title: '昨天完成的閱讀', display_mode: 'completed', completion: 'completed',
      range_start: '2026-10-01', range_end: '2026-10-01', day_blocks: [], warnings: [] };
    const open = { task_id: 62, title: '今天要交的作業', display_mode: 'deadline', completion: 'not_started',
      deadline_date: '2026-10-02', deadline_time: '20:00', day_blocks: [], warnings: [] };
    const overdue = { task_id: 63, title: '昨天該交的作業', display_mode: 'deadline', completion: 'not_started',
      deadline_date: '2026-10-01', time_status: 'past_due', day_blocks: [], warnings: ['past_due'] };
    mockTimeline(range({
      active: true, items: [done, open, overdue], deadlines: [open, overdue],
      segments: [{ range_start: '2026-10-02', range_end: '2026-10-02', groups: [{ task_ids: [62] }] }],
    }));
    render(<PlanTimeline plan={plan} />);
    const overdueTitle = await screen.findByText('已逾期（1）');
    const daily = screen.getByRole('region', { name: '10/2安排' });
    const completed = screen.getByText('已完成紀錄（1）');
    expect(overdueTitle.compareDocumentPosition(daily) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(daily.compareDocumentPosition(completed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('昨天該交的作業')).toBeInTheDocument();
    expect(screen.getAllByText('今天要交的作業')).toHaveLength(1);
    expect(screen.getAllByText('昨天完成的閱讀')).toHaveLength(1);
    expect(screen.queryByText('要交／要完成')).not.toBeInTheDocument();
  });

  it('期限是今天不算逾期，已完成的過期任務也不進逾期區', async () => {
    const today = { task_id: 64, title: '今天截止', display_mode: 'deadline', completion: 'not_started',
      deadline_date: '2026-10-02', time_status: 'today', day_blocks: [], warnings: [] };
    const completedPast = { task_id: 65, title: '已完成舊作業', display_mode: 'completed', completion: 'completed',
      deadline_date: '2026-10-01', time_status: 'completed', day_blocks: [], warnings: ['past_due'] };
    mockTimeline(range({ active: true, items: [today, completedPast], deadlines: [today] }));
    render(<PlanTimeline plan={plan} />);
    expect(await screen.findByRole('region', { name: '10/2安排' })).toBeInTheDocument();
    expect(screen.queryByText(/已逾期（/)).not.toBeInTheDocument();
    expect(screen.getByText('已完成紀錄（1）')).toBeInTheDocument();
  });

  it('375px 不顯示 gap、缺估時或警告符號', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const gap = { task_id: 71, title: '超過期限的數學', display_mode: 'gap', completion: 'not_started',
      time_status: 'schedule_gap', warnings: ['deadline_violation'], day_blocks: [] };
    const un = { task_id: 72, title: '尚未估時的英文', display_mode: 'unscheduled', completion: 'not_started',
      time_status: 'schedule_gap', warnings: ['missing_estimate'], day_blocks: [] };
    mockTimeline(range({ active: true, items: [gap, un], gaps: [gap], unscheduled: [un] }));
    render(<PlanTimeline plan={plan} />);
    expect(await screen.findByText('未指定日期')).toBeVisible();
    expect(screen.getAllByText('超過期限的數學')).toHaveLength(1);
    expect(screen.getAllByText('尚未估時的英文')).toHaveLength(1);
    expect(screen.queryByText('目前安排超過期限')).not.toBeInTheDocument();
    expect(screen.queryByText('尚未填預估時間')).not.toBeInTheDocument();
    expect(screen.queryByText('安排有缺口')).not.toBeInTheDocument();
    expect(screen.queryByText(/⚠️/)).not.toBeInTheDocument();
  });

  it('空狀態提供「加入內容」與「調整計畫」', async () => {
    const onAddContent = vi.fn(); const onAdjust = vi.fn();
    mockTimeline(range({ empty: true, no_active_schedule: true }));
    render(<PlanTimeline plan={plan} onAddContent={onAddContent} onAdjust={onAdjust} />);
    await waitFor(() => expect(screen.getByText('這個計畫還沒有確切安排')).toBeTruthy());
    fireEvent.click(screen.getByText('加入內容'));
    expect(onAddContent).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '調整計畫' }));
    expect(onAdjust).toHaveBeenCalledOnce();
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
