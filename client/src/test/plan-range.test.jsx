// Plan Detail 首屏（PlanRangeView）：白話呈現「考試哪天 → 要讀完哪些範圍（科目→教材→
// 課/章）→（有排程才顯示）每天要做的」，不先顯示抽象儀表板/術語。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const PlanRangeView = (await import('../tt/PlanRangeView')).default;

const LISTS = [{ id: 1, name: '數學' }, { id: 2, name: '物理' }];
const plan = { planId: 1, status: 'active', name: '第二次段考', end: '2099-10-02' };

function mockApi({ items = [], segs = null, timeline = null } = {}) {
  api.mockImplementation(async (path = '') => {
    if (path.includes('/material-items')) return items;
    if (path.includes('/progress-segments')) return segs || { segments: [] };
    if (path.includes('/schedule/timeline')) return timeline || { segments: [], items: [], unscheduled: [] };
    return {};
  });
}
const item = (o) => ({ selected: true, material_completed: false, ...o });

beforeEach(() => api.mockReset());
afterEach(() => cleanup());

describe('PlanRangeView', () => {
  it('顯示考試日期＋倒數，與科目→教材→課的具體範圍', async () => {
    mockApi({ items: [
      item({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '數學課本', chapter_title: '第一課 力學', title: '1-1 內文' }),
      item({ content_item_id: 12, subject_list_id: 1, book_id: 5, book_title: '數學課本', chapter_title: '第一課 力學', title: '1-2 例題', material_completed: true }),
      item({ content_item_id: 21, subject_list_id: 2, book_id: 7, book_title: '物理講義', chapter_title: '第二章 熱', title: '2-1' }),
    ] });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    await waitFor(() => expect(screen.getByText('要讀完的範圍')).toBeTruthy());
    expect(screen.getByText(/考試 10\/2/)).toBeTruthy();
    expect(screen.getByText('數學')).toBeTruthy();
    expect(screen.getByText('物理')).toBeTruthy();
    expect(screen.getByText('數學課本')).toBeTruthy();
    expect(screen.getByText('第一課 力學')).toBeTruthy();
    expect(screen.getByText('1-1 內文')).toBeTruthy();
    expect(screen.getByText(/範圍已完成 1／3/)).toBeTruthy();
  });

  it('進度分段存在時，章節標上「M/D 前」', async () => {
    mockApi({
      items: [item({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '數學課本', chapter_title: '第一課', title: '1-1' })],
      segs: { segments: [{ end_date: '2099-09-28', scope: [11] }] },
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    await waitFor(() => expect(screen.getByText('第一課')).toBeTruthy());
    expect(screen.getByText(/9\/28 前/)).toBeTruthy();
  });

  it('有每日排程時顯示「每天要做的」', async () => {
    mockApi({
      items: [item({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '數學課本', chapter_title: '第一課', title: '1-1' })],
      timeline: {
        items: [{ task_id: 91, title: '1-1 內文', material: { path: [{ title: '第一課' }], item_title: '1-1 內文' } }],
        segments: [{ range_start: '2099-09-25', range_end: '2099-09-25', groups: [{ subject_name: '數學', task_ids: [91] }] }],
        unscheduled: [],
      },
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    await waitFor(() => expect(screen.getByText('每天要做的')).toBeTruthy());
    expect(screen.getByText('9/25')).toBeTruthy();
  });

  it('沒有範圍時給「加入要考的範圍」入口', async () => {
    const onAddRange = vi.fn();
    mockApi({ items: [] });
    render(<PlanRangeView plan={plan} lists={LISTS} onAddRange={onAddRange} />);
    await waitFor(() => expect(screen.getByText('還沒加入要考的範圍')).toBeTruthy());
    expect(screen.getByText('加入要考的範圍')).toBeTruthy();
  });
});
