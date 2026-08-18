// Phase 2B-UI-2：排程精靈 Create / Edit Mode ＋ 三步驟 UX 的互動測試。
//
// 這裡守的是幾條「壞掉就會出事」的界線：
//   ・精靈只有三步，而且第 2 步用學生語言問，不把 timed 這種內部參數講出來
//   ・Edit Mode 絕對不 POST /plans（會多生一個計畫）
//   ・Edit Mode 絕對不呼叫 legacy DELETE /plan-tasks（那支是全域的）
//   ・Edit Mode 的預覽在按下「套用新版安排」之前不寫任何東西
//   ・任務身分要保住：全部交給 schedule/apply 的同一筆交易，完成的一律不動
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
const { reconcile, applyWizardSchedule } = await import('../tt/wizardApply');

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
    const apply = sent('/schedule/apply', 'POST');
    expect(apply).toHaveLength(1);
    expect(apply[0][1].body.plan_id).toBe(99);
    expect(apply[0][1].body.task_creates).toHaveLength(fx.previewBlocks.length);
    expect(apply[0][1].body.blocks).toHaveLength(fx.previewBlocks.length);
    noCrash();
  });
});

// legacy 的 DELETE /plan-tasks 是照「讀書計劃」標籤／標題全域刪的，
// 正式 Plan 的任務同樣帶那個標籤 —— 呼叫它等於刪別人的計畫。
// GET /plan-tasks 同樣沒有 scope（回傳裡連 plan_id 都沒有），所以連讀都不能用。
describe('legacy 全域端點已經完全退出新版 Wizard', () => {
  // 舊資料（沒有 plan_id）＋ 正式 Plan 的任務（plan_id=12，一樣帶「讀書計劃」標籤）
  const allTasks = [...fx.tasks, ...fx.planTasks];
  const legacyTitle = '物理｜新大滿貫｜單元2｜節1｜範例+例題';   // fx.tasks id=11，plan_id == null
  const planTaskTitle = '物理｜段考範圍｜力學複習';               // fx.planTasks id=21，plan_id=12
  // 排程結果包含那筆舊資料 → 它才有資格被軟刪除
  const createPreview = {
    check: null,
    blocks: [
      { subject_id: 1, title: legacyTitle, date: today(), start_time: null, end_time: null, deadline: null },
      { subject_id: 1, title: '單元1 力學｜範例+例題', date: addDays(today(), 1), start_time: null, end_time: null, deadline: null },
    ],
  };
  const run = async () => {
    setApi({ '/schedule/preview': createPreview });
    await mountWizard({ tasks: allTasks });
    await toResult();
    await click(btn(/加入待辦/));
    await flush();
  };

  it('27. Create Mode 永遠不碰 /plan-tasks（不刪，也不讀）', async () => {
    await run();
    expect(sent('/plan-tasks', 'DELETE').length, '這支會刪掉別的計畫的任務').toBe(0);
    expect(calls.filter(([p]) => p.startsWith('/plan-tasks')).length, '連讀都不該讀，它沒有 scope').toBe(0);
    noCrash();
  });

  it('28. 已有正式 Plan 的未完成任務，不會被拉進新計畫的排程', async () => {
    await run();
    const body = sent('/schedule/preview', 'POST')[0][1].body;
    expect(body.items.map(i => i.title)).not.toContain(planTaskTitle);
    noCrash();
  });

  it('29. 建立新計畫不會 DELETE 或 PATCH 別的計畫的任務', async () => {
    await run();
    const touched = calls
      .filter(([p, o]) => p.startsWith('/tasks/') && ['DELETE', 'PATCH'].includes(o?.method))
      .map(([p]) => p);
    for (const id of [21, 22, 23]) {
      expect(touched, `Plan 12 的任務 ${id} 不該被動到`).not.toContain(`/tasks/${id}`);
    }
    noCrash();
  });

  it('30. 只有「這次真的排進去的、plan_id == null 的」舊任務會被軟刪除', async () => {
    await run();
    const dels = calls.filter(([p, o]) => p.startsWith('/tasks/') && o?.method === 'DELETE').map(([p]) => p);
    // id=11 有排進這次結果 → 刪
    expect(dels).toContain('/tasks/11');
    // id=12、13、15 也是舊資料，但沒出現在排程結果裡 → 一律留著（重複比誤刪安全）
    for (const id of [12, 13, 15]) expect(dels).not.toContain(`/tasks/${id}`);
    noCrash();
  });

  it('31. 帶「讀書計劃」標籤但已屬於正式 Plan 的任務不受影響', async () => {
    await run();
    const planTask = fx.planTasks.find(t => t.id === 21);
    expect(planTask.tags).toContain('讀書計劃');   // 標籤條件會撈到它，所以才危險
    expect(calls.filter(([p]) => p === '/tasks/21').length, '完全不該被碰').toBe(0);
    noCrash();
  });

  it('32. 選「維持原本日期不動」時，舊任務一筆都不刪', async () => {
    setApi({ '/schedule/preview': createPreview });
    await mountWizard({ tasks: allTasks });
    await toStep2();
    await click(screen.getByText(/維持原本日期不動/).closest('label').querySelector('input'));
    await click(btn(/產生排程/));
    await flush();
    await click(btn(/加入待辦/));
    await flush();
    expect(calls.filter(([p, o]) => p.startsWith('/tasks/') && o?.method === 'DELETE').length).toBe(0);
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
    expect(screen.getByText('想調整什麼？')).toBeInTheDocument();
    noCrash();
  });

  it('13. 底部選單列出各段入口，排程鎖定可進入正式 Lock UI', async () => {
    const goLocks = vi.fn();
    mountDetail({ adjustPlan: () => {}, goLocks });
    await click(btn(/調整計畫/));
    const sheet = document.querySelector('.sheet-panel');
    for (const s of ['學習內容', '完成期限', '可用時間', '排程條件', '全部設定']) {
      expect(within(sheet).getByText(s)).toBeInTheDocument();
    }
    const lock = within(sheet).getByText('排程鎖定').closest('.ui-row');
    expect(lock).toBeTruthy();
    expect(lock.getAttribute('role')).toBe('button');
    await click(lock);
    expect(goLocks).toHaveBeenCalledOnce();
    noCrash();
  });

  it('14. 選一段就帶著 planId 與該段進精靈', async () => {
    const adjustPlan = vi.fn();
    mountDetail({ adjustPlan });
    await click(btn(/調整計畫/));
    await click(within(document.querySelector('.sheet-panel')).getByText('排程條件').closest('.ui-row'));
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

  it('18. 套用時保住任務身分：既有、新增、軟刪除都走同一個 schedule/apply，完成的不動', async () => {
    setApi({ '/schedule/preview': editPreview });
    await mountEdit();
    await click(btn(/產生排程/));
    await flush();
    await click(btn(/套用新版安排/));
    await flush();

    const apply = sent('/schedule/apply', 'POST');
    expect(apply).toHaveLength(1);
    const body = apply[0][1].body;
    expect(body.task_updates.map(t => t.task_id)).toEqual([21]);
    expect(body.task_creates.map(t => t.title)).toEqual(['物理｜段考範圍｜全新的一章']);
    expect(body.task_delete_ids).toEqual([22, 23]);
    expect(body.blocks.map(b => b.date)).toEqual([addDays(today(), 3), addDays(today(), 4)]);
    expect(body.blocks.some(b => b.task_id === 24)).toBe(false);
    expect(body.blocks.some(b => 'due_date' in b || 'due_time' in b)).toBe(false);
    expect(sentPrefix('/tasks/', 'PATCH')).toHaveLength(0);
    expect(sent('/tasks/bulk', 'POST')).toHaveLength(0);
    expect(sentPrefix('/tasks/', 'DELETE')).toHaveLength(0);
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

  // apply layer 是第二道防線：就算呼叫端把不該刪的東西傳進來，它也要擋下來。
  // （第一道是 Wizard 只把 legacy 任務放進 leftover）
  it('33. 就算把正式 Plan 的任務傳進 legacyMerged，apply layer 也不會刪它', async () => {
    await applyWizardSchedule({
      mode: 'create', name: '新計畫', blocks: [{ subject_id: 1, title: 'A', date: '2026-01-01' }],
      legacyMerged: [
        { id: 7, title: 'B', list_id: 1, plan_id: null, completed: 0 },   // 真的舊資料 → 刪
        { id: 8, title: 'C', list_id: 1, plan_id: 12, completed: 0 },     // 屬於別的計畫 → 不准刪
        { id: 9, title: 'D', list_id: 1, plan_id: null, completed: 1 },   // 已完成 → 不准刪
      ],
    });
    const dels = calls.filter(([p, o]) => p.startsWith('/tasks/') && o?.method === 'DELETE').map(([p]) => p);
    expect(dels).toEqual(['/tasks/7']);
  });

  it('26. 標題重複時一對一配對，多出來的才算移除', () => {
    const r = reconcile([{ subject_id: 1, title: 'A' }], [t(1, 'A'), t(2, 'A')]);
    expect(r.update.map(u => u.task.id)).toEqual([1]);
    expect(r.remove.map(x => x.id)).toEqual([2]);
  });
});
