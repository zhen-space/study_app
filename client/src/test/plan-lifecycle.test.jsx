// Plan lifecycle cleanup 的前端串接。
//
// 要證明的是「暫停／刪除真的接進了 Plan Detail 的 ••• 選單」，不是模組寫好了：
//   ・兩者是不同的確認畫面，不是同一個框換字
//   ・都必須先選「未完成的任務怎麼辦」，沒選不能送出
//   ・刪除要按兩次，而且用 destructive 樣式
//   ・送出的 body 帶的是 boolean，不是字串
//   ・不是用封存或強制完成假裝暫停／刪除
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;

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
const cardByName = name => [...main().querySelectorAll('.plan-card')]
  .find(el => el.querySelector('b')?.textContent === name);
const sheet = () => document.querySelector('.sheet-panel');
const sheetRow = name => within(sheet()).getByText(name).closest('.ui-row');
const sent = (method, pathPart) =>
  calls.filter(([p, o]) => p.includes(pathPart) && (o?.method || 'GET') === method);

const withPlan = (over = {}, plan = fx.plans[0]) => setApi({
  '/plans': [plan], '/tasks': [...fx.tasks, ...fx.planTasks], ...over,
});

async function goPlans() {
  render(<Shell onLogout={() => {}} />);
  await screen.findByRole('heading', { name: '今天' });
  await click(within(bottomNav()).getByText('計畫').closest('button'));
}
// 已暫停是收合區塊，要先展開才看得到卡片
async function expandSection(label) {
  const row = within(main()).queryByText(label);
  if (row) await click(row.closest('.ui-row') || row.closest('button') || row);
}
async function openPlan(planName = '第二次段考準備', section = null) {
  await goPlans();
  if (section) await expandSection(section);
  await click(cardByName(planName));
}
async function openManage(planName = '第二次段考準備', section = null) {
  await openPlan(planName, section);
  await click(screen.getByRole('button', { name: '計畫選項' }));
}

// 選 radio。value 是 boolean 選項的標題
const chooseRetain = label => click(within(sheet()).getByLabelText(label));

describe('••• 選單', () => {
  it('進行中的計畫同時提供暫停與刪除，而且兩者不是同一個東西', async () => {
    withPlan();
    await openManage();
    expect(within(sheet()).getByText('暫停計畫')).toBeInTheDocument();
    expect(within(sheet()).getByText('刪除計畫')).toBeInTheDocument();
    // 封存仍然是另一個獨立動作，沒有被拿來冒充
    expect(within(sheet()).getByText('封存')).toBeInTheDocument();
    noCrash();
  });

  it('已暫停的計畫改成提供「繼續計畫」，而且不再有暫停', async () => {
    withPlan({}, { ...fx.plans[0], status: 'paused' });
    await openManage('第二次段考準備', '已暫停');
    expect(within(sheet()).getByText('繼續計畫')).toBeInTheDocument();
    expect(within(sheet()).queryByText('暫停計畫')).toBeNull();
    noCrash();
  });

  it('繼續計畫走 POST /plans/:id/resume，不帶 retain', async () => {
    withPlan({}, { ...fx.plans[0], status: 'paused' });
    await openManage('第二次段考準備', '已暫停');
    await click(sheetRow('繼續計畫'));
    const posts = sent('POST', '/plans/12/resume');
    expect(posts.length).toBe(1);
    expect('retain_incomplete_tasks' in (posts[0][1].body || {})).toBe(false);
    noCrash();
  });

  it('暫停的計畫不顯示排程／新增任務入口——那些按下去必定失敗', async () => {
    withPlan({}, { ...fx.plans[0], status: 'paused' });
    await openPlan('第二次段考準備', '已暫停');
    expect(within(main()).queryByRole('button', { name: '調整計畫' })).toBeNull();
    noCrash();
  });
});

// 讓 mock 回一個真實形狀的 409（api.js 會把 body 掛在 err.payload 上）
const reject = (status, payload) => () => {
  const e = new Error(payload.error || '發生錯誤');
  e.status = status; e.payload = payload;
  return Promise.reject(e);
};

describe('重新開始', () => {
  it('走 POST /restart，不再送無效的 PATCH { status }', async () => {
    withPlan({}, { ...fx.plans[0], status: 'completed' });
    await openManage('第二次段考準備', '已完成');
    await click(sheetRow('重新開始'));
    const posts = sent('POST', '/plans/12/restart');
    expect(posts.length).toBe(1);
    // 舊寫法是 PATCH /plans/12 { status:'active' }——那個請求什麼都不會改
    const patches = calls.filter(([p, o]) => p === '/plans/12' && o?.method === 'PATCH');
    expect(patches.length).toBe(0);
    noCrash();
  });

  it('已結束的計畫也有重新開始的入口', async () => {
    withPlan({}, { ...fx.plans[0], status: 'ended' });
    await openManage('第二次段考準備', '其他');
    expect(within(sheet()).getByText('重新開始')).toBeInTheDocument();
    await click(sheetRow('重新開始'));
    expect(sent('POST', '/plans/12/restart').length).toBe(1);
    noCrash();
  });
});

describe('標記完成沒有 force', () => {
  it('未完成任務時顯示「不能標記為完成」，而且沒有繞過去的按鈕', async () => {
    withPlan({
      '/plans/12/complete': reject(409, {
        error: '仍有未完成任務', code: 'unresolved_tasks',
        unresolved: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }],
      }),
    });
    await openManage();
    await click(sheetRow('標記完成'));
    expect(within(sheet()).getByText(/尚有未完成任務，不能標記為完成/)).toBeInTheDocument();
    expect(within(sheet()).getByText(/還有 2 項/)).toBeInTheDocument();
    expect(within(sheet()).queryByRole('button', { name: '仍然完成' })).toBeNull();
    noCrash();
  });

  it('完成請求不帶 force，也不等 needs_confirm', async () => {
    withPlan({
      '/plans/12/complete': reject(409, { error: 'x', code: 'unresolved_tasks', unresolved: [{ id: 1 }] }),
    });
    await openManage();
    await click(sheetRow('標記完成'));
    const posts = sent('POST', '/plans/12/complete');
    expect(posts.length).toBe(1);
    expect('force' in (posts[0][1].body || {})).toBe(false);
    noCrash();
  });

  it('全部有結果時直接完成，不跳任何確認', async () => {
    withPlan({ '/plans/12/complete': { plan: { ...fx.plans[0], status: 'completed' } } });
    await openManage();
    await click(sheetRow('標記完成'));
    expect(sent('POST', '/plans/12/complete').length).toBe(1);
    expect(document.querySelector('.sheet-panel')).toBeNull();
    noCrash();
  });

  it('draft 與已完成的計畫看不到「標記完成」', async () => {
    withPlan({}, { ...fx.plans[0], status: 'draft' });
    await openManage();
    expect(within(sheet()).queryByText('標記完成')).toBeNull();
    noCrash();
  });
});

describe('結束計畫是不再繼續的出口', () => {
  it('從「不能標記為完成」可以改走結束計畫，且會送 confirm', async () => {
    withPlan({
      '/plans/12/complete': reject(409, { error: 'x', code: 'unresolved_tasks', unresolved: [{ id: 1 }] }),
      '/plans/12/end': { plan: { ...fx.plans[0], status: 'ended' } },
    });
    await openManage();
    await click(sheetRow('標記完成'));
    await click(within(sheet()).getByRole('button', { name: '改成結束計畫' }));
    expect(within(sheet()).getByText(/結束這個計畫？/)).toBeInTheDocument();
    // 文案被 <b> 切開，所以比對整個面板的文字，而不是單一節點
    expect(sheet().textContent).toMatch(/不會.{0,4}被算成完成/);
    await click(within(sheet()).getByRole('button', { name: '結束計畫' }));
    const posts = sent('POST', '/plans/12/end');
    expect(posts.length).toBe(1);
    expect(posts[0][1].body.confirm).toBe(true);
    // 絕不能改去打 complete
    expect(sent('POST', '/plans/12/complete').length).toBe(1);
    noCrash();
  });

  it('••• 直接提供結束計畫；後端要求確認時先問過再送 confirm', async () => {
    let calledOnce = false;
    withPlan({
      '/plans/12/end': (opts) => {
        if (!opts?.body?.confirm && !calledOnce) {
          calledOnce = true;
          return reject(409, {
            error: '結束計畫會保留未完成任務，請明確確認',
            code: 'end_confirmation_required', unresolved: [{ id: 1 }, { id: 2 }, { id: 3 }],
          })();
        }
        return Promise.resolve({ plan: { ...fx.plans[0], status: 'ended' } });
      },
    });
    await openManage();
    await click(sheetRow('結束計畫'));
    expect(within(sheet()).getByText(/還有 3 項未完成/)).toBeInTheDocument();
    await click(within(sheet()).getByRole('button', { name: '結束計畫' }));
    const posts = sent('POST', '/plans/12/end');
    expect(posts.length).toBe(2);
    expect(posts[0][1].body.confirm).toBeUndefined();
    expect(posts[1][1].body.confirm).toBe(true);
    noCrash();
  });

  it('取消就什麼都不做，不會偷偷結束', async () => {
    withPlan({
      '/plans/12/end': reject(409, { error: 'x', code: 'end_confirmation_required', unresolved: [{ id: 1 }] }),
    });
    await openManage();
    await click(sheetRow('結束計畫'));
    await click(within(sheet()).getByRole('button', { name: '取消' }));
    // 只有那一次探詢，沒有真的送出結束
    expect(sent('POST', '/plans/12/end').length).toBe(1);
    noCrash();
  });

  it('已完成的計畫不提供結束（那是給還沒做完的出口）', async () => {
    withPlan({}, { ...fx.plans[0], status: 'completed' });
    await openManage('第二次段考準備', '已完成');
    expect(within(sheet()).queryByText('結束計畫')).toBeNull();
    noCrash();
  });
});

describe('暫停的計畫仍然看得見', () => {
  it('列在「已暫停」區塊裡，並標示已暫停——不是消失、也不是被當成已封存', async () => {
    withPlan({}, { ...fx.plans[0], status: 'paused' });
    await goPlans();
    expect(within(main()).getByText('已暫停')).toBeInTheDocument();
    expect(within(main()).queryByText('已封存')).toBeNull();
    await expandSection('已暫停');
    const card = cardByName('第二次段考準備');
    expect(card).toBeTruthy();
    expect(within(card).getByText('已暫停')).toBeInTheDocument();
    noCrash();
  });
});

describe('暫停確認', () => {
  it('沒選「未完成的任務怎麼辦」就不能送出', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('暫停計畫'));
    const btn = within(sheet()).getByRole('button', { name: '暫停計畫' });
    expect(btn.disabled).toBe(true);
    await click(btn);
    expect(sent('POST', '/pause').length).toBe(0);
    noCrash();
  });

  it('選了保留之後送出 retain_incomplete_tasks: true（boolean，不是字串）', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('暫停計畫'));
    await chooseRetain('保留未完成的任務');
    await click(within(sheet()).getByRole('button', { name: '暫停計畫' }));
    const posts = sent('POST', '/plans/12/pause');
    expect(posts.length).toBe(1);
    expect(posts[0][1].body.retain_incomplete_tasks).toBe(true);
    noCrash();
  });

  it('選了不保留就送 false，而且說清楚任務會被移到垃圾桶', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('暫停計畫'));
    expect(within(sheet()).getByText(/未完成的任務會移到垃圾桶/)).toBeInTheDocument();
    await chooseRetain('不保留未完成的任務');
    await click(within(sheet()).getByRole('button', { name: '暫停計畫' }));
    expect(sent('POST', '/plans/12/pause')[0][1].body.retain_incomplete_tasks).toBe(false);
    noCrash();
  });

  it('暫停不是封存、也不是強制完成：只打 /pause 這一支', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('暫停計畫'));
    await chooseRetain('保留未完成的任務');
    await click(within(sheet()).getByRole('button', { name: '暫停計畫' }));
    expect(sent('POST', '/archive').length).toBe(0);
    expect(sent('POST', '/complete').length).toBe(0);
    expect(sent('POST', '/plans/12/delete').length).toBe(0);
    noCrash();
  });
});

describe('刪除確認', () => {
  it('跟暫停是不同的畫面，而且明說無法復原', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('刪除計畫'));
    expect(within(sheet()).getByText(/刪除這個計畫？/)).toBeInTheDocument();
    expect(within(sheet()).getByText(/無法復原/)).toBeInTheDocument();
    // 暫停畫面的字不該出現在這裡
    expect(within(sheet()).queryByText(/隨時可以再繼續/)).toBeNull();
    noCrash();
  });

  it('沒選保留設定就不能往下一步', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('刪除計畫'));
    expect(within(sheet()).getByRole('button', { name: '下一步' }).disabled).toBe(true);
    noCrash();
  });

  it('要按兩次才會真的刪除，而且兩顆都是 destructive 樣式', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('刪除計畫'));
    await chooseRetain('保留未完成的任務');
    const next = within(sheet()).getByRole('button', { name: '下一步' });
    expect(next.className).toMatch(/ui-btn--destructive/);
    await click(next);
    // 第一次按完什麼都還沒送出
    expect(sent('POST', '/plans/12/delete').length).toBe(0);
    const final = within(sheet()).getByRole('button', { name: '確定刪除' });
    expect(final.className).toMatch(/ui-btn--destructive/);
    await click(final);
    const posts = sent('POST', '/plans/12/delete');
    expect(posts.length).toBe(1);
    expect(posts[0][1].body.retain_incomplete_tasks).toBe(true);
    noCrash();
  });

  it('第二層確認會照選擇說明後果，而且可以退回去改', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('刪除計畫'));
    await chooseRetain('不保留未完成的任務');
    await click(within(sheet()).getByRole('button', { name: '下一步' }));
    expect(within(sheet()).getByText(/未完成的任務會一起移到垃圾桶/)).toBeInTheDocument();
    await click(within(sheet()).getByRole('button', { name: '返回' }));
    expect(within(sheet()).getByRole('button', { name: '下一步' })).toBeInTheDocument();
    expect(sent('POST', '/plans/12/delete').length).toBe(0);
    noCrash();
  });

  it('刪除不是封存：不會偷偷打 /archive', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('刪除計畫'));
    await chooseRetain('不保留未完成的任務');
    await click(within(sheet()).getByRole('button', { name: '下一步' }));
    await click(within(sheet()).getByRole('button', { name: '確定刪除' }));
    expect(sent('POST', '/archive').length).toBe(0);
    expect(sent('POST', '/plans/12/delete')[0][1].body.retain_incomplete_tasks).toBe(false);
    noCrash();
  });

  it('取消就什麼都不做', async () => {
    withPlan();
    await openManage();
    await click(sheetRow('刪除計畫'));
    await chooseRetain('保留未完成的任務');
    await click(within(sheet()).getByRole('button', { name: '取消' }));
    expect(sent('POST', '/plans/12/delete').length).toBe(0);
    noCrash();
  });
});
