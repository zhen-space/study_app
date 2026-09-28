// Plan Detail 首屏（PlanRangeView）：白話呈現「各科考試哪天 → 要讀完哪些範圍
// （科目→教材→課/章＋手動範圍）→（有排程才顯示）每天要做的」。資料來自 /plans/:id/exam。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { act } from 'react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const PlanRangeView = (await import('../tt/PlanRangeView')).default;

const LISTS = [{ id: 1, name: '數學' }, { id: 2, name: '物理' }];
const plan = { planId: 1, status: 'active', name: '第二次段考', end: '2099-10-02' };

function mockApi({ exam = null, timeline = null } = {}) {
  api.mockImplementation(async (path = '') => {
    if (path.includes('/exam')) return exam || { plan: {}, subjects: [], material: [], manual_scope: [] };
    if (path.includes('/schedule/timeline')) return timeline || { segments: [], items: [], unscheduled: [] };
    return {};
  });
}
const mat = o => ({ material_completed: false, ...o });

beforeEach(() => api.mockReset());
afterEach(() => cleanup());

describe('PlanRangeView', () => {
  it('顯示各科考試日與科目→教材→課的具體範圍＋手動範圍', async () => {
    mockApi({ exam: {
      plan: { target_date: '2099-10-02' },
      subjects: [{ subject_list_id: 1, subject_name: '數學', exam_date: '2099-09-28' }, { subject_list_id: 2, subject_name: '物理', exam_date: '2099-10-02' }],
      material: [
        mat({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '數學課本', chapter_title: '第一課 力學', title: '1-1 內文' }),
        mat({ content_item_id: 12, subject_list_id: 1, book_id: 5, book_title: '數學課本', chapter_title: '第一課 力學', title: '1-2 例題', material_completed: true }),
        mat({ content_item_id: 21, subject_list_id: 2, book_id: 7, book_title: '物理講義', chapter_title: '第二章 熱', title: '2-1' }),
      ],
      manual_scope: [{ id: 9, subject_list_id: 1, label: '老師講義第三章' }],
    } });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    await waitFor(() => expect(screen.getByText('要讀完的範圍')).toBeTruthy());
    expect(screen.getByText(/段考到 10\/2/)).toBeTruthy();
    expect(screen.getByText('數學')).toBeTruthy();
    expect(screen.getByText('物理')).toBeTruthy();
    expect(screen.getByText('考試 9/28')).toBeTruthy();   // 單科考試日
    expect(screen.getByText('第一課 力學')).toBeTruthy();
    expect(screen.getByText('1-1 內文')).toBeTruthy();
    expect(screen.getByText(/老師講義第三章/)).toBeTruthy(); // 手動範圍
    expect(screen.getByText(/範圍已完成 1／4/)).toBeTruthy();
  });

  it('有每日排程時顯示「每天要做的」', async () => {
    mockApi({
      exam: { plan: { target_date: '2099-10-02' }, subjects: [{ subject_list_id: 1, subject_name: '數學', exam_date: '2099-10-02' }],
        material: [mat({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '數學課本', chapter_title: '第一課', title: '1-1' })], manual_scope: [] },
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

  it('點一下範圍項目就標記完成（呼叫 completion API，重讀後打勾＋計數更新）', async () => {
    let completed = false;
    const examOf = () => ({
      plan: { target_date: '2099-10-02' },
      subjects: [{ subject_list_id: 1, subject_name: '數學', exam_date: '2099-10-02' }],
      material: [mat({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '數學課本', chapter_title: '第一課', title: '1-1 內文', material_completed: completed })],
      manual_scope: [],
    });
    const calls = [];
    api.mockImplementation(async (path = '', opts) => {
      calls.push([path, opts?.method, opts?.body]);
      if (path.includes('/completion')) { completed = !!opts?.body?.completed; return { ok: true }; }
      if (path.includes('/exam')) return examOf();
      if (path.includes('/schedule/timeline')) return { segments: [], items: [], unscheduled: [] };
      return {};
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    await waitFor(() => expect(screen.getByText(/範圍已完成 0／1/)).toBeTruthy());
    const item = screen.getByLabelText('標記完成：1-1 內文');
    await act(async () => { fireEvent.click(item); });
    // 呼叫了 completion API（completed=true），且**沒有**動到 plan selection
    await waitFor(() => expect(calls.some(c => String(c[0]).includes('/material/content-items/11/completion') && c[1] === 'PUT' && c[2]?.completed === true)).toBe(true));
    expect(calls.some(c => String(c[0]).includes('/material-items') && c[1] === 'POST')).toBe(false);
    // 重讀後計數更新為 1／1，且可再點一次取消完成
    await waitFor(() => expect(screen.getByText(/範圍已完成 1／1/)).toBeTruthy());
    expect(screen.getByLabelText('取消完成：1-1 內文')).toBeTruthy();
  });

  it('completion API 失敗時顯示錯誤、不卡死（可再試）', async () => {
    api.mockImplementation(async (path = '', opts) => {
      if (path.includes('/completion')) throw Object.assign(new Error('模擬更新失敗'), { status: 500 });
      if (path.includes('/exam')) return { plan: { target_date: '2099-10-02' }, subjects: [{ subject_list_id: 1, subject_name: '數學', exam_date: '2099-10-02' }],
        material: [mat({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '數學課本', chapter_title: '第一課', title: '1-1 內文' })], manual_scope: [] };
      if (path.includes('/schedule/timeline')) return { segments: [], items: [], unscheduled: [] };
      return {};
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    const item = await screen.findByLabelText('標記完成：1-1 內文');
    await act(async () => { fireEvent.click(item); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/失敗/));
    // 按鈕恢復可用（未卡死）
    expect(screen.getByLabelText('標記完成：1-1 內文').disabled).toBe(false);
  });

  it('沒有範圍時給「加入要考的範圍」入口', async () => {
    const onAddRange = vi.fn();
    mockApi({ exam: { plan: { target_date: '2099-10-02' }, subjects: [], material: [], manual_scope: [] } });
    render(<PlanRangeView plan={plan} lists={LISTS} onAddRange={onAddRange} />);
    await waitFor(() => expect(screen.getByText('還沒加入要考的範圍')).toBeTruthy());
    expect(screen.getByText('加入要考的範圍')).toBeTruthy();
  });
});
