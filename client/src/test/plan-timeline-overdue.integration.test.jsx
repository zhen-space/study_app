// 前後端整合：用真正的後端 projection（buildPlanTimeline）產生 /schedule/timeline 回應，
// 交給 PlanTimeline 呈現。確保「已不在 active 版本的過去安排」也會出現在最上方已逾期區，
// 今天到期不算逾期，其餘仍依每日日期分區。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
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
});
