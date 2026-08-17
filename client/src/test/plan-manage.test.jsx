// Phase 2B-UI-1：正式 Plans 管理 UI 的互動測試。
//
// 這裡守的是「畫面真的打對 API、而且不會把 legacy 當成正式 Plan」：
//   - 建立空白計畫走 POST /plans，建完進明細
//   - 改名／改期限走 PATCH /plans/:id
//   - 完成／封存／恢復走各自的語意化端點
//   - 跨科計畫要顯示得出多科
//   - 「在計畫裡」不等於「已排到日期」→ 尚未安排要看得見
//   - legacy 計畫不能出現正式管理操作
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;

// 記下所有打出去的請求，測試才驗得到「有沒有走對 API」
let calls;
const setApi = (over = {}) => {
  api.mockImplementation((raw, opts) => {
    calls.push([raw, opts]);
    const path = raw.startsWith('/plans?') ? '/plans' : raw;
    if (path in over) {
      const v = over[path];
      return Promise.resolve(typeof v === 'function' ? v(opts) : v);
    }
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    if (path.endsWith('/attachments')) return Promise.resolve([]);
    if (path.startsWith('/plans/')) return Promise.resolve({});
    if (path.startsWith('/tasks/')) return Promise.resolve({});
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

const main = () => document.querySelector('.main');
const bottomNav = () => document.querySelector('.bottom-nav');
const click = el => act(async () => { el.click(); });
const type = (el, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const select = (el, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
// React 的 onBlur 實際上掛在會冒泡的 focusout 上，dispatch 'blur' 不會觸發
const blur = el => act(async () => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });

// 卡片標題在 <b> 裡；名稱可能同時是科目名，所以不能用純文字找
const cardTitles = () => [...main().querySelectorAll('.tile b')].map(b => b.textContent);
const cardByName = name => [...main().querySelectorAll('.tile')].find(el => el.querySelector('b')?.textContent === name);

async function goPlans(ready = '買參考書') {
  render(<Shell onLogout={() => {}} />);
  await screen.findByText('項待完成');
  if (ready) await screen.findByText(ready);
  await click(within(bottomNav()).getByText('計畫').closest('button'));
}
// 打開某個正式計畫的明細，並展開「管理」
async function openManage(planName) {
  await click(cardByName(planName));
  await click(screen.getByRole('button', { name: /管理/ }));
}
const sent = (method, pathPart) =>
  calls.filter(([p, o]) => p.includes(pathPart) && (o?.method || 'GET') === method);

describe('建立計畫', () => {
  it('「建立計畫」提供 AI 安排與空白計畫兩條路', async () => {
    await goPlans();
    await click(screen.getByRole('button', { name: /建立計畫/ }));
    expect(screen.getByRole('button', { name: /AI 幫我安排/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /建立空白計畫/ })).toBeInTheDocument();
    noCrash();
  });

  it('AI 安排接到既有排程精靈', async () => {
    await goPlans();
    await click(screen.getByRole('button', { name: /建立計畫/ }));
    await click(screen.getByRole('button', { name: /AI 幫我安排/ }));
    expect(screen.getByText('排程精靈')).toBeInTheDocument();
    noCrash();
  });

  it('建立空白計畫：走 POST /plans，建完直接進明細', async () => {
    let created = null;
    setApi({
      '/plans': opts => {
        if (opts?.method === 'POST') { created = { ...fx.emptyPlan, name: opts.body.name }; return created; }
        return created ? [...fx.plans, created] : fx.plans;
      },
      '/tasks': [...fx.tasks, ...fx.planTasks],
    });
    await goPlans();
    await click(screen.getByRole('button', { name: /建立計畫/ }));
    await click(screen.getByRole('button', { name: /建立空白計畫/ }));
    await type(screen.getByPlaceholderText(/第二次段考準備/), '暑假數學講義');
    await click(screen.getByRole('button', { name: '建立' }));

    const posts = sent('POST', '/plans');
    expect(posts.length).toBe(1);
    expect(posts[0][1].body.name).toBe('暑假數學講義');
    // 建完應該已經在明細頁
    expect(within(main()).getByRole('heading', { name: '暑假數學講義' })).toBeInTheDocument();
    noCrash();
  });

  it('空白計畫（沒有任何任務）render 不 crash，並說明是空的', async () => {
    setApi({ '/plans': [fx.emptyPlan], '/tasks': fx.tasks });
    await goPlans();
    await click(cardByName('新的計畫'));
    expect(within(main()).getByRole('heading', { name: '新的計畫' })).toBeInTheDocument();
    expect(screen.getByText(/這個計畫還沒有任務/)).toBeInTheDocument();
    noCrash();
  });
});

describe('Plan 管理操作（全部走既有 /plans API）', () => {
  const withPlan = (over = {}) => setApi({
    '/plans': [fx.plans[0]], '/tasks': [...fx.tasks, ...fx.planTasks], ...over,
  });

  it('改名 → PATCH /plans/:id', async () => {
    withPlan();
    await goPlans();
    await openManage('第二次段考準備');
    const input = screen.getByLabelText('計畫名稱');
    await type(input, '第二次段考衝刺');
    await blur(input);
    const patches = sent('PATCH', '/plans/12');
    expect(patches.length).toBe(1);
    expect(patches[0][1].body).toEqual({ name: '第二次段考衝刺' });
    noCrash();
  });

  it('名稱沒改就不送出（避免無意義的版本異動）', async () => {
    withPlan();
    await goPlans();
    await openManage('第二次段考準備');
    await blur(screen.getByLabelText('計畫名稱'));
    expect(sent('PATCH', '/plans/12').length).toBe(0);
    noCrash();
  });

  it('修改期限 → PATCH /plans/:id 帶 target_date', async () => {
    withPlan();
    await goPlans();
    await openManage('第二次段考準備');
    const input = screen.getByLabelText('目標日期');
    await type(input, '2026-12-31');
    const patches = sent('PATCH', '/plans/12');
    expect(patches.length).toBe(1);
    expect(patches[0][1].body).toEqual({ target_date: '2026-12-31' });
    noCrash();
  });

  it('標記完成 → POST /plans/:id/complete；有未完成項目會先確認', async () => {
    withPlan({ '/plans/12/complete': { needs_confirm: true, unresolved: [{ id: 21 }, { id: 22 }] } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await goPlans();
    await openManage('第二次段考準備');
    await click(screen.getByRole('button', { name: '標記完成' }));

    const posts = sent('POST', '/plans/12/complete');
    expect(posts.length).toBe(2);                    // 先問，再帶 force
    expect(posts[1][1].body).toEqual({ force: true });
    expect(window.confirm).toHaveBeenCalled();
    noCrash();
  });

  it('確認視窗按取消，就不會真的完成', async () => {
    withPlan({ '/plans/12/complete': { needs_confirm: true, unresolved: [{ id: 21 }] } });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await goPlans();
    await openManage('第二次段考準備');
    await click(screen.getByRole('button', { name: '標記完成' }));
    const posts = sent('POST', '/plans/12/complete');
    expect(posts.length).toBe(1);                    // 只問了，沒有 force
    noCrash();
  });

  it('封存 → POST /plans/:id/archive，並說明不會刪任務', async () => {
    withPlan();
    await goPlans();
    await openManage('第二次段考準備');
    expect(screen.getByText(/封存不會刪掉任何任務/)).toBeInTheDocument();
    await click(screen.getByRole('button', { name: '封存' }));
    expect(sent('POST', '/plans/12/archive').length).toBe(1);
    noCrash();
  });

  it('已封存的計畫顯示「恢復」→ POST /plans/:id/restore', async () => {
    setApi({ '/plans': [fx.archivedPlan], '/tasks': fx.tasks });
    await goPlans();
    await click(screen.getByRole('button', { name: /顯示已封存/ }));
    await openManage('封存過的計畫');
    expect(screen.queryByRole('button', { name: '封存' })).not.toBeInTheDocument();
    await click(screen.getByRole('button', { name: '恢復' }));
    expect(sent('POST', '/plans/31/restore').length).toBe(1);
    noCrash();
  });

  it('已完成的計畫不再提供「標記完成」', async () => {
    setApi({ '/plans': [fx.completedPlan], '/tasks': fx.tasks });
    await goPlans();
    await openManage('做完的計畫');
    expect(screen.queryByRole('button', { name: '標記完成' })).not.toBeInTheDocument();
    noCrash();
  });
});

describe('狀態分組', () => {
  it('進行中／已完成分開，已封存預設收起來', async () => {
    setApi({ '/plans': [fx.plans[0], fx.completedPlan, fx.archivedPlan], '/tasks': [...fx.tasks, ...fx.planTasks] });
    await goPlans();
    // 「已完成」在側邊欄和卡片狀態標籤上也會出現，所以只看區塊標題
    const sections = [...main().querySelectorAll('.side-sec')].map(x => x.textContent);
    expect(sections).toContain('進行中');
    expect(sections).toContain('已完成');
    expect(cardTitles()).not.toContain('封存過的計畫');       // 預設不顯示
    await click(screen.getByRole('button', { name: /顯示已封存/ }));
    expect(cardTitles()).toContain('封存過的計畫');
    noCrash();
  });
});

describe('跨科計畫', () => {
  it('卡片顯示多個科目（primary_list_id 只是提示，不代表身分）', async () => {
    setApi({ '/plans': [fx.plans[0]], '/tasks': [...fx.tasks, ...fx.planTasks] });
    await goPlans();
    const card = cardByName('第二次段考準備');
    expect(within(card).getByText('物理')).toBeInTheDocument();
    expect(within(card).getByText('地科')).toBeInTheDocument();
    noCrash();
  });

  it('明細依科目分組，兩科的任務都在同一個計畫底下', async () => {
    setApi({ '/plans': [fx.plans[0]], '/tasks': [...fx.tasks, ...fx.planTasks] });
    await goPlans();
    await click(cardByName('第二次段考準備'));
    const labels = [...main().querySelectorAll('.glabel')].map(x => x.textContent);
    expect(labels.some(l => l.includes('物理'))).toBe(true);
    expect(labels.some(l => l.includes('地科'))).toBe(true);
    expect(within(main()).getByText(/力學複習/)).toBeInTheDocument();
    expect(within(main()).getByText(/大氣複習/)).toBeInTheDocument();
    noCrash();
  });
});

describe('尚未安排', () => {
  it('卡片會標出尚未安排的數量', async () => {
    setApi({ '/plans': [fx.plans[0]], '/tasks': [...fx.tasks, ...fx.planTasks] });
    await goPlans();
    expect(within(cardByName('第二次段考準備')).getByText(/尚未安排 1 項/)).toBeInTheDocument();
    noCrash();
  });

  it('明細有獨立的「尚未安排」區塊，沒有日期的任務不會被當成已排好', async () => {
    setApi({ '/plans': [fx.plans[0]], '/tasks': [...fx.tasks, ...fx.planTasks] });
    await goPlans();
    await click(cardByName('第二次段考準備'));
    const group = [...main().querySelectorAll('.tgroup')]
      .find(g => g.querySelector('.glabel')?.textContent.includes('尚未安排'));
    expect(group, '應該有「尚未安排」分組').toBeTruthy();
    expect(within(group).getByText(/電磁複習/)).toBeInTheDocument();
    noCrash();
  });
});

describe('新增任務到計畫（空白計畫的閉環）', () => {
  // /tasks 會隨著新增而變，所以用函式回傳當下的清單。
  // 一定要回傳「副本」——回同一個陣列參照的話 setTasks 會被 React 判定沒變化，
  // 畫面不會重新渲染，測試就會看到過期的畫面（這是假資料的問題，不是產品的）
  const withLiveTasks = (plans, initial) => {
    let tasks = [...initial];
    setApi({
      '/plans': plans,
      '/tasks': opts => {
        if (opts?.method === 'POST') {
          const t = {
            id: 900 + tasks.length, list_id: opts.body.list_id ?? null, plan_id: opts.body.plan_id,
            title: opts.body.title, due_date: null, due_time: null, priority: 0, completed: 0,
            tags: [], subtasks: [], recurring: null, deadline_date: opts.body.deadline_date ?? null,
            order_index: 99, deleted: 0,
          };
          tasks.push(t);
          return t;
        }
        return [...tasks];
      },
    });
  };

  it('空白計畫顯示 empty state，並提供「新增任務」入口', async () => {
    setApi({ '/plans': [fx.emptyPlan], '/tasks': fx.tasks });
    await goPlans();
    await click(cardByName('新的計畫'));
    expect(screen.getByText(/這個計畫還沒有任務/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新增任務/ })).toBeInTheDocument();
    noCrash();
  });

  it('空白計畫可以新增第一個任務，request 帶正確的 plan_id', async () => {
    withLiveTasks([fx.emptyPlan], fx.tasks);
    await goPlans();
    await click(cardByName('新的計畫'));
    await click(screen.getByRole('button', { name: /新增任務/ }));
    await type(screen.getByLabelText('任務名稱'), '整理第一章筆記');
    await click(screen.getByRole('button', { name: '新增' }));

    const posts = sent('POST', '/tasks');
    expect(posts.length).toBe(1);
    expect(posts[0][1].body.title).toBe('整理第一章筆記');
    expect(posts[0][1].body.plan_id).toBe(fx.emptyPlan.id);   // ★ 不用使用者再選一次計畫
    noCrash();
  });

  it('新增成功後留在明細頁，任務立刻出現在「尚未安排」', async () => {
    withLiveTasks([fx.emptyPlan], fx.tasks);
    await goPlans();
    await click(cardByName('新的計畫'));
    await click(screen.getByRole('button', { name: /新增任務/ }));
    await type(screen.getByLabelText('任務名稱'), '整理第一章筆記');
    await click(screen.getByRole('button', { name: '新增' }));
    await screen.findByText('整理第一章筆記');          // 等 reload 把新任務帶回來

    // 還在同一個計畫的明細
    expect(within(main()).getByRole('heading', { name: '新的計畫' })).toBeInTheDocument();
    const group = [...main().querySelectorAll('.tgroup')]
      .find(g => g.querySelector('.glabel')?.textContent.includes('尚未安排'));
    expect(group, '新任務沒有日期，應該落在「尚未安排」').toBeTruthy();
    expect(within(group).getByText('整理第一章筆記')).toBeInTheDocument();
    expect(screen.queryByText(/這個計畫還沒有任務/)).not.toBeInTheDocument();
    noCrash();
  });

  it('可以帶科目與截止日；設了截止日仍然是「尚未安排」（截止日 ≠ 排定日期）', async () => {
    withLiveTasks([fx.emptyPlan], fx.tasks);
    await goPlans();
    await click(cardByName('新的計畫'));
    await click(screen.getByRole('button', { name: /新增任務/ }));
    await type(screen.getByLabelText('任務名稱'), '物理錯題訂正');
    await select(screen.getByLabelText('科目'), String(fx.lists[0].id));
    await type(screen.getByLabelText('截止日'), '2026-12-01');
    await click(screen.getByRole('button', { name: '新增' }));
    await screen.findByText('物理錯題訂正');

    const body = sent('POST', '/tasks')[0][1].body;
    expect(body.list_id).toBe(fx.lists[0].id);
    expect(body.deadline_date).toBe('2026-12-01');
    expect(body.due_date).toBeUndefined();          // 不會偷偷幫它排日期
    // 有截止日不代表已經排進行事曆，所以還是落在「尚未安排」
    const group = [...main().querySelectorAll('.tgroup')]
      .find(g => g.querySelector('.glabel')?.textContent.includes('尚未安排'));
    expect(within(group).getByText('物理錯題訂正')).toBeInTheDocument();
    noCrash();
  });

  it('已經有任務的計畫也還是能繼續新增', async () => {
    withLiveTasks([fx.plans[0]], [...fx.tasks, ...fx.planTasks]);
    await goPlans();
    await click(cardByName('第二次段考準備'));
    await click(screen.getByRole('button', { name: /新增任務/ }));
    await type(screen.getByLabelText('任務名稱'), '再加一項');
    await click(screen.getByRole('button', { name: '新增' }));
    await screen.findByText('再加一項');

    const posts = sent('POST', '/tasks');
    expect(posts.length).toBe(1);
    expect(posts[0][1].body.plan_id).toBe(12);
    noCrash();
  });

  it('已封存的計畫不提供新增任務（後端本來就會擋）', async () => {
    setApi({ '/plans': [fx.archivedPlan], '/tasks': fx.tasks });
    await goPlans();
    await click(screen.getByRole('button', { name: /顯示已封存/ }));
    await click(cardByName('封存過的計畫'));
    expect(screen.queryByRole('button', { name: /新增任務/ })).not.toBeInTheDocument();
    noCrash();
  });
});

describe('Legacy 計畫', () => {
  it('標示為舊資料，而且不 crash', async () => {
    setApi({ '/plans': [], '/tasks': fx.tasks });
    await goPlans();
    expect(screen.getAllByText('舊資料').length).toBeGreaterThan(0);
    noCrash();
  });

  it('明細不提供正式計畫才有的管理操作', async () => {
    setApi({ '/plans': [], '/tasks': fx.tasks });
    await goPlans();
    await click(cardByName('物理'));
    // 沒有「管理」入口，也就沒有改名／期限／完成／封存
    expect(screen.queryByRole('button', { name: /管理/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '標記完成' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '封存' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('計畫名稱')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新增任務/ }), 'legacy 不該有正式 Plan 的新增任務入口').not.toBeInTheDocument();
    expect(screen.getByText(/不能改名、改期限或封存/)).toBeInTheDocument();
    noCrash();
  });

  it('對 legacy 計畫完全不會打 /plans 的寫入 API', async () => {
    setApi({ '/plans': [], '/tasks': fx.tasks });
    await goPlans();
    await click(cardByName('物理'));
    expect(sent('PATCH', '/plans/')).toEqual([]);
    expect(sent('POST', '/plans')).toEqual([]);
    noCrash();
  });
});
