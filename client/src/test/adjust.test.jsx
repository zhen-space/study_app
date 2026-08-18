// Phase 2C-P6-A（UI）：手動調整 AI 排出來的時間。
//
// 這裡守的是：
//   ① 按下「儲存新安排」之前，一個位元組都不寫
//   ② 寫入一律走 POST /schedule/manual，前端絕不自己改 due_date
//   ③ 調整對象是 block_id，不是 task_id（多 block 任務不能被整組重置）
//   ④ base_version_id 一定要送出去（少了它就會蓋掉沒看過的排程）
//   ⑤ 放不下時說得出原因，而且沒有「還是要放」的出口
//   ⑥ 沒有 active version 時不長出調整入口，畫面照常

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;

const iso = n => addDays(today(), n);

const PLAN = { ...fx.plans[0], id: 12, name: '第二次段考', start_date: iso(-2), target_date: iso(14) };
// 今天有時間的計畫任務 → 會出現在 Today 的「接下來」
const TIMED = {
  id: 21, list_id: 1, plan_id: 12, title: '物理｜段考範圍｜力學複習',
  due_date: iso(0), due_time: '19:00', priority: 0, completed: 0, tags: ['讀書計劃'],
  subtasks: [], recurring: null, deadline_date: null, order_index: 20, deleted: 0,
};
// 同一個任務被切成兩塊：測「調整只動點到的那一塊」
const BLOCK_A = { id: 501, task_id: 21, date: iso(0), start_time: '19:00', end_time: '20:00', planned_minutes: 60 };
const BLOCK_B = { id: 502, task_id: 21, date: iso(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 };
const ACTIVE = {
  active: true,
  version: { id: 77, version_no: 5, source: 'ai_replan' },
  // 故意把「別天那一塊」放前面：挑 block 若不比對日期／時間就會挑錯
  blocks: [BLOCK_B, BLOCK_A],
  unplaced: [],
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
    if (path === '/schedule/active') return Promise.resolve(ACTIVE);
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
// dry run 是 debounce 過的，要把假時鐘往前推
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); };
const writes = () => calls.filter(([, o]) => o?.method && o.method !== 'GET');
const manualCalls = () => calls.filter(([p]) => p === '/schedule/manual');
const realWrites = () => manualCalls().filter(([, o]) => o?.body?.dry_run !== true);

async function mountShell(over = {}) {
  setApi({ '/tasks': [TIMED], '/plans': [PLAN], ...over });
  const r = render(<Shell onLogout={() => {}} />);
  await screen.findByRole('heading', { name: '今天' });
  await waitFor(() => expect(calls.some(([p]) => p.startsWith('/plans'))).toBe(true));
  await flush();
  return r;
}

// 受控 input 要走 fireEvent.change，直接設 .value React 收不到
const setDate = async v => {
  await act(async () => { fireEvent.change(screen.getByLabelText('日期'), { target: { value: v } }); });
  await settle();
};

const adjustBtn = () => screen.queryByRole('button', { name: /調整「.*」的時間/ });
const sheet = () => document.querySelector('.ev-sheet');

describe('調整入口', () => {
  it('1. 今天已排定的讀書時段會有「調整」入口', async () => {
    await mountShell();
    expect(adjustBtn()).toBeInTheDocument();
    noCrash();
  });

  it('2. 還沒有 active version 時不長出調整入口，畫面照常', async () => {
    await mountShell({ '/schedule/active': { active: false, version: null, blocks: [], unplaced: [] } });
    expect(adjustBtn()).not.toBeInTheDocument();
    // 時間軸本身還在，只是不能調
    expect(screen.getByText('接下來')).toBeInTheDocument();
    noCrash();
  });

  it('3. 固定行程沒有調整入口（那不是 AI 排的）', async () => {
    await mountShell({
      '/events': [{ id: 91, title: '社團', date: iso(0), start_time: '15:00', end_time: '17:00', recurring: null, location: '' }],
      '/tasks': [],
    });
    expect(screen.getByText('社團')).toBeInTheDocument();
    expect(adjustBtn()).not.toBeInTheDocument();
    noCrash();
  });
});

describe('調整流程：儲存之前不寫任何東西', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('4. 打開面板、改日期，都只會發 dry run，不寫入', async () => {
    await mountShell();
    await click(adjustBtn());
    expect(sheet()).toBeTruthy();
    expect(manualCalls()).toHaveLength(0);

    await setDate(iso(5));

    const dry = manualCalls();
    expect(dry.length).toBeGreaterThan(0);
    expect(dry.every(([, o]) => o.body.dry_run === true), 'dry run 之外不該有任何請求').toBe(true);
    expect(realWrites()).toHaveLength(0);
    // 完全沒有其他寫入路徑被偷偷用掉
    expect(writes().filter(([p]) => p !== '/schedule/manual')).toHaveLength(0);
    noCrash();
  });

  it('5. 送出的是 block_id 與 base_version_id，不是 task_id', async () => {
    await mountShell();
    await click(adjustBtn());
    await setDate(iso(5));

    const [, opts] = manualCalls()[0];
    expect(opts.body.base_version_id).toBe(77);
    expect(opts.body.moves).toHaveLength(1);
    // 點到的是今天那一塊（501），不是同一個任務的另一塊（502）
    expect(opts.body.moves[0].block_id).toBe(501);
    expect(opts.body.moves[0]).not.toHaveProperty('task_id');
    expect(opts.body.moves[0].date).toBe(iso(5));
    noCrash();
  });

  it('6. 按下「儲存新安排」才寫入，而且不碰 /tasks 的 due_date', async () => {
    await mountShell();
    await click(adjustBtn());
    await setDate(iso(5));

    await click(screen.getByRole('button', { name: '儲存新安排' }));
    await flush();

    expect(realWrites()).toHaveLength(1);
    const [, opts] = realWrites()[0];
    expect(opts.method).toBe('POST');
    expect(opts.body.dry_run).toBeUndefined();
    expect(opts.body.moves[0].block_id).toBe(501);
    // 少了 base_version_id，後端就無從判斷這是不是對著舊排程做的調整
    expect(opts.body.base_version_id, '儲存時一定要帶 base_version_id').toBe(77);
    // due_date 是鏡射，前端不准直接寫
    const taskWrites = writes().filter(([p, o]) =>
      p.startsWith('/tasks/') && (o.body?.due_date !== undefined || o.body?.due_time !== undefined));
    expect(taskWrites, '前端不可以直接改 due_date／due_time').toHaveLength(0);
    noCrash();
  });

  it('7. 什麼都沒改時，「儲存新安排」是停用的', async () => {
    await mountShell();
    await click(adjustBtn());
    expect(screen.getByRole('button', { name: '儲存新安排' })).toBeDisabled();
    noCrash();
  });
});

describe('放不下的時候', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  const withConflict = conflicts => ({
    '/schedule/manual': opts => Promise.resolve({ ok: false, conflicts, base_version_id: 77 }),
  });

  it('8. 照後端給的原因說明，而且不能儲存', async () => {
    await mountShell(withConflict([
      { block_id: 501, task_id: 21, type: 'fixed_event', message: '這個時段與固定行程「社團」重疊' },
    ]));
    await click(adjustBtn());
    await setDate(iso(5));

    expect(screen.getByText('這個時間放不下')).toBeInTheDocument();
    // 用 All：外層卡片與那一行都含這段字，重點是原因真的照後端的話講出來
    expect(screen.getAllByText(/固定行程「社團」重疊/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '儲存新安排' })).toBeDisabled();
    noCrash();
  });

  it('9. Lock 的機器碼會翻成人話', async () => {
    await mountShell(withConflict([{ type: 'LOCKED_DAY_CHANGED', severity: 'hard', lock_id: 3 }]));
    await click(adjustBtn());
    await setDate(iso(5));

    expect(screen.getByText(/那一天已鎖定/)).toBeInTheDocument();
    // 沒有任何「還是要放」的出口
    expect(screen.queryByRole('button', { name: /仍要|強制|還是/ })).not.toBeInTheDocument();
    noCrash();
  });

  it('10. 儲存當下才被擋下來（dry run 過了但真正寫入 409）也說得出原因', async () => {
    let dryRunOk = true;
    await mountShell({
      '/schedule/manual': opts => {
        if (opts.body.dry_run) return Promise.resolve({ ok: dryRunOk, conflicts: [], base_version_id: 77 });
        const e = new Error('這個時間放不下，請看衝突原因');
        e.status = 409;
        e.conflicts = [{ type: 'past', message: '不能安排到已經過去的時間' }];
        return Promise.reject(e);
      },
    });
    await click(adjustBtn());
    await setDate(iso(5));

    await click(screen.getByRole('button', { name: '儲存新安排' }));
    await flush();

    expect(screen.getByText(/不能安排到已經過去的時間/)).toBeInTheDocument();
    // 面板留著，讓使用者改；不會假裝成功關掉
    expect(sheet()).toBeTruthy();
    noCrash();
  });
});
