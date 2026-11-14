// 計畫明細（375px）：已逾期／尚未安排的區分、依日期／依科目切換、長按拖曳改期。
// 計畫任務的日期屬於 ScheduledBlock／ScheduleVersion：拖曳只能走 /schedule/manual，
// 不可 PATCH due_date；stale、衝突、回應遺失都要回到原位或鎖住，不能重送。
import { act } from 'react';
import { fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fx from './fixtures';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const PlanDetailView = (await import('../tt/PlanDetailView')).default;

const TD = today();
const D = n => addDays(TD, n);
const md = d => `${+d.slice(5, 7)}/${+d.slice(8)}`;
const plan = { ...fx.plans[0], id: 12, status: 'active' };
const mk = (id, title, extra = {}) => ({
  id, title, list_id: 1, plan_id: 12, plan_status: 'active', due_date: null, due_time: null,
  completed: 0, deleted: 0, priority: 0, tags: [], subtasks: [], order_index: id, ...extra,
});
const sample = () => [
  mk(1, '前天的進度', { last_scheduled_date: D(-2) }),
  mk(2, '從沒排過'),
  mk(3, '明天的進度', { due_date: D(1), due_time: '19:00' }),
  mk(4, '分兩段', { due_date: D(2) }),
  mk(5, '截止已過未排', { deadline_date: D(-1) }),
  mk(6, '已經完成', { completed: 1, due_date: D(-3) }),
];
const blocks = [
  { id: 101, task_id: 3, date: D(1), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
  { id: 102, task_id: 4, date: D(2), start_time: null, end_time: null, planned_minutes: null },
  { id: 103, task_id: 4, date: D(3), start_time: null, end_time: null, planned_minutes: null },
];

let handlers;
let activeVersion;
const manualWrites = () => api.mock.calls.filter(([path, o]) => path === '/schedule/manual' && !o?.body?.dry_run);
const taskWrites = () => api.mock.calls.filter(([path, o]) => String(path).startsWith('/tasks') && o?.method);
const region = name => screen.getByRole('region', { name });
const rowOf = title => screen.getByText(title).closest('[aria-grabbed]') || screen.getByText(title).closest('.ui-row').parentElement;
const wait = ms => act(() => new Promise(r => setTimeout(r, ms)));

function mount({ tasks = sample(), reload = vi.fn().mockResolvedValue(undefined), apiPlan = plan } = {}) {
  const utils = render(<PlanDetailView planKey="plan:12" tasks={tasks} lists={fx.lists} apiPlans={[apiPlan]}
    reload={reload} onBack={vi.fn()} goWizard={vi.fn()} adjustPlan={vi.fn()} />);
  return { ...utils, reload };
}

// 長按 → 拖到 data-drop-date=target 的區域 → 放開（事件打在原本那一列，冒泡到 document）。
async function longPressDrag(title, target, { release = true } = {}) {
  const el = rowOf(title);
  fireEvent.touchStart(el, { touches: [{ clientX: 40, clientY: 40 }] });
  await wait(500);
  document.elementFromPoint = () => document.querySelector(`[data-drop-date="${target}"]`);
  fireEvent.touchMove(el, { touches: [{ clientX: 40, clientY: 600 }] });
  if (release) await act(async () => { fireEvent.touchEnd(el, { touches: [] }); });
  return el;
}
const dragHint = () => screen.queryByText('拖到要移動的日期分區後放開');

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  activeVersion = 50;
  handlers = {};
  api.mockReset();
  api.mockImplementation((path, options = {}) => {
    if (handlers[path]) return handlers[path](options);
    if (path === '/schedule/active') return Promise.resolve({ active: true, version: { id: activeVersion }, blocks, unplaced: [] });
    if (path === '/material/books') return Promise.resolve([]);
    if (path.endsWith('/exam')) return Promise.resolve({ subjects: [], material: [], manual_scope: [] });
    if (path.includes('/health')) return Promise.resolve({ status: 'healthy', reasons: [] });
    if (path.startsWith('/schedule/timeline')) return Promise.resolve({ segments: [], items: [], deadlines: [], gaps: [], unscheduled: [], no_active_schedule: true });
    if (path === '/schedule/manual') return Promise.resolve({ ok: true, conflicts: [] });
    return Promise.resolve({});
  });
});
afterEach(() => { cleanup(); delete document.elementFromPoint; });

const ready = () => waitFor(() => expect(api).toHaveBeenCalledWith('/schedule/active'));

describe('已逾期與尚未安排', () => {
  it('過去排過且未完成才標「已逾期」；從沒排過、無日期仍是「尚未安排」', async () => {
    mount(); await ready();
    const overdue = region('已逾期');
    for (const t of ['前天的進度', '截止已過未排']) expect(within(overdue).getByText(t)).toBeInTheDocument();
    expect(within(rowOf('前天的進度')).getByText('已逾期')).toBeInTheDocument();
    expect(within(rowOf('前天的進度')).getByText(`原定 ${md(D(-2))}`)).toBeInTheDocument();
    expect(within(rowOf('截止已過未排')).getByText(`截止 ${md(D(-1))}`)).toBeInTheDocument();
    const never = region('尚未安排');
    expect(within(never).getByText('從沒排過')).toBeInTheDocument();
    expect(within(never).queryByText('前天的進度')).toBeNull();
    expect(within(rowOf('從沒排過')).queryByText('已逾期')).toBeNull();
    expect(within(rowOf('明天的進度')).queryByText('已逾期')).toBeNull();
    expect(within(rowOf('明天的進度')).queryByText('尚未安排')).toBeNull();
  });
});

describe('依日期／依科目', () => {
  it('精簡切換在計畫內容標題列（不在頁首），依日期按日期分區並記住偏好', async () => {
    const { unmount } = mount(); await ready();
    const toggles = screen.getAllByRole('tablist', { name: '計畫內容分區' });
    expect(toggles).toHaveLength(1);
    expect(document.querySelector('.main-head').contains(toggles[0])).toBe(false);
    expect(within(toggles[0]).getByRole('tab', { name: '依科目' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(toggles[0]).getByRole('tab', { name: '依日期' }));
    expect(localStorage.getItem('planContentGroup')).toBe('date');
    const sections = [...document.querySelectorAll('section[aria-label]')].map(s => s.getAttribute('aria-label'))
      .filter(l => ['已逾期', '尚未安排'].includes(l) || /週/.test(l));
    expect(sections[0]).toBe('已逾期');
    expect(sections.at(-1)).toBe('尚未安排');
    expect(within(region(`${md(D(1))}（週${'日一二三四五六'[new Date(D(1) + 'T00:00:00').getDay()]}）`)).getByText('明天的進度')).toBeInTheDocument();
    expect(within(rowOf('前天的進度')).getByText('已逾期')).toBeInTheDocument();
    unmount();
    mount(); await ready();
    expect(screen.getByRole('tab', { name: '依日期' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('375px 長按拖曳改期（ScheduleVersion domain）', () => {
  it('已從 active 版本消失的逾期任務：以 task_id 重新加入，立即移動，不 PATCH due_date', async () => {
    localStorage.setItem('planContentGroup', 'date');
    let finish;
    handlers['/schedule/manual'] = () => new Promise(r => { finish = () => r({ ok: true }); });
    const { reload } = mount(); await ready();
    await longPressDrag('前天的進度', D(1));
    expect(manualWrites()).toHaveLength(1);
    expect(manualWrites()[0][1]).toEqual({ method: 'POST', body: { base_version_id: 50, moves: [{ task_id: 1, date: D(1) }] } });
    expect(taskWrites()).toHaveLength(0);
    // 寫入完成前已在明天的分區、不再是已逾期。
    expect(screen.getByText('前天的進度').closest('section').getAttribute('aria-label')).toMatch(/週/);
    expect(within(rowOf('前天的進度')).queryByText('已逾期')).toBeNull();
    await act(async () => { finish(); });
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(api.mock.calls.filter(([p]) => p === '/schedule/active').length).toBeGreaterThanOrEqual(2);
  });

  it('依科目時也能拖到底部的「明天」；單段 timed block 以 block_id 搬動並保留時段', async () => {
    mount(); await ready();
    await longPressDrag('明天的進度', D(1), { release: false });
    // 原本就在明天：放下不寫入。
    await act(async () => { fireEvent.touchEnd(rowOf('明天的進度'), { touches: [] }); });
    expect(manualWrites()).toHaveLength(0);
    await longPressDrag('明天的進度', TD);
    expect(manualWrites()[0][1].body).toEqual({ base_version_id: 50, moves: [{ block_id: 101, date: TD, start_time: '19:00', end_time: '20:00' }] });
  });

  it('拖到「其他日期…」開日期選擇器，選任意日期才寫入；取消不寫入', async () => {
    mount(); await ready();
    await longPressDrag('從沒排過', '__pick__');
    const sheet = await screen.findByRole('dialog', { name: '移到其他日期' });
    fireEvent.click(within(sheet).getByRole('button', { name: '取消' }));
    expect(manualWrites()).toHaveLength(0);
    await longPressDrag('從沒排過', '__pick__');
    const again = await screen.findByRole('dialog', { name: '移到其他日期' });
    expect(within(again).getByRole('button', { name: '移到這一天' })).toBeDisabled();
    fireEvent.change(within(again).getByLabelText('日期'), { target: { value: D(9) } });
    await act(async () => { fireEvent.click(within(again).getByRole('button', { name: '移到這一天' })); });
    expect(manualWrites()[0][1].body.moves).toEqual([{ task_id: 2, date: D(9) }]);
  });

  it('沒有日期的列也有「選日期」按鈕（非觸控的替代入口）', async () => {
    mount(); await ready();
    fireEvent.click(screen.getByRole('button', { name: '替「前天的進度」選擇日期' }));
    expect(await screen.findByRole('dialog', { name: '移到其他日期' })).toBeInTheDocument();
  });

  it('衝突被拒：回到已逾期並說明原因，不重送', async () => {
    handlers['/schedule/manual'] = () => Promise.reject(Object.assign(new Error('這個時間放不下'), {
      status: 409, conflicts: [{ type: 'deadline', message: '這一天已經超過這個任務的截止日' }],
    }));
    mount(); await ready();
    await longPressDrag('截止已過未排', D(1));
    expect(await screen.findByText('這一天已經超過這個任務的截止日')).toBeInTheDocument();
    expect(within(region('已逾期')).getByText('截止已過未排')).toBeInTheDocument();
    expect(manualWrites()).toHaveLength(1);
  });

  it('stale 版本：回到原位、只讀回最新 active 版本；再拖才以新版本送出', async () => {
    handlers['/schedule/manual'] = o => (o.body.base_version_id === 50
      ? Promise.reject(Object.assign(new Error('排程在你預覽之後已被其他變更取代'), { status: 409 }))
      : Promise.resolve({ ok: true }));
    mount(); await ready();
    activeVersion = 51;
    await longPressDrag('前天的進度', D(1));
    expect(await screen.findByText('排程已在別處更新，已載入最新安排，請再拖一次。')).toBeInTheDocument();
    expect(within(region('已逾期')).getByText('前天的進度')).toBeInTheDocument();
    expect(manualWrites()).toHaveLength(1);
    await waitFor(() => expect(api.mock.calls.filter(([p]) => p === '/schedule/active').length).toBeGreaterThanOrEqual(2));
    await longPressDrag('前天的進度', D(1));
    expect(manualWrites()).toHaveLength(2);
    expect(manualWrites()[1][1].body.base_version_id).toBe(51);
  });

  it('回應遺失：讀回 active 版本已含新安排＝成功；版本未變＝回到原位', async () => {
    for (const committed of [true, false]) {
      handlers['/schedule/manual'] = () => { if (committed) activeVersion = 60; return Promise.reject(new Error('連線中斷')); };
      handlers['/schedule/active'] = () => Promise.resolve({ active: true, version: { id: activeVersion },
        blocks: committed && activeVersion === 60 ? [...blocks, { id: 200, task_id: 1, date: D(1) }] : blocks });
      const { reload } = mount(); await ready();
      await longPressDrag('前天的進度', D(1));
      if (committed) {
        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(screen.queryByText('連線中斷')).toBeNull();
      } else {
        expect(await screen.findByText('連線中斷')).toBeInTheDocument();
        expect(within(region('已逾期')).getByText('前天的進度')).toBeInTheDocument();
      }
      expect(manualWrites()).toHaveLength(1);
      cleanup(); api.mockClear(); activeVersion = 50; delete handlers['/schedule/active'];
    }
  });

  it('無法確認：鎖住該列（不能再拖、不能勾選），只能重新載入確認', async () => {
    handlers['/schedule/manual'] = () => Promise.reject(new Error('連線中斷'));
    const { reload } = mount(); await ready();
    handlers['/schedule/active'] = () => Promise.reject(new Error('讀回失敗'));
    await longPressDrag('前天的進度', D(1));
    expect(await screen.findByText('無法確認日期是否已更新')).toBeInTheDocument();
    expect(within(region('已逾期')).getByText('前天的進度')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '前天的進度' })).toBeDisabled();
    await longPressDrag('前天的進度', D(2));
    expect(dragHint()).toBeNull();
    expect(manualWrites()).toHaveLength(1);
    delete handlers['/schedule/active'];
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新載入確認' })); });
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(screen.queryByText('無法確認日期是否已更新')).toBeNull();
    expect(screen.getByRole('checkbox', { name: '前天的進度' })).toBeEnabled();
    expect(manualWrites()).toHaveLength(1);
  });

  it('寫入中同一列不能再拖（唯一性）；舊資料晚到不拉回', async () => {
    localStorage.setItem('planContentGroup', 'date');
    let finish;
    handlers['/schedule/manual'] = () => new Promise(r => { finish = () => r({ ok: true }); });
    const reload = vi.fn().mockResolvedValue(undefined);
    const { rerender } = mount({ reload }); await ready();
    await longPressDrag('前天的進度', D(1));
    rerender(<PlanDetailView planKey="plan:12" tasks={sample()} lists={fx.lists} apiPlans={[plan]}
      reload={reload} onBack={vi.fn()} goWizard={vi.fn()} adjustPlan={vi.fn()} />);
    expect(within(rowOf('前天的進度')).queryByText('已逾期')).toBeNull();
    await longPressDrag('前天的進度', D(2));
    expect(manualWrites()).toHaveLength(1);
    await act(async () => { finish(); });
  });

  it('分成多段、已完成、已結束計畫都不能拖；先移動（捲動）或在勾選框上長按也不啟動', async () => {
    mount(); await ready();
    await longPressDrag('分兩段', TD);
    expect(dragHint()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /已完成/ }));
    await longPressDrag('已經完成', TD);
    expect(dragHint()).toBeNull();
    const r = rowOf('從沒排過');
    fireEvent.touchStart(r, { touches: [{ clientX: 40, clientY: 40 }] });
    fireEvent.touchMove(r, { touches: [{ clientX: 40, clientY: 90 }] });
    await wait(500);
    expect(dragHint()).toBeNull();
    fireEvent.touchEnd(r, { touches: [] });
    const box = screen.getByRole('checkbox', { name: '從沒排過' });
    fireEvent.touchStart(box, { touches: [{ clientX: 10, clientY: 40 }] });
    await wait(500);
    expect(dragHint()).toBeNull();
    fireEvent.touchEnd(box, { touches: [] });
    expect(manualWrites()).toHaveLength(0);
    cleanup();
    mount({ apiPlan: { ...plan, status: 'ended' } }); await ready();
    await longPressDrag('前天的進度', TD);
    expect(dragHint()).toBeNull();
    expect(manualWrites()).toHaveLength(0);
    expect(taskWrites()).toHaveLength(0);
  });
});
