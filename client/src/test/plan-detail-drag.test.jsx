// 計畫明細（375px）：已逾期／尚未安排的區分、依日期／依科目切換、長按拖曳改期。
// 計畫任務的日期屬於 ScheduledBlock／ScheduleVersion：拖曳只能走 /schedule/manual，
// 不可 PATCH due_date；stale、衝突、回應遺失都要回到原位或鎖住，不能重送。
import { act } from 'react';
import { fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fx from './fixtures';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
// 長按需要真實等待 450ms 以上；完整 CI 同時跑多個 jsdom 檔案時，狀態更新可能
// 被延後超過 5 秒。這裡只放寬非同步斷言的等待上限，不縮短長按門檻或跳過驗收。
vi.setConfig({ testTimeout: 30000 });
const { configure } = await import('@testing-library/react');
configure({ asyncUtilTimeout: 15000 });
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
  // 機器忙碌時拖曳狀態可能晚一點才渲染：等到出現拖曳提示（最多 1.5 秒）再移動手指；
  // 不該啟動拖曳的情況就等滿後照樣送出事件，由呼叫端斷言沒有拖曳。
  for (let i = 0; i < 10 && !screen.queryByText('拖到要移動的日期分區後放開'); i++) await wait(150);
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
  const timeline = () => ({ active: true, active_version_id: 50, segments: [], deadlines: [], gaps: [], unscheduled: [], no_active_schedule: false,
    items: [
      { task_id: 1, title: '前天的進度', subject_name: '物理', completion: 'not_started', overdue: true, time_status: 'past_due', last_scheduled_date: D(-2), day_blocks: [] },
      { task_id: 2, title: '從沒排過', subject_name: '物理', completion: 'not_started', display_mode: 'unscheduled', day_blocks: [] },
      { task_id: 3, title: '明天的進度', subject_name: '物理', completion: 'not_started', day_blocks: [{ block_id: 101, date: D(1), start_time: '19:00', end_time: '20:00' }] },
    ] });

  it('日期安排沒有項目時，Plan 內容仍可切換依日期／依科目並真實重排', async () => {
    mount(); await ready();
    const toggle = await screen.findByRole('tablist', { name: 'Plan 內容分區' });
    expect(within(toggle).getByRole('tab', { name: '依科目' })).toHaveAttribute('aria-selected', 'true');
    expect(region('尚未安排')).toHaveTextContent('從沒排過');

    fireEvent.click(within(toggle).getByRole('tab', { name: '依日期' }));

    expect(localStorage.getItem('planContentGroup')).toBe('date');
    expect(region(new RegExp(`^${md(D(1))}`))).toHaveTextContent('明天的進度');
    expect(region('尚未安排')).toHaveTextContent('從沒排過');
  });

  it('切換直接顯示在首屏「日期安排」卡片，依日期／依科目真實重排並記住偏好', async () => {
    handlers['/schedule/timeline/12'] = () => Promise.resolve(timeline());
    const { unmount } = mount(); await ready();
    const toggle = await screen.findByRole('tablist', { name: '日期安排分區' });
    const card = screen.getByText('目前生效的確切安排').closest('.ui-card');
    expect(card).toContainElement(toggle);
    expect(document.querySelector('.main-head').contains(toggle)).toBe(false);
    expect(within(toggle).getByRole('tab', { name: '依科目' })).toHaveAttribute('aria-selected', 'true');
    expect(within(card).getByRole('region', { name: '物理安排' })).toBeInTheDocument();
    fireEvent.click(within(toggle).getByRole('tab', { name: '依日期' }));
    expect(localStorage.getItem('planContentGroup')).toBe('date');
    expect(within(card).getByRole('region', { name: `${md(D(1))}安排` })).toHaveTextContent('明天的進度');
    unmount();
    mount(); await ready();
    expect(await screen.findByRole('tab', { name: '依日期' })).toHaveAttribute('aria-selected', 'true');
  });

  it('首屏日期列有明顯改日期入口，精確搬動該 ScheduledBlock', async () => {
    handlers['/schedule/timeline/12'] = () => Promise.resolve(timeline());
    mount(); await ready();
    const card = (await screen.findByText('目前生效的確切安排')).closest('.ui-card');
    fireEvent.click(within(card).getByRole('button', { name: '改「明天的進度」的日期' }));
    const sheet = await screen.findByRole('dialog', { name: '移到其他日期' });
    expect(within(sheet).getByLabelText('日期')).toHaveValue(D(1));
    fireEvent.change(within(sheet).getByLabelText('日期'), { target: { value: D(5) } });
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '移到這一天' })); });
    expect(manualWrites().at(-1)[1].body).toEqual({ base_version_id: 50,
      moves: [{ block_id: 101, date: D(5), start_time: '19:00', end_time: '20:00' }] });
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
    expect(await screen.findByText('這一天已經超過這個任務的截止日', { selector: '.ui-error' })).toBeInTheDocument();
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
    expect(await screen.findByText('排程已在別處更新，已載入最新安排，請再拖一次。', { selector: '.ui-error' })).toBeInTheDocument();
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
        expect(screen.queryByText('連線中斷', { selector: '.ui-error' })).toBeNull();
      } else {
        expect(await screen.findByText('連線中斷', { selector: '.ui-error' })).toBeInTheDocument();
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

describe('寫入後的權威刷新', () => {
  for (const side of ['tasks', 'schedule']) {
    it(`寫入成功但${side === 'tasks' ? '任務' : 'active 版本'}刷新失敗：兩邊都嘗試、仍鎖定，不能用舊 base 再拖`, async () => {
      const reload = vi.fn().mockResolvedValue(undefined);
      mount({ reload }); await ready();
      // 等畫面真的可拖曳，才注入「寫入後刷新」失敗；API 已呼叫不代表初次載入已完成。
      await waitFor(() => expect(rowOf('前天的進度')).toHaveAttribute('aria-grabbed', 'false'));
      if (side === 'tasks') reload.mockRejectedValueOnce(new Error('任務載入失敗'));
      else handlers['/schedule/active'] = () => Promise.reject(new Error('排程載入失敗'));
      const activeCalls = () => api.mock.calls.filter(([p]) => p === '/schedule/active').length;
      const before = activeCalls();
      await longPressDrag('前天的進度', D(1));
      expect(await screen.findByText('日期已更新，但最新安排暫時無法載入')).toBeInTheDocument();
      // 兩邊都有嘗試：一邊失敗不會跳過另一邊。
      expect(reload).toHaveBeenCalled();
      expect(activeCalls()).toBeGreaterThan(before);
      // 已寫入：留在新日期、不再是已逾期；但整個計畫都鎖住。
      expect(within(rowOf('前天的進度')).queryByText('已逾期')).toBeNull();
      expect(screen.queryByRole('button', { name: /^改「|^替「/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /調整「.*」的時間/ })).toBeNull();
      await longPressDrag('從沒排過', D(2));
      expect(dragHint()).toBeNull();
      expect(manualWrites()).toHaveLength(1);
    });
  }

  it('重試仍有一邊失敗就維持鎖定；兩邊都成功才解鎖，之後以新版本移動', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    mount({ reload }); await ready();
    reload.mockRejectedValueOnce(new Error('任務載入失敗'));
    await longPressDrag('前天的進度', D(1));
    await screen.findByText('日期已更新，但最新安排暫時無法載入');
    // 第一次重試：任務成功、active 版本失敗。
    handlers['/schedule/active'] = () => Promise.reject(new Error('排程載入失敗'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新載入確認' })); });
    expect(await screen.findByText('排程載入失敗')).toBeInTheDocument();
    expect(screen.getByText('日期已更新，但最新安排暫時無法載入')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '替「從沒排過」選擇日期' })).toBeNull();
    // 第二次重試：兩邊都成功（伺服器已是新版本 51）。
    delete handlers['/schedule/active'];
    activeVersion = 51;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新載入確認' })); });
    await waitFor(() => expect(screen.queryByText('日期已更新，但最新安排暫時無法載入')).toBeNull());
    // 放下後 600ms 內的點擊視為瀏覽器補發的 click 而忽略；使用者真正點按鈕時已超過。
    await wait(650);
    fireEvent.click(screen.getByRole('button', { name: '替「從沒排過」選擇日期' }));
    const sheet = await screen.findByRole('dialog', { name: '移到其他日期' });
    fireEvent.change(within(sheet).getByLabelText('日期'), { target: { value: D(6) } });
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '移到這一天' })); });
    expect(manualWrites()).toHaveLength(2);
    expect(manualWrites()[1][1].body).toEqual({ base_version_id: 51, moves: [{ task_id: 2, date: D(6) }] });
  });
});

describe('不靠長按的改日期與無障礙', () => {
  it('已有日期的任務也有「改日期」按鈕（鍵盤可操作），走同一個 manual transaction', async () => {
    mount(); await ready();
    const btn = screen.getByRole('button', { name: '改「明天的進度」的日期' });
    expect(btn.tagName).toBe('BUTTON');
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    const sheet = await screen.findByRole('dialog', { name: '移到其他日期' });
    expect(within(sheet).getByLabelText('日期')).toHaveValue(D(1));
    fireEvent.change(within(sheet).getByLabelText('日期'), { target: { value: D(5) } });
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: '移到這一天' })); });
    expect(manualWrites()[0][1].body).toEqual({ base_version_id: 50, moves: [{ block_id: 101, date: D(5), start_time: '19:00', end_time: '20:00' }] });
    expect(taskWrites()).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`已把「明天的進度」移到 ${md(D(5))}`));
    // 不能移動的（分成多段）沒有改日期按鈕，但仍保留時間調整。
    expect(screen.queryByRole('button', { name: '改「分兩段」的日期' })).toBeNull();
    expect(screen.getByRole('button', { name: '調整「分兩段」的時間' })).toBeInTheDocument();
  });

  it('逾期／原定日期／改日期放在標題下方；拖曳 overlay 不進無障礙樹，狀態另行宣告', async () => {
    mount(); await ready();
    const sub = rowOf('前天的進度').querySelector('.ui-row-sub');
    expect(within(sub).getByText('已逾期')).toBeInTheDocument();
    expect(within(sub).getByText(`原定 ${md(D(-2))}`)).toBeInTheDocument();
    expect(within(sub).getByRole('button', { name: '替「前天的進度」選擇日期' })).toBeInTheDocument();
    expect(rowOf('前天的進度').querySelector('.ui-row-trail')).toBeNull();
    await longPressDrag('前天的進度', D(1), { release: false });
    const overlay = screen.getByText('拖到要移動的日期分區後放開').parentElement;
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('已拿起「前天的進度」');
    await act(async () => { fireEvent.touchCancel(rowOf('前天的進度'), { touches: [] }); });
    expect(manualWrites()).toHaveLength(0);
  });
});

describe('健康卡片：已逾期與尚未安排分開', () => {
  it('同時列出已逾期與真正尚未安排；任務變動後重新取得 health', async () => {
    handlers['/plans/12/health'] = () => Promise.resolve({ status: 'needs_replan', pending: 4, reasons: [
      { type: 'overdue', count: 2, message: '有 2 項已逾期' },
      { type: 'unplaced', count: 1, message: '有 1 項尚未安排' },
    ] });
    const reload = vi.fn().mockResolvedValue(undefined);
    const { rerender } = mount({ reload }); await ready();
    expect(await screen.findByText('有 2 項已逾期、有 1 項尚未安排。')).toBeInTheDocument();
    const healthCalls = () => api.mock.calls.filter(([p]) => p === '/plans/12/health').length;
    const before = healthCalls();
    const moved = sample().map(t => (t.id === 1 ? { ...t, due_date: D(1), last_scheduled_date: undefined } : t));
    rerender(<PlanDetailView planKey="plan:12" tasks={moved} lists={fx.lists} apiPlans={[plan]}
      reload={reload} onBack={vi.fn()} goWizard={vi.fn()} adjustPlan={vi.fn()} />);
    await waitFor(() => expect(healthCalls()).toBeGreaterThan(before));
  });
});
