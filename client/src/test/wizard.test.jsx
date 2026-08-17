// Phase 2B-UI-2：排程精靈 Create / Edit Mode ＋ 三步驟 UX 的互動測試。
//
// 這裡守的是幾條「壞掉就會出事」的界線：
//   ・精靈只有三步，而且第 2 步用學生語言問，不把 timed 這種內部參數講出來
//   ・Edit Mode 絕對不 POST /plans（會多生一個計畫）
//   ・Edit Mode 絕對不呼叫 legacy DELETE /plan-tasks（那支是全域的）
//   ・Edit Mode 的預覽在按下「套用新版安排」之前不寫任何東西
//   ・任務身分要保住：還在的 PATCH、新增的 POST、拿掉的軟刪除、完成的一律不動
//
// 排程演算法本身不在這裡測（那是 server/test/schedule.test.mjs 的事），
// 這一輪只重排前端流程，演算法沒有改。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';
import { addDays, today } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const WizardView = (await import('../tt/WizardView')).default;
const PlanDetailView = (await import('../tt/PlanDetailView')).default;
const { reconcile } = await import('../tt/wizardApply');

let calls;
const setApi = (over = {}) => {
  api.mockImplementation((raw, opts) => {
    calls.push([raw, opts]);
    const path = raw.startsWith('/plans?') ? '/plans' : raw;
    if (path in over) {
      const v = over[path];
      return Promise.resolve(typeof v === 'function' ? v(opts) : v);
    }
    if (path === '/schedule/preview') return Promise.resolve(fx.preview);
    if (path === '/plans') return Promise.resolve({ id: 99 });
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
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
const btn = re => screen.getByRole('button', { name: re });
// 送出去的請求：[路徑, 方法]
const sent = (path, method) => calls.filter(([p, o]) => p === path && (o?.method || 'GET') === method);
const sentPrefix = (prefix, method) => calls.filter(([p, o]) => p.startsWith(prefix) && (o?.method || 'GET') === method);

async function mountWizard(props = {}) {
  const r = render(<WizardView lists={fx.lists} reload={() => Promise.resolve()}
    goTasks={() => {}} goCalendar={() => {}} {...props} />);
  await waitFor(() => expect(calls.some(([p]) => p === '/import/toc')).toBe(true));
  await flush();
  return r;
}
// 第 1 步勾一章 → 第 2 步 → 產生排程 → 第 3 步
async function toStep2() {
  await click(screen.getByText('單元1 力學').closest('.row').querySelector('input[type=checkbox]'));
  await click(btn(/下一步：怎麼安排/));
}
async function toResult() {
  await toStep2();
  await click(btn(/產生排程/));
  await flush();
}

describe('三步驟結構', () => {
  it('1. 精靈只有三步，一開始停在「讀什麼」', async () => {
    await mountWizard();
    expect(screen.getByText('步驟 1／3：讀什麼')).toBeInTheDocument();
    expect(document.querySelectorAll('.step-dot').length).toBe(3);
    noCrash();
  });

  it('2. 第 1 步是選讀什麼：課本目錄勾得到', async () => {
    await mountWizard();
    expect(screen.getByText('新大滿貫')).toBeInTheDocument();
    expect(screen.getByText('單元1 力學')).toBeInTheDocument();
    // 還沒勾任何東西時不能往下走
    expect(btn(/下一步：怎麼安排/)).toBeDisabled();
    noCrash();
  });

  it('3. 勾了內容才進得了第 2 步「怎麼安排」', async () => {
    await mountWizard();
    await toStep2();
    expect(screen.getByText('步驟 2／3：怎麼安排')).toBeInTheDocument();
    noCrash();
  });

  it('4. 第 2 步的主要選擇用學生語言，不出現 timed 這種內部字眼', async () => {
    await mountWizard();
    await toStep2();
    expect(screen.getByText(/只安排每天要做什麼/)).toBeInTheDocument();
    expect(screen.getByText(/安排到實際時間/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/timed/i);
    noCrash();
  });

  it('5. 選「只安排每天要做什麼」才會出現每天數量限制', async () => {
    await mountWizard();
    await toStep2();
    expect(screen.queryByText('限制每天數量')).not.toBeInTheDocument();
    await click(screen.getByText(/只安排每天要做什麼/).closest('label').querySelector('input'));
    expect(screen.getByText('限制每天數量')).toBeInTheDocument();
    noCrash();
  });

  it('6. 第 2 步分成可用時間／排程條件／完成期限三段', async () => {
    await mountWizard();
    await toStep2();
    for (const s of ['可用時間', '排程條件', '完成期限']) {
      expect(screen.getByText(s), `第 2 步應該有「${s}」`).toBeInTheDocument();
    }
    noCrash();
  });

  it('7. 「可用時間」沿用既有行事曆，精靈裡沒有第二套行程編輯', async () => {
    await mountWizard();
    await toStep2();
    expect(screen.getByRole('button', { name: /去行事曆調整/ })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('手動新增行程')).not.toBeInTheDocument();
    noCrash();
  });

  it('8. 產生排程後進入第 3 步「AI 排程結果」', async () => {
    await mountWizard();
    await toResult();
    expect(screen.getByText('步驟 3／3：AI 排程結果')).toBeInTheDocument();
    expect(sent('/schedule/preview', 'POST').length).toBe(1);
    noCrash();
  });
});

describe('第 3 步：排法與看法分開', () => {
  it('9. 結果頁一直看得到目前是哪一種安排', async () => {
    await mountWizard();
    await toResult();
    expect(screen.getByText('時間排程')).toBeInTheDocument();
  });

  it('10. 清單／日曆只是換看法，不會改變排法', async () => {
    await mountWizard();
    await toResult();
    await click(btn(/^日曆$/));
    expect(screen.getByText('時間排程'), '換看法不該把排法變掉').toBeInTheDocument();
    await click(btn(/^清單$/));
    expect(screen.getByText('時間排程')).toBeInTheDocument();
    // 換看法不該打任何 API
    expect(sent('/schedule/preview', 'POST').length).toBe(1);
    noCrash();
  });
});

describe('Create Mode', () => {
  it('11. 按下「加入待辦」才建立計畫並掛上任務', async () => {
    await mountWizard();
    await toResult();
    expect(sent('/plans', 'POST').length, '還沒按之前不該建立計畫').toBe(0);
    await click(btn(/加入待辦/));
    await flush();
    expect(sent('/plans', 'POST').length).toBe(1);
    const bulk = sent('/tasks/bulk', 'POST');
    expect(bulk.length).toBe(1);
    expect(bulk[0][1].body.tasks.length).toBe(fx.previewBlocks.length);
    expect(bulk[0][1].body.tasks[0].plan_id).toBe(99);
    noCrash();
  });
});

describe('PlanDetail 的「調整計畫」入口', () => {
  const mountDetail = (over = {}) => render(
    <PlanDetailView planKey="plan:12" tasks={[...fx.tasks, ...fx.planTasks]} lists={fx.lists}
      apiPlans={fx.plans} reload={() => {}} onBack={() => {}} goWizard={() => {}} {...over} />);

  it('12. 正式計畫有「調整計畫」，點了先出現底部選單', async () => {
    mountDetail({ adjustPlan: () => {} });
    await click(btn(/調整計畫/));
    expect(screen.getByText('要調整什麼？')).toBeInTheDocument();
    noCrash();
  });

  it('13. 底部選單列出各段入口，「鎖定內容」先做成之後才有的功能', async () => {
    mountDetail({ adjustPlan: () => {} });
    await click(btn(/調整計畫/));
    const sheet = document.querySelector('.ev-sheet');
    for (const s of ['學習內容', '完成期限', '可用時間', '排程條件', '全部設定']) {
      expect(within(sheet).getByText(s)).toBeInTheDocument();
    }
    expect(within(sheet).getByText('鎖定內容').closest('button')).toBeDisabled();
    noCrash();
  });

  it('14. 選一段就帶著 planId 與該段進精靈', async () => {
    const adjustPlan = vi.fn();
    mountDetail({ adjustPlan });
    await click(btn(/調整計畫/));
    await click(within(document.querySelector('.ev-sheet')).getByText('排程條件').closest('button'));
    expect(adjustPlan).toHaveBeenCalledWith(12, 'cond');
    noCrash();
  });

  it('15. 舊資料沒有「調整計畫」（沒有 plan id，改不動）', async () => {
    render(<PlanDetailView planKey="legacy:1" tasks={fx.tasks} lists={fx.lists} apiPlans={[]}
      reload={() => {}} onBack={() => {}} goWizard={() => {}} adjustPlan={() => {}} />);
    expect(screen.queryByRole('button', { name: /調整計畫/ })).not.toBeInTheDocument();
    noCrash();
  });
});

describe('Edit Mode', () => {
  const doneTask = { id: 24, list_id: 1, plan_id: 12, title: '物理｜段考範圍｜已經讀完的', due_date: addDays(today(), -2),
    due_time: null, priority: 0, completed: 1, tags: ['讀書計劃'], subtasks: [], recurring: null, deadline_date: null, deleted: 0 };
  const editTasks = [...fx.planTasks, doneTask];
  // 一筆對得上既有任務（要沿用），一筆是新的（要新增）
  const editPreview = {
    check: null,
    blocks: [
      { subject_id: 1, title: '物理｜段考範圍｜力學複習', date: addDays(today(), 3), start_time: null, end_time: null, deadline: null },
      { subject_id: 1, title: '物理｜段考範圍｜全新的一章', date: addDays(today(), 4), start_time: null, end_time: null, deadline: null },
    ],
  };
  const mountEdit = (over = {}) => mountWizard({
    mode: 'edit', planId: 12, planTitle: '第二次段考準備', planTasks: editTasks,
    initialSection: 'cond', onDone: () => {}, ...over,
  });

  it('16. Edit Mode 一進來就標明在調整哪個計畫，而且直接落在指定的那一段', async () => {
    setApi({ '/schedule/preview': editPreview });
    await mountEdit();
    expect(screen.getByRole('heading', { name: '調整「第二次段考準備」' })).toBeInTheDocument();
    expect(screen.getByText('步驟 2／3：怎麼安排')).toBeInTheDocument();
    noCrash();
  });

  it('17. 產生預覽不會馬上改到計畫，要按「套用新版安排」', async () => {
    setApi({ '/schedule/preview': editPreview });
    await mountEdit();
    await click(btn(/產生排程/));
    await flush();
    expect(screen.getByText(/按下「套用新版安排」之前/)).toBeInTheDocument();
    // 預覽階段完全沒有寫入
    expect(sentPrefix('/tasks', 'POST').length).toBe(0);
    expect(sentPrefix('/tasks/', 'PATCH').length).toBe(0);
    expect(sentPrefix('/tasks/', 'DELETE').length).toBe(0);
    expect(sentPrefix('/plans', 'PATCH').length).toBe(0);
    noCrash();
  });

  it('18. 套用時保住任務身分：既有的 PATCH、新增的 POST、拿掉的軟刪除，完成的不動', async () => {
    setApi({ '/schedule/preview': editPreview });
    await mountEdit();
    await click(btn(/產生排程/));
    await flush();
    await click(btn(/套用新版安排/));
    await flush();

    // 既有的那筆沿用原本的 id，只改排定日期
    const patches = sentPrefix('/tasks/', 'PATCH');
    expect(patches.map(([p]) => p)).toEqual(['/tasks/21']);
    expect(patches[0][1].body.due_date).toBe(addDays(today(), 3));
    // 新的走 bulk，掛在同一個計畫底下
    const bulk = sent('/tasks/bulk', 'POST');
    expect(bulk.length).toBe(1);
    expect(bulk[0][1].body.tasks.map(t => t.title)).toEqual(['物理｜段考範圍｜全新的一章']);
    expect(bulk[0][1].body.tasks[0].plan_id).toBe(12);
    // 這次沒排到的未完成任務軟刪除；已完成的（24）絕對不能被碰
    const dels = sentPrefix('/tasks/', 'DELETE').map(([p]) => p).sort();
    expect(dels).toEqual(['/tasks/22', '/tasks/23']);
    expect(dels).not.toContain('/tasks/24');
    expect(patches.map(([p]) => p)).not.toContain('/tasks/24');
    noCrash();
  });

  it('19. Edit Mode 絕對不會 POST /plans 生出第二個計畫', async () => {
    setApi({ '/schedule/preview': editPreview });
    await mountEdit();
    await click(btn(/產生排程/));
    await flush();
    await click(btn(/套用新版安排/));
    await flush();
    expect(sent('/plans', 'POST').length, 'Edit Mode 不得建立新計畫').toBe(0);
    // 改的是這個計畫自己的起訖日
    expect(sent('/plans/12', 'PATCH').length).toBe(1);
    noCrash();
  });

  it('20. Edit Mode 絕對不呼叫 legacy 的全域 DELETE /plan-tasks', async () => {
    setApi({ '/schedule/preview': editPreview });
    await mountEdit();
    await click(btn(/產生排程/));
    await flush();
    await click(btn(/套用新版安排/));
    await flush();
    expect(sent('/plan-tasks', 'DELETE').length, '這支是全域端點，會掃到別的計畫').toBe(0);
    // 連讀都不該讀全域的 /plan-tasks
    expect(calls.filter(([p]) => p.startsWith('/plan-tasks')).length).toBe(0);
    noCrash();
  });

  it('21. 選「維持原本日期不動」時，這次沒排到的任務一筆都不刪', async () => {
    setApi({ '/schedule/preview': editPreview });
    await mountEdit();
    // 回第 1 步加一點內容，否則這次根本沒有東西可排
    await click(btn(/^上一步$/));
    await click(screen.getByText('單元1 力學').closest('.row').querySelector('input[type=checkbox]'));
    await click(btn(/下一步：怎麼安排/));
    await click(screen.getByText(/維持原本日期不動/).closest('label').querySelector('input'));
    await click(btn(/產生排程/));
    await flush();
    await click(btn(/套用新版安排/));
    await flush();
    expect(sentPrefix('/tasks/', 'DELETE').length).toBe(0);
    noCrash();
  });

  it('22. Edit Mode 的草稿分計畫存，不會蓋掉別的計畫', async () => {
    setApi({ '/schedule/preview': editPreview });
    await mountEdit();
    await flush();
    expect(localStorage.getItem('wizardDraft:plan:12')).toBeTruthy();
    expect(localStorage.getItem('wizardDraft'), 'Edit Mode 不該動到建立計畫用的草稿').toBeNull();
    noCrash();
  });
});

// 對應規則本身（不經過畫面）：身分比對是「同一個計畫底下的科目＋標題」，
// 不是全域的標題猜測——legacy 資料不適用這套（§5A 的閘門還沒解除）。
describe('reconcile 對應規則', () => {
  const t = (id, title, extra = {}) => ({ id, list_id: 1, title, completed: 0, deleted: 0, ...extra });

  it('23. 同科目同標題視為同一件事，沿用原本那筆', () => {
    const r = reconcile([{ subject_id: 1, title: 'A', date: '2026-01-01' }], [t(1, 'A')]);
    expect(r.update.map(u => u.task.id)).toEqual([1]);
    expect(r.create).toEqual([]);
    expect(r.remove).toEqual([]);
  });

  it('24. 不同科目撞名不會被誤認成同一件事', () => {
    const r = reconcile([{ subject_id: 2, title: 'A', date: '2026-01-01' }], [t(1, 'A')]);
    expect(r.update).toEqual([]);
    expect(r.create.length).toBe(1);
    expect(r.remove.map(x => x.id)).toEqual([1]);
  });

  it('25. 已完成與已刪除的任務完全不進對應池', () => {
    const r = reconcile([], [t(1, 'A', { completed: 1 }), t(2, 'B', { deleted: 1 })]);
    expect(r.remove).toEqual([]);
    expect(r.update).toEqual([]);
  });

  it('26. 標題重複時一對一配對，多出來的才算移除', () => {
    const r = reconcile([{ subject_id: 1, title: 'A' }], [t(1, 'A'), t(2, 'A')]);
    expect(r.update.map(u => u.task.id)).toEqual([1]);
    expect(r.remove.map(x => x.id)).toEqual([2]);
  });
});
