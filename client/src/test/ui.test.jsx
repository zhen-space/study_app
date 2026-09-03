// UI-R1：視覺重構的回歸網。
//
// 這一批只換視覺，所以這裡守的是「換皮之後功能沒有退化」：
// 五大導航、主要動作、Today 內容、Replan 入口、完成任務、
// BottomSheet 的鍵盤行為，以及 reduced-motion 下不會壞掉。
//
// 這些斷言刻意抓「使用者看得到／按得到的東西」，不抓 class name——
// 綁 class 的測試在視覺重構時只會逼人改測試，守不到任何東西。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;
const { saveConfirmedConditions } = await import('../tt/schedulePreview');

const iso = n => addDays(today(), n);
const PLAN = { ...fx.plans[0], id: 12, name: '第二次段考', start_date: iso(-5), target_date: iso(10) };
const OTHER_PLAN = { ...PLAN, id: 13, name: '暑假數學' };
const mk = (id, over = {}) => ({
  id, list_id: 1, plan_id: 12, plan_status: 'active', title: `任務${id}`, due_date: iso(1), due_time: null,
  priority: 0, completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null,
  deadline_date: null, order_index: id, deleted: 0, ...over,
});
const OVERDUE = mk(21, { title: '物理｜段考範圍｜力學複習', due_date: iso(-1) });
const TODAY_TASK = mk(22, { title: '英文｜模考第 2 回', due_date: iso(0) });

let calls;
const setApi = (over = {}) => {
  api.mockImplementation((raw, opts) => {
    calls.push([raw, opts]);
    const path = raw.startsWith('/plans?') ? '/plans' : raw;
    // 覆寫可以是值，也可以是函式——要驗錯誤路徑（例如 409）就需要後者。
    if (path in over) {
      const v = over[path];
      return typeof v === 'function' ? Promise.resolve(v(opts)) : Promise.resolve(v);
    }
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    if (path.endsWith('/attachments')) return Promise.resolve([]);
    if (path.startsWith('/plans/') || path.startsWith('/tasks/')) return Promise.resolve({ ok: true });
    return Promise.resolve([]);
  });
};

let errors;
beforeEach(() => {
  calls = []; errors = [];
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
const nav = () => document.querySelector('.bottom-nav');
const navButton = name => name === '讀書'
  ? within(nav()).getByLabelText('開始讀書')
  : within(nav()).getByText(name).closest('button');

async function mountShell(over = {}) {
  setApi({ '/tasks': [OVERDUE, TODAY_TASK], '/plans': [PLAN], ...over });
  const r = render(<Shell onLogout={() => {}} />);
  await screen.findByRole('heading', { name: '今天' });
  await flush();
  return r;
}

describe('UI-R1：視覺重構後功能沒有退化', () => {
  it('1. 五大導航都還在，而且都按得動', async () => {
    await mountShell();
    const labels = [...nav().querySelectorAll('button')].map(b => b.textContent.trim());
    expect(labels).toEqual(['今天', '計畫', '讀書', '任務', '行事曆']);
    for (const n of ['計畫', '讀書', '任務', '行事曆', '今天']) {
      await click(navButton(n));
      noCrash();
    }
  });

  it('2. 中央「讀書」仍是主要動作，而且進得了 Study', async () => {
    await mountShell();
    const b = navButton('讀書');
    expect(b.className).toContain('primary');
    expect(b.querySelector('.primary-fab')).toBeTruthy();
    await click(b);
    expect(screen.getByRole('heading', { name: '讀書' })).toBeInTheDocument();
    noCrash();
  });

  it('3. Today 有大標題與日期副標，內容照順序出現', async () => {
    await mountShell();
    expect(screen.getByRole('heading', { name: '今天' })).toBeInTheDocument();
    // 日期副標（月／日不補零，跟畫面一致）
    const d = new Date(today() + 'T00:00:00');
    expect(screen.getByText(new RegExp(`${d.getMonth() + 1} 月 ${d.getDate()} 日`))).toBeInTheDocument();
    expect(within(document.querySelector('.main')).getByText('已完成')).toBeInTheDocument();
    expect(within(document.querySelector('.main')).getByRole('button', { name: /開始讀書/ })).toBeInTheDocument();
    noCrash();
  });

  it('4. 進度條有 aria 資訊，不是只有一條顏色', async () => {
    await mountShell();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemax', '1');   // 今天只有 TODAY_TASK 一項
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    noCrash();
  });

  it('5. 「計畫需要調整」的 CTA 仍然開既有的 Replan 流程', async () => {
    saveConfirmedConditions(12, { timed: false, perDay: 2, pace: 'front' });
    await mountShell();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    expect(screen.getByText('重新安排「第二次段考」')).toBeInTheDocument();
    noCrash();
  });

  it('6. 多個計畫仍然只顯示摘要，不是堆一排卡片', async () => {
    await mountShell({
      '/tasks': [OVERDUE, mk(31, { id: 31, plan_id: 13, due_date: iso(-1) })],
      '/plans': [PLAN, OTHER_PLAN],
    });
    expect(screen.getByText('2 個計畫需要調整')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '讓 AI 重新安排' })).not.toBeInTheDocument();
    await click(screen.getByRole('button', { name: '查看' }));
    expect(screen.getAllByRole('button', { name: '讓 AI 重新安排' }).length).toBe(2);
    noCrash();
  });

  it('7. 勾完成仍然走既有的 PATCH，沒有因為換樣式而失效', async () => {
    await mountShell();
    const row = screen.getByText('英文｜模考第 2 回').closest('.trow');
    await click(row.querySelector('input[type=checkbox]'));
    await flush();
    const patch = calls.find(([p, o]) => p === '/tasks/22' && o?.method === 'PATCH');
    expect(patch, '完成任務應該送出 PATCH').toBeTruthy();
    expect(patch[1].body.completed).toBe(true);
    noCrash();
  });

  it('8. BottomSheet：Escape 關得掉，而且有 dialog 語意', async () => {
    saveConfirmedConditions(12, { timed: false, perDay: 2, pace: 'front' });
    await mountShell();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    noCrash();
  });

  it('9. BottomSheet：點背景關得掉，點面板內部不會誤關', async () => {
    saveConfirmedConditions(12, { timed: false, perDay: 2, pace: 'front' });
    await mountShell();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    await click(screen.getByRole('dialog'));                    // 面板內部
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await click(document.querySelector('.sheet-backdrop'));      // 背景
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    noCrash();
  });

  it('10. 只有圖示的按鈕都有名字（螢幕閱讀器看得懂）', async () => {
    await mountShell();
    const unnamed = [...document.querySelectorAll('.ui-iconbtn')]
      .filter(b => !b.getAttribute('aria-label') && !b.textContent.trim());
    expect(unnamed.map(b => b.outerHTML)).toEqual([]);
    noCrash();
  });

  it('11. prefers-reduced-motion 之下畫面照樣正常', async () => {
    window.matchMedia = q => ({
      matches: /prefers-reduced-motion/.test(q), media: q,
      addEventListener() {}, removeEventListener() {},
    });
    saveConfirmedConditions(12, { timed: false, perDay: 2, pace: 'front' });
    await mountShell();
    await click(screen.getByRole('button', { name: '讓 AI 重新安排' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await click(navButton('計畫'));
    expect(screen.getByRole('heading', { name: '計畫' })).toBeInTheDocument();
    noCrash();
  });
});

// ============================================================
// UI-R2：Plans / PlanDetail 換成 Design System v1 之後，
// 互動與資訊層級沒有退化。
// ============================================================
describe('UI-R2：Plans 與 Plan Detail', () => {
  const goPlans = async () => {
    await click(navButton('計畫'));
    await flush();
  };
  const cardByName = name => [...document.querySelectorAll('.main .plan-card')]
    .find(el => el.querySelector('b')?.textContent === name);
  const panel = () => document.querySelector('.sheet-panel');

  it('12. 首頁只放進行中的卡片，其餘收成一行', async () => {
    await mountShell({ '/plans': [PLAN, { ...PLAN, id: 14, name: '第一次段考', status: 'completed' }] });
    await goPlans();
    // 進行中直接是卡片，已完成的不在首頁展開
    expect(cardByName('第二次段考')).toBeTruthy();
    expect(cardByName('第一次段考')).toBeFalsy();
    // 次要區塊是低權重的一行，不是一堆展開的卡
    const rows = [...document.querySelectorAll('.plan-section-row')].map(r => r.textContent);
    expect(rows.length).toBeGreaterThan(0);
    noCrash();
  });

  it('13. 建立計畫走 BottomSheet，AI 是主要動作', async () => {
    await mountShell();
    await goPlans();
    await click(screen.getByRole('button', { name: '建立計畫' }));
    const dlg = screen.getByRole('dialog');
    const ai = within(dlg).getByRole('button', { name: /AI 幫我安排/ });
    expect(ai.className).toContain('ui-btn--primary');
    // 空白計畫是次要入口（ListRow，不是同等份量的實心鈕）
    expect(within(dlg).getByText('建立空白計畫').closest('.ui-row')).toBeTruthy();
    noCrash();
  });

  it('14. 沒有任何計畫時給 EmptyState，而不是一行灰字', async () => {
    await mountShell({ '/tasks': [], '/plans': [] });
    await goPlans();
    expect(screen.getByText('還沒有計畫')).toBeInTheDocument();
    expect(screen.getByText(/讓 AI 幫你把內容安排到每天/)).toBeInTheDocument();
    expect(within(document.querySelector('.ui-empty')).getByRole('button', { name: '建立計畫' })).toBeInTheDocument();
    noCrash();
  });

  it('15. Plan Detail：進度是主角，管理收在右上', async () => {
    await mountShell();
    await goPlans();
    await click(cardByName('第二次段考'));
    expect(within(document.querySelector('.main')).getByRole('heading', { name: '第二次段考' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '計畫選項' })).toBeInTheDocument();
    // 舊版那一排 tile／btn 已經不在
    expect(document.querySelectorAll('.main .tile').length).toBe(0);
    noCrash();
  });

  it('16. 完成計畫的確認不再用 window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    await mountShell({
      '/plans/12/complete': () => {
        const e = new Error('仍有未完成任務');
        e.status = 409;
        e.payload = { error: '仍有未完成任務', code: 'unresolved_tasks', unresolved: [{ id: 1 }] };
        return Promise.reject(e);
      },
    });
    await goPlans();
    await click(cardByName('第二次段考'));
    await click(screen.getByRole('button', { name: '計畫選項' }));
    await click(within(panel()).getByText('標記完成').closest('.ui-row'));
    await flush();
    expect(screen.getByText('尚有未完成任務，不能標記為完成')).toBeInTheDocument();
    expect(confirmSpy, '★ 不得再用瀏覽器原生 confirm').not.toHaveBeenCalled();
    noCrash();
  });

  it('17. 新增任務走 BottomSheet，成功後留在明細', async () => {
    await mountShell();
    await goPlans();
    await click(cardByName('第二次段考'));
    await click(screen.getByRole('button', { name: /新增任務/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('任務名稱')).toBeInTheDocument();
    await click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(document.querySelector('.main')).getByRole('heading', { name: '第二次段考' })).toBeInTheDocument();
    noCrash();
  });

  it('18. 調整計畫的 deep-link 沒有退化', async () => {
    saveConfirmedConditions(12, { timed: false, perDay: 2, pace: 'front' });
    await mountShell();
    await goPlans();
    await click(cardByName('第二次段考'));
    await click(screen.getByRole('button', { name: /調整計畫/ }));
    await click(within(panel()).getByText('排程條件').closest('.ui-row'));
    await flush();
    expect(screen.getByRole('heading', { name: '調整「第二次段考」' })).toBeInTheDocument();
    noCrash();
  });

  it('19. 尚未安排是獨立區塊，不是塞在任務列上的小標籤', async () => {
    await mountShell({ '/tasks': [OVERDUE, { ...mk(23), due_date: null, title: '物理｜講義｜還沒排的' }] });
    await goPlans();
    await click(cardByName('第二次段考'));
    const sec = [...document.querySelectorAll('.ui-section')]
      .find(s => s.querySelector('.ui-section-title')?.textContent.includes('尚未安排'));
    expect(sec, '應該有獨立的「尚未安排」區塊').toBeTruthy();
    expect(within(sec).getByText('還沒排的')).toBeInTheDocument();
    noCrash();
  });

  it('20. Plans 與 Plan Detail 都不再使用舊的 .btn / .chip 堆疊', async () => {
    await mountShell();
    await goPlans();
    const main = document.querySelector('.main');
    expect(main.querySelectorAll('.btn').length, 'Plans 應已完成 primitives 遷移').toBe(0);
    await click(cardByName('第二次段考'));
    expect(document.querySelector('.main').querySelectorAll('.btn').length,
      'Plan Detail 應已完成 primitives 遷移').toBe(0);
    noCrash();
  });
});
