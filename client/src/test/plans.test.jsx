// Phase 2A：正式 Plan 與 legacy 推導並存時的前端行為。
// 契約見 docs/phase2-plan-domain.md。這裡守的是：
//   - 有 plan_id 的任務歸正式 Plan，不會再被 legacy heuristic 撿走
//   - 舊資料（沒有 plan_id）還是看得到，標示為「舊資料」
//   - /plans 掛掉或回空時不能整頁炸掉
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;

const setApi = (over = {}) => {
  api.mockImplementation(path => {
    if (path in over) return Promise.resolve(over[path]);
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    if (path.endsWith('/attachments')) return Promise.resolve([]);
    if (path.startsWith('/tasks/')) return Promise.resolve({});
    return Promise.resolve([]);
  });
};

let errors;
beforeEach(() => {
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
const goPlans = async () => {
  await waitFor(() => expect(screen.getByText('項待完成')).toBeInTheDocument());
  await click(within(bottomNav()).getByText('計畫').closest('button'));
};

describe('正式 Plan（API）', () => {
  it('/plans 的計畫會顯示出來，用的是 Plan 的名稱而不是科目名', async () => {
    setApi({ '/plans': fx.plans, '/tasks': [...fx.tasks, ...fx.planTasks] });
    render(<Shell onLogout={() => {}} />);
    await goPlans();
    expect(within(main()).getByText('第二次段考準備')).toBeInTheDocument();
    noCrash();
  });

  it('一個 Plan 可以跨科目：兩科的任務都在同一個計畫底下', async () => {
    setApi({ '/plans': fx.plans, '/tasks': [...fx.tasks, ...fx.planTasks] });
    render(<Shell onLogout={() => {}} />);
    await goPlans();
    await click(within(main()).getByText('第二次段考準備').closest('.tile'));
    expect(within(main()).getByText(/力學複習/)).toBeInTheDocument();
    expect(within(main()).getByText(/大氣複習/)).toBeInTheDocument();
    noCrash();
  });

  it('有 plan_id 的任務不會再被 legacy 推導撿走（不會重複出現兩次）', async () => {
    setApi({ '/plans': fx.plans, '/tasks': fx.planTasks });
    render(<Shell onLogout={() => {}} />);
    await goPlans();
    // 只有一張卡＝正式 Plan；沒有額外冒出「物理」「地科」兩張 legacy 卡
    expect(within(main()).queryByText('舊資料')).not.toBeInTheDocument();
    expect(within(main()).getAllByText(/第二次段考準備/).length).toBe(1);
    noCrash();
  });
});

describe('Legacy 相容', () => {
  it('沒有 plan_id 的舊資料仍然看得到，並標示為舊資料', async () => {
    setApi({ '/plans': [], '/tasks': fx.tasks });
    render(<Shell onLogout={() => {}} />);
    await goPlans();
    expect(within(main()).getByText('物理')).toBeInTheDocument();
    expect(within(main()).getAllByText('舊資料').length).toBeGreaterThan(0);
    noCrash();
  });

  it('正式 Plan 與舊資料可以同時存在', async () => {
    setApi({ '/plans': fx.plans, '/tasks': [...fx.tasks, ...fx.planTasks] });
    render(<Shell onLogout={() => {}} />);
    await goPlans();
    expect(within(main()).getByText('第二次段考準備')).toBeInTheDocument();
    expect(within(main()).getAllByText('舊資料').length).toBeGreaterThan(0);
    noCrash();
  });

  it('/plans 回空陣列時退回 legacy，畫面照常', async () => {
    setApi({ '/plans': [] });
    render(<Shell onLogout={() => {}} />);
    await goPlans();
    expect(screen.getByRole('heading', { name: '計畫' })).toBeInTheDocument();
    noCrash();
  });

  it('/plans 整支失敗（舊後端）也不能讓畫面掛掉', async () => {
    api.mockImplementation(path => {
      if (path === '/plans') return Promise.reject(new Error('404'));
      if (path in fx.responses) return Promise.resolve(fx.responses[path]);
      if (path.endsWith('/attachments')) return Promise.resolve([]);
      if (path.startsWith('/tasks/')) return Promise.resolve({});
      return Promise.resolve([]);
    });
    render(<Shell onLogout={() => {}} />);
    await goPlans();
    expect(screen.getByRole('heading', { name: '計畫' })).toBeInTheDocument();
    noCrash();
  });
});
