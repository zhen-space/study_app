// Plan Detail 首屏（PlanRangeView）：白話呈現「各科考試哪天 → 要讀完哪些範圍
// （科目→教材→課/章＋手動範圍）→（有排程才顯示）每天要做的」。資料來自 /plans/:id/exam。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

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
  it('active 計畫先預覽再移除；失敗保留確認視窗並可重試', async () => {
    const exam = { plan: {}, subjects: [{ subject_list_id: 1, subject_name: '數學' }],
      material: [mat({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '課本', chapter_title: '第一章', title: '第一課' })], manual_scope: [] };
    let applies = 0;
    api.mockImplementation(async (path = '') => {
      if (path.includes('/exam')) return exam;
      if (path.includes('/timeline')) return { segments: [], items: [], unscheduled: [] };
      if (path.endsWith('/preview')) return { content_item_id: 11, title: '第一課', base_version_id: 3,
        token: 'signed', will_cancel_task: true, removed_block_count: 1 };
      if (path.endsWith('/apply')) { applies += 1; if (applies === 1) throw new Error('暫時失敗'); return {}; }
      return {};
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    fireEvent.click(await screen.findByRole('button', { name: '移除' }));
    expect(await screen.findByText(/完成紀錄、讀書紀錄與歷史排程都會保留/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '確認移除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暫時失敗');
    fireEvent.click(screen.getByRole('button', { name: '確認移除' }));
    await waitFor(() => expect(applies).toBe(2));
    expect(api).toHaveBeenCalledWith('/schedule/material-scope/remove/apply', expect.objectContaining({
      body: { plan_id: 1, content_item_id: 11, base_version_id: 3, token: 'signed' },
    }));
  });

  it('非 active 計畫不顯示移除入口', async () => {
    mockApi({ exam: { plan: {}, subjects: [{ subject_list_id: 1, subject_name: '數學' }],
      material: [mat({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '課本', chapter_title: '第一章', title: '第一課' })], manual_scope: [] } });
    render(<PlanRangeView plan={{ ...plan, status: 'completed' }} lists={LISTS} />);
    await screen.findByText('第一課');
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull();
  });
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
    expect(screen.getAllByText('數學').length).toBeGreaterThan(0);
    expect(screen.getAllByText('物理').length).toBeGreaterThan(0);
    expect(screen.getAllByText('考試 9/28').length).toBeGreaterThan(0);   // 單科考試日
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

  it('沒有範圍時給「加入要考的範圍」入口', async () => {
    const onAddRange = vi.fn();
    mockApi({ exam: { plan: { target_date: '2099-10-02' }, subjects: [], material: [], manual_scope: [] } });
    render(<PlanRangeView plan={plan} lists={LISTS} onAddRange={onAddRange} />);
    await waitFor(() => expect(screen.getByText('還沒加入要考的範圍')).toBeTruthy());
    expect(screen.getByText('加入要考的範圍')).toBeTruthy();
  });
});

describe('教材範圍移除恢復', () => {
  const exam = { plan: {}, subjects: [{ subject_list_id: 1, subject_name: '數學' }],
    material: [mat({ content_item_id: 11, subject_list_id: 1, book_id: 5, book_title: '課本', chapter_title: '第一章', title: '第一課' })], manual_scope: [] };
  const preview = { content_item_id: 11, title: '第一課', base_version_id: 3, token: 'signed', will_cancel_task: true, removed_block_count: 1 };

  it('375px pending apply 禁止 backdrop、Escape、取消，且同步 guard 只送一次', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    let resolveApply;
    api.mockImplementation((path = '') => {
      if (path.includes('/exam')) return Promise.resolve(exam);
      if (path.includes('/timeline')) return Promise.resolve({ segments: [], items: [], unscheduled: [] });
      if (path.endsWith('/preview')) return Promise.resolve(preview);
      if (path.endsWith('/apply')) return new Promise(resolve => { resolveApply = resolve; });
      return Promise.resolve({});
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    fireEvent.click(await screen.findByRole('button', { name: '移除' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '確認移除' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '確認移除' }));
    fireEvent.click(document.querySelector('.sheet-backdrop'));
    expect(screen.getByRole('dialog', { name: '移除教材範圍' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '移除教材範圍' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('dialog', { name: '移除教材範圍' })).toBeInTheDocument();
    expect(api.mock.calls.filter(([p]) => p.endsWith('/apply'))).toHaveLength(1);
    resolveApply({ version_id: 8 });
  });

  it('同步 ref guard 阻止快速重入 apply', async () => {
    let confirm; let nested = false;
    api.mockImplementation((path = '') => {
      if (path.includes('/exam')) return Promise.resolve(exam);
      if (path.includes('/timeline')) return Promise.resolve({ segments: [], items: [], unscheduled: [] });
      if (path.endsWith('/preview')) return Promise.resolve(preview);
      if (path.endsWith('/apply')) {
        if (!nested) {
          nested = true;
          const key = Object.keys(confirm).find(k => k.startsWith('__reactProps'));
          confirm[key].onClick();
        }
        return Promise.resolve({ version_id: 8 });
      }
      return Promise.resolve({});
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    fireEvent.click(await screen.findByRole('button', { name: '移除' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '確認移除' })).toBeEnabled());
    confirm = screen.getByRole('button', { name: '確認移除' });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.mock.calls.filter(([p]) => p.endsWith('/apply'))).toHaveLength(1));
  });
  it('apply 成功但 load 失敗只重試 load，不重送 apply', async () => {
    let applied = false; let refreshFails = true;
    api.mockImplementation((path = '') => {
      if (path.endsWith('/preview')) return Promise.resolve(preview);
      if (path.endsWith('/apply')) { applied = true; return Promise.resolve({ version_id: 8 }); }
      if (path.includes('/exam')) {
        if (applied && refreshFails) { refreshFails = false; return Promise.reject(new Error('刷新失敗')); }
        return Promise.resolve(exam);
      }
      if (path.includes('/timeline')) return Promise.resolve({ segments: [], items: [], unscheduled: [] });
      return Promise.resolve({});
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    fireEvent.click(await screen.findByRole('button', { name: '移除' }));
    fireEvent.click(await screen.findByRole('button', { name: '確認移除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('範圍已移除，但畫面暫時無法更新');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '移除教材範圍' })).toBeNull());
    expect(api.mock.calls.filter(([p]) => p.endsWith('/apply'))).toHaveLength(1);
  });

  it('成功移除並載入後可立即預覽另一個範圍', async () => {
    const secondExam = { ...exam, material: [
      ...exam.material,
      mat({ content_item_id: 12, subject_list_id: 1, book_id: 5, book_title: '課本', chapter_title: '第一章', title: '第二課' }),
    ] };
    const refreshedExam = { ...secondExam, material: secondExam.material.filter(row => row.content_item_id === 12) };
    let applied = false;
    api.mockImplementation((path = '', options) => {
      if (path.includes('/exam')) return Promise.resolve(applied ? refreshedExam : secondExam);
      if (path.includes('/timeline')) return Promise.resolve({ segments: [], items: [], unscheduled: [] });
      if (path.endsWith('/preview')) {
        const id = options.body.content_item_id;
        return Promise.resolve({ ...preview, content_item_id: id, title: id === 11 ? '第一課' : '第二課', token: `signed-${id}` });
      }
      if (path.endsWith('/apply')) { applied = true; return Promise.resolve({ version_id: 8 }); }
      return Promise.resolve({});
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    const removeButtons = await screen.findAllByRole('button', { name: '移除' });
    fireEvent.click(removeButtons[0]);
    fireEvent.click(await screen.findByRole('button', { name: '確認移除' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '移除教材範圍' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(await screen.findByText('要移除「第二課」嗎？')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/schedule/material-scope/remove/preview', expect.objectContaining({
      body: { plan_id: 1, content_item_id: 12 },
    }));
  });

  it('同步 ref guard 阻止快速重入 preview', async () => {
    let removeButton; let nested = false;
    api.mockImplementation((path = '') => {
      if (path.includes('/exam')) return Promise.resolve(exam);
      if (path.includes('/timeline')) return Promise.resolve({ segments: [], items: [], unscheduled: [] });
      if (path.endsWith('/preview')) {
        if (!nested) {
          nested = true;
          const key = Object.keys(removeButton).find(k => k.startsWith('__reactProps'));
          removeButton[key].onClick();
        }
        return Promise.resolve(preview);
      }
      return Promise.resolve({});
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    removeButton = await screen.findByRole('button', { name: '移除' });
    fireEvent.click(removeButton);
    await screen.findByText('要移除「第一課」嗎？');
    expect(api.mock.calls.filter(([path]) => path.endsWith('/preview'))).toHaveLength(1);
  });

  it('stale apply 關閉舊 preview 並要求重新預覽', async () => {
    api.mockImplementation((path = '') => {
      if (path.includes('/exam')) return Promise.resolve(exam);
      if (path.includes('/timeline')) return Promise.resolve({ segments: [], items: [], unscheduled: [] });
      if (path.endsWith('/preview')) return Promise.resolve(preview);
      if (path.endsWith('/apply')) return Promise.reject(Object.assign(new Error('stale'), { status: 409, payload: { code: 'STALE_SCHEDULE_PREVIEW' } }));
      return Promise.resolve({});
    });
    render(<PlanRangeView plan={plan} lists={LISTS} />);
    fireEvent.click(await screen.findByRole('button', { name: '移除' }));
    fireEvent.click(await screen.findByRole('button', { name: '確認移除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('請重新點「移除」取得最新預覽');
    expect(screen.queryByRole('dialog', { name: '移除教材範圍' })).toBeNull();
  });
});
