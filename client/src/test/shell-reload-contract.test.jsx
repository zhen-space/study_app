// Shell.reload 的回傳契約。
//
// 舊版 /tasks 失敗被 `.catch(() => {})` 吞掉，reload 照樣 resolve——所有「寫入成功、
// 刷新失敗只重試刷新」的 recovery（任務完成、Global Add、學校作業…）都會誤判成已同步，
// 畫面停在舊資料卻不提示。這裡用真的 Shell＋真的 caller 鎖住：
//   ・/tasks 刷新失敗一定 reject，caller 看得到並能只重試刷新
//   ・/pet、/lists、/filters、/habits 這類可選資料失敗不影響結果
//   ・部分失敗時，其他成功的資料仍然套用
//   ・初次載入任何一支失敗都不炸畫面
//   ・寫入後一定要離開原畫面的 caller（建立計畫、新增科目）刷新失敗也不留下重送入口
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;
const WizardView = (await import('../tt/WizardView')).default;

let calls;
// over[path] 可以是值，或 (opts, n) => 值／Promise；n 是這支 GET 第幾次被呼叫（從 1 起算）
const setApi = (over = {}) => {
  const counts = {};
  api.mockImplementation((raw, opts) => {
    calls.push([raw, opts]);
    const path = raw.startsWith('/plans?') ? '/plans' : raw;
    const method = opts?.method || 'GET';
    if (method === 'GET') counts[path] = (counts[path] || 0) + 1;
    if (path in over) {
      const v = over[path];
      return Promise.resolve(typeof v === 'function' ? v(opts, counts[path]) : v);
    }
    if (method === 'POST' && path === '/tasks') return Promise.resolve({ id: 900 });
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    if (path.endsWith('/attachments')) return Promise.resolve([]);
    if (path.startsWith('/tasks/') || path.startsWith('/plans/')) return Promise.resolve({});
    return Promise.resolve([]);
  });
};
const fail = msg => Promise.reject(new Error(msg));
const gets = path => calls.filter(([p, o]) => (p === path || p.startsWith(path + '?')) && (o?.method || 'GET') === 'GET');
const sent = (method, path) => calls.filter(([p, o]) => p === path && o?.method === method);

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
const navButton = name => within(bottomNav()).getByText(name).closest('button');
const click = el => act(async () => { el.click(); });

async function mountShell() {
  render(<Shell onLogout={() => {}} />);
  await screen.findByRole('heading', { name: '今天' });
}

// 到任務頁把「買參考書」打勾：PATCH 之後走 reload('tasks')
async function completeTaskFromTasksPage() {
  await click(navButton('任務'));
  await click(screen.getByRole('checkbox', { name: '完成「買參考書」' }));
}

// Global Add 快速任務：POST 之後走完整 reload()（含 lists／filters／habits）
async function quickAddViaGlobalAdd(title) {
  await click(screen.getByRole('button', { name: '新增' }));
  await click(screen.getByRole('button', { name: '新增任務' }));
  fireEvent.change(await screen.findByLabelText('任務標題'), { target: { value: title } });
  await click(within(screen.getByLabelText('任務標題').closest('form')).getByRole('button', { name: '新增任務' }));
}

describe('初始載入', () => {
  it('/tasks 失敗：畫面照常 render、不產生未處理的 rejection，其他資料仍載入', async () => {
    setApi({ '/tasks': () => fail('任務載入失敗'), '/plans': [fx.plans[0]] });
    await mountShell();
    await waitFor(() => expect(gets('/plans')).toHaveLength(1));
    expect(screen.getByText('今天沒有排任務')).toBeInTheDocument();
    // /plans 成功的部分沒有因為 /tasks 失敗而被丟掉
    await click(navButton('計畫'));
    expect(await within(main()).findByText('第二次段考準備')).toBeInTheDocument();
    noCrash();
  });

  it('可選資料與 /plans 全部失敗：任務仍正常顯示', async () => {
    setApi({
      '/plans': () => fail('計畫載入失敗'), '/pet': () => fail('x'),
      '/lists': () => fail('x'), '/filters': () => fail('x'), '/habits': () => fail('x'),
    });
    await mountShell();
    expect(await screen.findByText('買參考書')).toBeInTheDocument();
    noCrash();
  });
});

describe('mutation 後 reload', () => {
  it('寫入成功但 /tasks 刷新失敗：caller 收到失敗並提示，重新載入只重抓、不重送寫入', async () => {
    setApi({ '/tasks': (_, n) => (n === 2 ? fail('離線') : fx.tasks) });
    await mountShell();
    await screen.findByText('買參考書');
    await completeTaskFromTasksPage();

    // 修正前 reload 會 resolve，這個提示永遠不會出現（誤判為已同步）
    expect(await screen.findByText(/任務已更新，但畫面暫時無法重新載入/)).toBeInTheDocument();
    await click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByText(/任務已更新，但畫面暫時無法重新載入/)).toBeNull());
    expect(sent('PATCH', '/tasks/16')).toHaveLength(1);
    expect(gets('/tasks')).toHaveLength(3);
    noCrash();
  });

  it('寫入成功且刷新成功：不出現任何刷新錯誤', async () => {
    await mountShell();
    await screen.findByText('買參考書');
    await completeTaskFromTasksPage();
    await waitFor(() => expect(gets('/tasks')).toHaveLength(2));
    expect(screen.queryByText(/畫面暫時無法重新載入/)).toBeNull();
    noCrash();
  });
});

describe('部分 API 失敗', () => {
  it('完整 reload 時只有 /pet、/lists、/filters、/habits 失敗：視為刷新成功，任務照樣更新', async () => {
    let afterAdd = false;
    const optional = ok => (afterAdd ? fail('可選資料失敗') : ok);
    setApi({
      '/tasks': () => (afterAdd ? [...fx.tasks, { ...fx.tasks[5], id: 900, title: '新任務A' }] : fx.tasks),
      '/pet': () => optional(fx.responses['/pet']),
      '/lists': () => optional(fx.lists),
      '/filters': () => optional([]),
      '/habits': () => optional(fx.responses['/habits']),
    });
    await mountShell();
    await screen.findByText('買參考書');
    afterAdd = true;
    await quickAddViaGlobalAdd('新任務A');

    expect(await screen.findByText('新任務A')).toBeInTheDocument();
    expect(screen.queryByText(/畫面暫時無法重新載入/)).toBeNull();
    expect(sent('POST', '/tasks')).toHaveLength(1);
    noCrash();
  });

  it('完整 reload 時 /tasks 失敗：Global Add 提示已新增但無法重新載入，不重送 POST', async () => {
    setApi({ '/tasks': (_, n) => (n === 2 ? fail('離線') : fx.tasks) });
    await mountShell();
    await screen.findByText('買參考書');
    await quickAddViaGlobalAdd('新任務B');

    expect(await screen.findByText(/任務已新增，但畫面暫時無法重新載入/)).toBeInTheDocument();
    expect(screen.queryByLabelText('任務標題')).toBeNull();
    expect(sent('POST', '/tasks')).toHaveLength(1);
    noCrash();
  });

  it('/tasks 失敗但 /plans 成功：reload 回報失敗，同時成功的 /plans 仍然套用', async () => {
    const created = { ...fx.plans[0], id: 77, name: '刷新後才出現的計畫' };
    setApi({
      '/tasks': (_, n) => (n === 2 ? fail('離線') : fx.tasks),
      '/plans': (_, n) => (n >= 2 ? [fx.plans[0], created] : [fx.plans[0]]),
    });
    await mountShell();
    await screen.findByText('買參考書');
    await completeTaskFromTasksPage();
    expect(await screen.findByText(/任務已更新，但畫面暫時無法重新載入/)).toBeInTheDocument();

    await click(navButton('計畫'));
    expect(await within(main()).findByText('刷新後才出現的計畫')).toBeInTheDocument();
    noCrash();
  });

  it('/tasks 與 /plans 同時失敗：優先回報任務刷新失敗（e.message 來自 /tasks）', async () => {
    // PlanDetailView 的任務勾選 recovery 會直接顯示 e.message，可分辨是哪一支失敗
    const planTask = { ...fx.tasks[5], id: 61, title: '計畫內任務', plan_id: 12, plan_status: 'active' };
    const all = [...fx.tasks, planTask];
    setApi({
      '/tasks': (_, n) => (n === 2 ?fail('任務刷新失敗') : all),
      '/plans': (_, n) => (n === 2 ? fail('計畫刷新失敗') : [fx.plans[0]]),
    });
    await mountShell();
    await screen.findByText('買參考書');
    await click(navButton('計畫'));
    await click(await within(main()).findByText('第二次段考準備'));
    await click(await screen.findByRole('checkbox', { name: /計畫內任務/ }));

    expect(await screen.findByText('任務刷新失敗')).toBeInTheDocument();
    expect(screen.queryByText('計畫刷新失敗')).toBeNull();
    expect(sent('PATCH', '/tasks/61')).toHaveLength(1);
    noCrash();
  });
});

describe('既有 callers：寫入後必須離開原畫面的流程', () => {
  it('建立一般計畫：POST 成功但 /tasks 刷新失敗仍進明細，不留重送入口', async () => {
    let created = null;
    setApi({
      '/plans': opts => {
        if (opts?.method === 'POST') { created = { ...fx.emptyPlan }; return created; }
        return created ? [...fx.plans, created] : fx.plans;
      },
      '/tasks': (_, n) => (n === 2 ? fail('離線') : fx.tasks),
    });
    await mountShell();
    await click(navButton('計畫'));
    await click(screen.getByRole('button', { name: '建立一般計畫（非段考）' }));

    expect(await within(main()).findByRole('heading', { name: '新的計畫' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '建立一般計畫（非段考）' })).toBeNull();
    expect(sent('POST', '/plans')).toHaveLength(1);
    noCrash();
  });

  it('精靈內新增科目：POST /lists 成功但 reload 失敗，新增欄位仍收起並選好新科目', async () => {
    setApi({
      '/study-materials?shelf=1': { books: [], counts: { material: 0, legacy: 0 } },
      '/lists': opts => (opts?.method === 'POST' ? { id: 9, name: opts.body.name } : fx.lists),
    });
    const reload = vi.fn().mockRejectedValue(new Error('離線'));
    render(<WizardView lists={fx.lists} reload={reload} goTasks={() => {}} goCalendar={() => {}} />);
    await click(await screen.findByRole('button', { name: /加入教材/ }));
    await click(await screen.findByRole('button', { name: /自己建立教材/ }));
    fireEvent.change(await screen.findByLabelText('科目'), { target: { value: '__new' } });
    fireEvent.change(await screen.findByLabelText('新科目名稱'), { target: { value: '數學' } });
    await click(screen.getByRole('button', { name: /^新增$/ }));

    await waitFor(() => expect(screen.queryByLabelText('新科目名稱')).toBeNull());
    expect(reload).toHaveBeenCalledOnce();
    expect(sent('POST', '/lists')).toHaveLength(1);
    noCrash();
  });
});
