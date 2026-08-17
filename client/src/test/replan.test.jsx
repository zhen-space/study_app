// Phase 2B-UI-3：Today「計畫需要調整」＋ AI 重排入口。
//
// 這裡守的是三件事：
//   ① 什麼時候該提示、什麼時候絕對不該提示（正常／已完成／已封存／舊資料）
//   ② 重排範圍嚴格以正式 plan_id 為準：不碰已完成、不碰別的計畫、
//      不用 legacy 全域端點
//   ③ 按下「套用新版安排」之前，一個位元組都不寫
//
// 「需要調整」目前只用得起最可靠的訊號（過期未完成／排到目標日之後）。
// 等 2C feasibility 實作後，正式判斷來源會換成後端，這批的 reason model
// 就是為了那時候不用重寫 UI。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;
const { buildSchedulePreviewRequest, taskMinutes } = await import('../tt/schedulePreview');

const iso = n => addDays(today(), n);
const task = (id, over = {}) => ({
  id, list_id: 1, plan_id: 12, title: `任務${id}`, due_date: iso(1), due_time: null,
  priority: 0, completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null,
  deadline_date: null, order_index: id, deleted: 0, ...over,
});

// 一個真的偏離了的計畫：有過期未完成
const PLAN = { ...fx.plans[0], id: 12, name: '第二次段考', start_date: iso(-5), target_date: iso(10) };
const OVERDUE = task(21, { title: '物理｜段考範圍｜力學複習', due_date: iso(-1) });
const NORMAL = task(22, { title: '地科｜段考範圍｜大氣複習', list_id: 2, due_date: iso(1) });
const DONE = task(24, { title: '物理｜段考範圍｜已經讀完的', due_date: iso(-2), completed: 1 });
const PLAN_TASKS = [OVERDUE, NORMAL, DONE];

// 另一個計畫，用來確認重排不會波及
const OTHER_PLAN = { ...PLAN, id: 13, name: '暑假數學' };
const OTHER_TASK = task(31, { plan_id: 13, title: '數學｜暑假｜複習', due_date: iso(-1) });

// 重排結果：把兩筆未完成的搬到新的日子
const REPLAN = {
  check: null,
  blocks: [
    { subject_id: 1, title: OVERDUE.title, date: iso(2), start_time: null, end_time: null, deadline: null },
    { subject_id: 2, title: NORMAL.title, date: iso(3), start_time: null, end_time: null, deadline: null },
  ],
};

let calls;
const setApi = (over = {}) => {
  api.mockImplementation((raw, opts) => {
    calls.push([raw, opts]);
    const path = raw.startsWith('/plans?') ? '/plans' : raw;
    if (path in over) {
      const v = over[path];
      if (typeof v === 'function') return v(opts);
      return Promise.resolve(v);
    }
    if (path === '/schedule/preview') return Promise.resolve(REPLAN);
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    if (path.endsWith('/attachments')) return Promise.resolve([]);
    if (path.startsWith('/plans/') || path.startsWith('/tasks/')) return Promise.resolve({ ok: true });
    return Promise.resolve([]);
  });
};

let errors;
beforeEach(() => {
  calls = [];
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
  localStorage.clear();
  setApi();
});
afterEach(() => { vi.restoreAllMocks(); });

const noCrash = () => {
  const real = errors.filter(e => !/not wrapped in act|validateDOMNesting|unique "key"/i.test(e));
  expect(real, '不應該有 runtime exception：\n' + real.join('\n')).toEqual([]);
};

const click = el => act(async () => { el.click(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const writes = () => calls.filter(([, o]) => o?.method && o.method !== 'GET');
const sent = (path, method) => calls.filter(([p, o]) => p === path && o?.method === method);

// 這個計畫當初設定的排法。刻意每一項都跟「前端隨便給的預設值」不同
// （不是 even、不是一天 3 項、不是時間模式），這樣測試才看得出來是不是真的沿用。
const CONDITIONS = { timed: false, limitPerDay: true, perDay: 2, pace: 'front', exWd: [0], exDates: [iso(5)], busyHours: 4 };
const seedConditions = (planId = 12, over = {}) =>
  localStorage.setItem(`wizardDraft:plan:${planId}`, JSON.stringify({ ...CONDITIONS, ...over }));

// 掛上 Shell 並等資料真的載入完（跟 shell.test.jsx 同一套等法）
async function mountShell(over = {}, { seed = true } = {}) {
  if (seed) { seedConditions(12); seedConditions(13); }
  setApi({ '/tasks': [...PLAN_TASKS], '/plans': [PLAN], ...over });
  const r = render(<Shell onLogout={() => {}} />);
  await screen.findByText('項待完成');
  await waitFor(() => expect(calls.some(([p]) => p.startsWith('/plans'))).toBe(true));
  await flush();
  return r;
}
const banner = () => screen.queryByText('計畫需要調整');
const sheet = () => document.querySelector('.ev-sheet');

describe('什麼時候顯示「計畫需要調整」', () => {
  it('1. 正式計畫有過期未完成 → Today 顯示需要調整', async () => {
    await mountShell();
    expect(banner()).toBeInTheDocument();
    expect(screen.getByText('第二次段考')).toBeInTheDocument();
    expect(screen.getByText(/有 1 項已經過了預定的日子還沒完成/)).toBeInTheDocument();
    noCrash();
  });

  it('2. 一切正常的計畫 → 不顯示', async () => {
    await mountShell({ '/tasks': [NORMAL, DONE] });
    expect(banner()).not.toBeInTheDocument();
    noCrash();
  });

  it('3. 已完成的計畫 → 不提示重排', async () => {
    await mountShell({ '/plans': [{ ...PLAN, status: 'completed' }] });
    expect(banner()).not.toBeInTheDocument();
    noCrash();
  });

  it('4. 已封存的計畫 → 不提示重排', async () => {
    await mountShell({ '/plans': [{ ...PLAN, status: 'archived' }] });
    expect(banner()).not.toBeInTheDocument();
    noCrash();
  });

  it('5. 舊資料（沒有 plan id）→ 不進新版流程', async () => {
    // 一樣過期未完成，但沒有 plan_id
    await mountShell({ '/tasks': [{ ...OVERDUE, plan_id: null }], '/plans': [] });
    expect(banner()).not.toBeInTheDocument();
    noCrash();
  });

  it('6. 多個計畫需要調整 → 顯示摘要，不堆一排大方塊', async () => {
    await mountShell({ '/tasks': [OVERDUE, OTHER_TASK], '/plans': [PLAN, OTHER_PLAN] });
    expect(screen.getByText('2 個計畫需要調整')).toBeInTheDocument();
    expect(banner()).not.toBeInTheDocument();
    // 還沒展開之前不該出現任何重排按鈕
    expect(screen.queryByRole('button', { name: '讓 AI 重新安排' })).not.toBeInTheDocument();
    await click(screen.getByRole('button', { name: '查看' }));
    expect(screen.getAllByRole('button', { name: '讓 AI 重新安排' }).length).toBe(2);
    noCrash();
  });

  it('7. 「稍後」只收起提示，不動任何資料', async () => {
    await mountShell();
    await click(screen.getByRole('button', { name: '稍後' }));
    expect(banner()).not.toBeInTheDocument();
    expect(writes(), '「稍後」不該寫任何東西').toEqual([]);
    noCrash();
  });

  it('21. 沒有未完成任務時不提供重排', async () => {
    await mountShell({ '/tasks': [DONE] });
    expect(banner()).not.toBeInTheDocument();
    noCrash();
  });
});

describe('兩個入口進同一套重排流程', () => {
  it('8. Today 的 CTA 打開重排確認畫面', async () => {
    await mountShell();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    expect(screen.getByText('重新安排「第二次段考」')).toBeInTheDocument();
    // 說清楚會動什麼、不會動什麼
    expect(within(sheet()).getByText(/還沒完成、而且屬於這個計畫的 2 項/)).toBeInTheDocument();
    expect(within(sheet()).getByText('・已經完成的項目')).toBeInTheDocument();
    expect(within(sheet()).getByText('・其他計畫')).toBeInTheDocument();
    // Lock 還沒實作，不可以出現假的「鎖定項目不會修改」
    expect(sheet().textContent).not.toMatch(/鎖定/);
    noCrash();
  });

  it('9. 計畫明細的 CTA 打開同一個重排確認畫面', async () => {
    await mountShell();
    await click(within(document.querySelector('.bottom-nav')).getByText('計畫').closest('button'));
    await click([...document.querySelectorAll('.main .tile')].find(el => el.querySelector('b')?.textContent === '第二次段考'));
    expect(screen.getByText('目前安排需要調整')).toBeInTheDocument();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    expect(screen.getByText('重新安排「第二次段考」')).toBeInTheDocument();
    noCrash();
  });
});

describe('重排範圍與寫入時機', () => {
  const openPreview = async () => {
    await mountShell();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    await click(screen.getByRole('button', { name: '重新安排' }));
    await flush();
  };

  it('15. 產生預覽階段完全不寫入', async () => {
    await openPreview();
    expect(screen.getByText('新的安排已準備好')).toBeInTheDocument();
    expect(writes().map(([p, o]) => `${o.method} ${p}`), '預覽階段不得有任何寫入')
      .toEqual(['POST /schedule/preview']);
    noCrash();
  });

  it('10 & 16. 按下套用才寫入，而且掛在原本的 plan_id 上', async () => {
    await openPreview();
    await click(screen.getByRole('button', { name: '套用新版安排' }));
    await flush();
    const patched = calls.filter(([p, o]) => p.startsWith('/tasks/') && o?.method === 'PATCH').map(([p]) => p);
    expect(patched.sort()).toEqual(['/tasks/21', '/tasks/22']);
    // 重排不建立任務，也不搬計畫
    expect(sent('/tasks/bulk', 'POST').length).toBe(0);
    noCrash();
  });

  it('11. 重排絕對不會 POST /plans', async () => {
    await openPreview();
    await click(screen.getByRole('button', { name: '套用新版安排' }));
    await flush();
    expect(sent('/plans', 'POST').length, '重排不是建立新計畫').toBe(0);
    noCrash();
  });

  it('12. 重排絕對不呼叫 legacy 的全域 DELETE /plan-tasks', async () => {
    await openPreview();
    await click(screen.getByRole('button', { name: '套用新版安排' }));
    await flush();
    expect(calls.filter(([p]) => p.startsWith('/plan-tasks')).length).toBe(0);
    noCrash();
  });

  it('13. 別的計畫的任務完全不受影響', async () => {
    seedConditions(12); seedConditions(13);
    setApi({ '/tasks': [...PLAN_TASKS, OTHER_TASK], '/plans': [PLAN, OTHER_PLAN] });
    render(<Shell onLogout={() => {}} />);
    await screen.findByText('項待完成');
    await flush();
    await click(screen.getByRole('button', { name: '查看' }));
    await click(screen.getAllByRole('button', { name: '讓 AI 重新安排' })[0]);
    await click(screen.getByRole('button', { name: '重新安排' }));
    await flush();
    // 送去排程的內容只有這個計畫的
    const body = sent('/schedule/preview', 'POST')[0][1].body;
    expect(body.items.map(i => i.title)).not.toContain(OTHER_TASK.title);
    await click(screen.getByRole('button', { name: '套用新版安排' }));
    await flush();
    expect(calls.filter(([p]) => p === '/tasks/31').length, '別的計畫的任務不該被碰').toBe(0);
    noCrash();
  });

  it('14. 已完成的任務不會被送去重排，也不會被修改', async () => {
    await openPreview();
    const body = sent('/schedule/preview', 'POST')[0][1].body;
    expect(body.items.map(i => i.title)).not.toContain(DONE.title);
    await click(screen.getByRole('button', { name: '套用新版安排' }));
    await flush();
    expect(calls.filter(([p]) => p === `/tasks/${DONE.id}`).length).toBe(0);
    noCrash();
  });

  // 重排＝把東西搬到新的日子，永遠不是刪東西。
  // AI 排不進去的項目必須留在原地，不能因為「這次結果裡沒有它」就被清掉。
  it('排不進去的項目留在原地，不會被刪掉', async () => {
    // 結果裡只剩一項，另一項（22）沒排進去
    await mountShell({ '/schedule/preview': Promise.resolve({ ...REPLAN, blocks: [REPLAN.blocks[0]] }) });
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    await click(screen.getByRole('button', { name: '重新安排' }));
    await flush();
    await click(screen.getByRole('button', { name: '套用新版安排' }));
    await flush();
    expect(calls.filter(([p, o]) => p.startsWith('/tasks/') && o?.method === 'DELETE'), '重排不得刪任務').toEqual([]);
    expect(calls.filter(([p]) => p === '/tasks/22').length, '沒排到的任務應該原封不動').toBe(0);
    noCrash();
  });

  // 重排不該順手改掉使用者自己設的起訖日與計畫名稱
  it('重排不會改到計畫本身的起訖日或名稱', async () => {
    await openPreview();
    await click(screen.getByRole('button', { name: '套用新版安排' }));
    await flush();
    expect(sent('/plans/12', 'PATCH'), '重排只搬任務，不動計畫欄位').toEqual([]);
    noCrash();
  });

  it('17. 預覽失敗時保留原排程，而且可以重試', async () => {
    seedConditions(12);
    setApi({
      '/tasks': [...PLAN_TASKS], '/plans': [PLAN],
      '/schedule/preview': () => Promise.reject(new Error('沒有可排的日期')),
    });
    render(<Shell onLogout={() => {}} />);
    await screen.findByText('項待完成');
    await flush();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    await click(screen.getByRole('button', { name: '重新安排' }));
    await flush();
    expect(within(sheet()).getByText('沒有可排的日期')).toBeInTheDocument();
    expect(writes().filter(([p]) => p !== '/schedule/preview'), '失敗不得留下任何寫入').toEqual([]);
    // 還留在確認畫面，可以再按一次
    expect(screen.getByRole('button', { name: '重新安排' })).toBeEnabled();
    noCrash();
  });
});

// 重排＝用「原本的排法」重算剩下的內容。
// 如果 Today 自己補一組預設值（60 分鐘／平均分配／一天 3 項），
// 學生在精靈裡設定的排法就會被悄悄換掉——測試全綠也看不出來，所以這裡直接守住。
describe('重排必須沿用原計畫的排程條件', () => {
  const previewBody = () => sent('/schedule/preview', 'POST')[0][1].body;
  const openPreview = async (over = {}, cond = {}) => {
    seedConditions(12, cond);
    setApi({ '/tasks': [...PLAN_TASKS], '/plans': [PLAN], ...over });
    render(<Shell onLogout={() => {}} />);
    await screen.findByText('項待完成');
    await flush();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    await click(screen.getByRole('button', { name: '重新安排' }));
    await flush();
  };

  it('不會把 pace 寫死成 even', async () => {
    await openPreview();
    expect(previewBody().pace).toBe('front');
  });

  it('不會把每天數量寫死成 3', async () => {
    await openPreview();
    expect(previewBody().perDay).toBe(2);
  });

  it('不會把每一項的時長寫死成 60 分鐘', async () => {
    // 只排進度的計畫：排程器根本不看 minutes，就不該生一個假數字
    await openPreview();
    for (const it of previewBody().items) expect(it.minutes).toBeUndefined();
  });

  it('時間模式的時長從任務自己的時段還原，不是 60', async () => {
    const timedTasks = PLAN_TASKS.map(t => t.completed ? t
      : { ...t, due_time: '08:00', notes: '讀書時段 08:00–09:30' });
    await openPreview({ '/tasks': timedTasks }, { timed: true, perDay: 4 });
    const mins = previewBody().items.map(i => i.minutes);
    expect(mins).toEqual([90, 90]);
    expect(previewBody().timed).toBe(true);
  });

  it('有保存的排程條件會原樣帶進 preview', async () => {
    await openPreview();
    const b = previewBody();
    expect(b.timed).toBe(false);
    expect(b.excludeWeekdays).toEqual([0]);
    expect(b.excludeDates).toEqual([iso(5)]);
    expect(b.skipIfBusyHours).toBe(4);
  });

  it('找不到原本的排法時不會偷偷用預設值，而是請使用者先確認', async () => {
    // 沒有這個計畫的條件
    await mountShell({}, { seed: false });
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    expect(screen.getByText('需要先確認安排條件')).toBeInTheDocument();
    // 不給「直接排下去」這個選項，也絕對不能已經打了 preview
    expect(screen.queryByRole('button', { name: '重新安排' })).not.toBeInTheDocument();
    expect(sent('/schedule/preview', 'POST').length, '條件不齊時不得擅自排程').toBe(0);
    noCrash();
  });

  it('確認安排條件會進到既有的 Edit Mode，不另做一套設定頁', async () => {
    await mountShell({}, { seed: false });
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    await click(screen.getByRole('button', { name: '確認安排條件' }));
    await flush();
    expect(screen.getByRole('heading', { name: '調整「第二次段考」' })).toBeInTheDocument();
    noCrash();
  });

  it('時間模式但任務沒有時段可還原時，同樣要求先確認', async () => {
    // timed=true，但任務身上沒有「讀書時段」可以還原時長
    await mountShell({}, { seed: false });
    seedConditions(12, { timed: true });
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    expect(screen.getByText('需要先確認安排條件')).toBeInTheDocument();
    expect(screen.getByText(/每一項大約要花多久/)).toBeInTheDocument();
    noCrash();
  });
});

describe('排不下時的解法入口（deep-link 進既有 Edit Mode）', () => {
  const UNPLACED = { ...REPLAN, unplaced: true, message: '空檔不足，有 2 項排不進去' };
  const openUnplaced = async () => {
    await mountShell({ '/schedule/preview': Promise.resolve(UNPLACED) });
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    await click(screen.getByRole('button', { name: '重新安排' }));
    await flush();
  };

  it('排不下時說明原因，不是只丟一句「排程失敗」', async () => {
    await openUnplaced();
    expect(screen.getByText('目前無法完整安排')).toBeInTheDocument();
    expect(screen.getByText('空檔不足，有 2 項排不進去')).toBeInTheDocument();
    noCrash();
  });

  it('18. 「延後期限」進到既有 Edit Mode 的完成期限', async () => {
    await openUnplaced();
    await click(screen.getByRole('button', { name: '延後期限' }));
    await flush();
    expect(screen.getByRole('heading', { name: '調整「第二次段考」' })).toBeInTheDocument();
    expect(screen.getByText('步驟 2／3：怎麼安排')).toBeInTheDocument();
    expect(screen.getByText('完成期限').closest('details')).toHaveAttribute('open');
    noCrash();
  });

  it('19. 「調整可用時間」進到可用時間那一段', async () => {
    await openUnplaced();
    await click(screen.getByRole('button', { name: '調整可用時間' }));
    await flush();
    expect(screen.getByText('步驟 2／3：怎麼安排')).toBeInTheDocument();
    expect(screen.getByText('可用時間').closest('details')).toHaveAttribute('open');
    noCrash();
  });

  it('20. 「減少學習內容」進到第 1 步「讀什麼」', async () => {
    await openUnplaced();
    await click(screen.getByRole('button', { name: '減少學習內容' }));
    await flush();
    expect(screen.getByText('步驟 1／3：讀什麼')).toBeInTheDocument();
    noCrash();
  });

  it('「修改條件」也走同一條路，不另開一套設定頁', async () => {
    await mountShell();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    await click(screen.getByRole('button', { name: '修改條件' }));
    await flush();
    expect(screen.getByRole('heading', { name: '調整「第二次段考」' })).toBeInTheDocument();
    noCrash();
  });
});

// 建立、調整、重排三個入口共用同一支 builder；有兩套 mapping 就會出現
// 「同一個計畫在不同入口被用不同語意排一次」這種很難查的問題。
describe('preview request 只有一套 mapping', () => {
  const items = [{ subject_id: 1, title: 'A' }];
  const base = { items, startDate: '2026-01-01', endDate: '2026-01-10' };

  it('時間模式一定有每日上限', () => {
    const b = buildSchedulePreviewRequest({ ...base, conditions: { timed: true, perDay: 4, pace: 'even' } });
    expect(b.timed).toBe(true);
    expect(b.perDay).toBe(4);
  });

  it('只排進度且沒限制數量時，perDay=0（不限）', () => {
    const b = buildSchedulePreviewRequest({ ...base, conditions: { timed: false, limitPerDay: false, perDay: 5, pace: 'even' } });
    expect(b.perDay).toBe(0);
  });

  it('只排進度但有勾限制數量時，沿用使用者填的數字', () => {
    const b = buildSchedulePreviewRequest({ ...base, conditions: { timed: false, limitPerDay: true, perDay: 5, pace: 'front' } });
    expect(b.perDay).toBe(5);
    expect(b.pace).toBe('front');
  });

  it('沒帶作息調整就不送 sleep 欄位（用帳號本來的作息）', () => {
    const b = buildSchedulePreviewRequest({ ...base, conditions: { timed: true, perDay: 3, pace: 'even' } });
    expect('sleep_start' in b).toBe(false);
    const b2 = buildSchedulePreviewRequest({ ...base, conditions: { timed: true, perDay: 3, pace: 'even', sleep_start: '00:30', sleep_end: '07:00' } });
    expect(b2.sleep_start).toBe('00:30');
  });

  it('builder 不自己補預設值：沒給的條件不會憑空出現', () => {
    const b = buildSchedulePreviewRequest({ ...base, conditions: {} });
    expect(b.pace).toBeUndefined();
    expect(b.excludeWeekdays).toEqual([]);
  });

  it('從「讀書時段」還原時長', () => {
    expect(taskMinutes({ notes: '讀書時段 08:00–09:30' })).toBe(90);
    expect(taskMinutes({ notes: '' })).toBeNull();
    expect(taskMinutes({ notes: '讀書時段 09:00–08:00' })).toBeNull();
  });
});
