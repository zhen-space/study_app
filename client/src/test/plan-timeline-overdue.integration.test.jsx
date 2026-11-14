// 前後端整合：用真正的後端 projection（buildPlanTimeline）產生 /schedule/timeline 回應，
// 交給 PlanTimeline 呈現。確保「已不在 active 版本的過去安排」也會出現在最上方已逾期區，
// 今天到期不算逾期，其餘仍依每日日期分區。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { buildPlanTimeline } from '../../../server/src/schedule/timeline.js';
import { todayTW, addDays } from '../../../server/src/util/date.js';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const PlanTimeline = (await import('../tt/PlanTimeline')).default;

afterEach(() => { cleanup(); api.mockReset(); });

const TODAY = todayTW();
const D = n => addDays(TODAY, n);

function projection() {
  const tasks = [
    { id: 1, title: '前天的進度', list_id: 1, estimated_minutes: 60, completed: 0 },
    { id: 2, title: '截止已過', list_id: 1, estimated_minutes: 60, completed: 0, deadline_date: D(-1) },
    { id: 3, title: '今天截止', list_id: 1, estimated_minutes: 60, completed: 0, deadline_date: D(0), deadline_time: '00:01' },
    { id: 4, title: '今天的進度', list_id: 1, estimated_minutes: 60, completed: 0 },
    { id: 5, title: '兩天的進度', list_id: 1, estimated_minutes: 120, completed: 0 },
    { id: 6, title: '過去已完成', list_id: 1, estimated_minutes: 60, completed: 1 },
  ];
  // active 版本只剩今天以後的 block；前天的安排只存在於歷史版本。
  const blocks = [
    { id: 11, task_id: 3, date: D(0), planned_minutes: 60 },
    { id: 12, task_id: 4, date: D(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
    { id: 13, task_id: 5, date: D(1), planned_minutes: 60 },
    { id: 14, task_id: 5, date: D(2), planned_minutes: 60 },
  ];
  return buildPlanTimeline({
    plan: { id: 1, status: 'active', target_date: D(30) }, activeVersionId: 9, tasks, blocks,
    subjectsById: new Map([[1, '數學']]), lastScheduledByTask: new Map([[1, D(-2)]]), today: TODAY,
  });
}

describe('PlanTimeline × 後端 projection：已逾期', () => {
  it('過去安排已從 active 版本移除的未完成任務仍置頂為已逾期，今天到期不算', async () => {
    api.mockImplementation(async path => (path === '/schedule/timeline/1' ? projection() : []));
    render(<PlanTimeline plan={{ planId: 1, status: 'active' }} />);
    const overdue = await screen.findByRole('region', { name: /已逾期/ });
    expect(within(overdue).getByText('前天的進度')).toBeInTheDocument();
    expect(within(overdue).getByText('截止已過')).toBeInTheDocument();
    expect(within(overdue).queryByText('今天截止')).not.toBeInTheDocument();
    expect(within(overdue).queryByText('今天的進度')).not.toBeInTheDocument();
    expect(within(overdue).queryByText('過去已完成')).not.toBeInTheDocument();
    expect(screen.queryByText('未指定日期')).not.toBeInTheDocument();
    // 已逾期區排在每日分區之前。
    const days = screen.getAllByRole('region', { name: /安排$/ });
    expect(days).toHaveLength(3);
    expect(overdue.compareDocumentPosition(days[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(days[0]).getByText('今天的進度')).toBeInTheDocument();
    // 其餘依每日日期分區，多日任務逐日出現。
    expect(screen.getAllByText('兩天的進度')).toHaveLength(2);
    expect(screen.getAllByText('今天截止')).toHaveLength(1);
  });

  it('逾期任務用同一個編輯表單修改截止日期與時間', async () => {
    api.mockImplementation(async path => (path === '/schedule/timeline/1' ? projection() : []));
    render(<PlanTimeline plan={{ planId: 1, status: 'active' }}
      tasks={[{ id: 2, title: '截止已過', deadline_date: D(-1), estimated_minutes: 60 }]} />);
    const overdue = await screen.findByRole('region', { name: /已逾期/ });
    const row = within(overdue).getByText('截止已過').closest('.timeline-item');
    fireEvent.click(within(row).getByRole('button', { name: '編輯任務' }));
    expect(screen.getByLabelText('任務名稱')).toHaveValue('截止已過');
    expect(screen.getByLabelText('最晚完成日')).toHaveValue(D(-1));
    expect(screen.getByLabelText('最晚完成時間')).toBeInTheDocument();
  });
  it('無 active block 的逾期任務在同一張表單設定日期與時段，經 manual transaction 重新安排', async () => {
    let placed = false;
    const plan = { id: 1, status: 'active', target_date: D(30) };
    const tasks = [{ id: 1, title: '前天的進度', list_id: 1, estimated_minutes: 60, completed: 0 }];
    const view = () => buildPlanTimeline({
      plan, activeVersionId: placed ? 10 : 9, tasks, today: TODAY,
      blocks: placed ? [{ id: 21, task_id: 1, date: D(1), start_time: '18:00', end_time: '19:30', planned_minutes: 90 }] : [],
      lastScheduledByTask: placed ? new Map() : new Map([[1, D(-2)]]),
    });
    api.mockImplementation(async (path, options) => {
      if (path === '/schedule/timeline/1') return view();
      if (path === '/schedule/manual' && options?.body?.dry_run) return { ok: true, conflicts: [] };
      if (path === '/schedule/manual') { placed = true; return { ok: true, conflicts: [] }; }
      return [];
    });
    render(<PlanTimeline plan={{ planId: 1, status: 'active' }} tasks={[{ id: 1, title: '前天的進度', estimated_minutes: 60 }]} />);
    const overdue = await screen.findByRole('region', { name: /已逾期/ });
    expect(within(overdue).getByText(`原定 ${Number(D(-2).slice(5, 7))}/${Number(D(-2).slice(8))}`)).toBeInTheDocument();
    fireEvent.click(within(overdue).getByRole('button', { name: '編輯任務' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('任務名稱')).toHaveValue('前天的進度');
    expect(within(dialog).getByLabelText('最晚完成日')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('日期'), { target: { value: D(1) } });
    fireEvent.click(within(dialog).getByLabelText('指定時間'));
    fireEvent.change(within(dialog).getByLabelText('開始時間'), { target: { value: '18:00' } });
    fireEvent.change(within(dialog).getByLabelText('結束時間'), { target: { value: '19:30' } });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '儲存變更' })).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const writes = api.mock.calls.filter(([path, o]) => path === '/schedule/manual' && !o?.body?.dry_run);
    expect(writes).toHaveLength(1);
    expect(writes[0][1].body).toEqual({ base_version_id: 9, moves: [{ task_id: 1, date: D(1), start_time: '18:00', end_time: '19:30' }] });
    expect(api.mock.calls.filter(([path]) => path === '/tasks/1')).toHaveLength(0);
    // 重新載入後依新日期出現在每日分區，不再逾期。
    expect(screen.queryByRole('region', { name: /已逾期/ })).not.toBeInTheDocument();
    expect(screen.getByText('18:00–19:30')).toBeInTheDocument();
  });

  it('截止已過的任務同時延後截止並重新安排：先存截止日，再提交排程', async () => {
    let deadline = D(-1); let placed = false;
    const view = () => buildPlanTimeline({
      plan: { id: 1, status: 'active', target_date: D(30) }, activeVersionId: placed ? 10 : 9, today: TODAY,
      tasks: [{ id: 2, title: '截止已過', list_id: 1, estimated_minutes: 60, completed: 0, deadline_date: deadline }],
      blocks: placed ? [{ id: 22, task_id: 2, date: D(2), planned_minutes: null }] : [],
    });
    api.mockImplementation(async (path, options) => {
      if (path === '/schedule/timeline/1') return view();
      // 伺服器 dry-run 以目前（已過）的截止日檢查，回報 deadline 衝突。
      if (path === '/schedule/manual' && options?.body?.dry_run) return { ok: false, conflicts: deadline < D(2) ? [{ type: 'deadline', message: '這一天已經超過這個任務的截止日' }] : [] };
      if (path === '/schedule/manual') { if (deadline < D(2)) throw Object.assign(new Error('這個時間放不下'), { status: 409, conflicts: [{ type: 'deadline' }] }); placed = true; return { ok: true }; }
      if (path === '/tasks/2' && options?.method === 'PATCH') { deadline = options.body.deadline_date; return { id: 2, ...options.body }; }
      return [];
    });
    render(<PlanTimeline plan={{ planId: 1, status: 'active' }} tasks={[{ id: 2, title: '截止已過', deadline_date: D(-1), estimated_minutes: 60 }]} />);
    const overdue = await screen.findByRole('region', { name: /已逾期/ });
    fireEvent.click(within(overdue).getByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: D(2) } });
    expect(await screen.findByText('這個時間放不下')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('最晚完成日'), { target: { value: D(5) } });
    await waitFor(() => expect(screen.queryByText('這個時間放不下')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: '儲存變更' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const order = api.mock.calls.filter(([path, o]) => path === '/tasks/2' || (path === '/schedule/manual' && !o?.body?.dry_run)).map(([path]) => path);
    expect(order).toEqual(['/tasks/2', '/schedule/manual']);
    expect(screen.queryByRole('region', { name: /已逾期/ })).not.toBeInTheDocument();
  });

  it('截止日已存但排程被拒時明說只存了一半，不假裝成功也不重送', async () => {
    api.mockImplementation(async (path, options) => {
      if (path === '/schedule/timeline/1') return buildPlanTimeline({
        plan: { id: 1, status: 'active', target_date: D(30) }, activeVersionId: 9, today: TODAY, blocks: [],
        tasks: [{ id: 2, title: '截止已過', list_id: 1, estimated_minutes: 60, completed: 0, deadline_date: D(-1) }],
      });
      if (path === '/schedule/manual' && options?.body?.dry_run) return { ok: true, conflicts: [] };
      if (path === '/schedule/manual') throw Object.assign(new Error('這個位置已鎖定'), { status: 409, conflicts: [{ type: 'lock' }] });
      if (path === '/tasks/2') return { id: 2, ...options.body };
      return [];
    });
    render(<PlanTimeline plan={{ planId: 1, status: 'active' }} tasks={[{ id: 2, title: '截止已過', deadline_date: D(-1), estimated_minutes: 60 }]} />);
    fireEvent.click(await screen.findByRole('button', { name: '編輯任務' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: D(2) } });
    fireEvent.change(screen.getByLabelText('最晚完成日'), { target: { value: D(5) } });
    await waitFor(() => expect(screen.getByRole('button', { name: '儲存變更' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '儲存變更' }));
    expect(await screen.findByText(/任務內容已儲存，但日期／時間未儲存/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '儲存變更' })).not.toBeInTheDocument();
    expect(api.mock.calls.filter(([path, o]) => path === '/schedule/manual' && !o?.body?.dry_run)).toHaveLength(1);
  });

  it('已完成的過去任務取消勾選後重新載入，直接回到已逾期，不經過未指定日期', async () => {
    let completed = 1;
    let releasePatch;
    const view = () => buildPlanTimeline({
      plan: { id: 1, status: 'active', target_date: D(30) }, activeVersionId: 9, today: TODAY, blocks: [],
      tasks: [{ id: 6, title: '過去已完成', list_id: 1, estimated_minutes: 60, completed }],
      // 與後端 route 一致：只替未完成的 Task 查歷史安排日期。
      lastScheduledByTask: completed ? new Map() : new Map([[6, D(-3)]]),
    });
    api.mockImplementation((path, options) => {
      if (path === '/schedule/timeline/1') return Promise.resolve(view());
      if (path === '/tasks/6' && options?.method === 'PATCH') return new Promise(resolve => { releasePatch = () => { completed = 0; resolve({ ok: true }); }; });
      return Promise.resolve([]);
    });
    render(<PlanTimeline plan={{ planId: 1, status: 'active' }} />);
    const done = await screen.findByRole('region', { name: /已完成紀錄/ });
    fireEvent.click(within(done).getByRole('button', { name: '取消完成「過去已完成」' }));
    // 等待伺服器期間不在本地猜位置：不出現「未指定日期」，也不提前離開已完成區。
    expect(screen.queryByText('未指定日期')).not.toBeInTheDocument();
    expect(within(done).getByText('過去已完成')).toBeInTheDocument();
    releasePatch();
    const overdue = await screen.findByRole('region', { name: /已逾期/ });
    expect(within(overdue).getByText('過去已完成')).toBeInTheDocument();
    expect(within(overdue).getByRole('button', { name: '完成「過去已完成」' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('未指定日期')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /已完成紀錄/ })).not.toBeInTheDocument();
  });
});
