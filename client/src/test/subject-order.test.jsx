// Phase 2C-P6-B（UI）：排程精靈的科目先後順序。
//
// 這裡守的是：
//   ① 只有多科時才出現這個設定（單科排順序沒有意義）
//   ② 使用者沒排過 → 完全不送 subject_order，後端維持既有行為
//   ③ 排過之後 → 送出結構化的 subject_order，順序就是畫面上的順序
//   ④ 文案要講清楚 priority ≠ dependency
//   ⑤ 順序會存進條件快照，重排時沿用同一個排法

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const WizardView = (await import('../tt/WizardView')).default;
const { buildSchedulePreviewRequest, readConfirmedConditions } = await import('../tt/schedulePreview');

// 兩科各一章：科目順序才有得排
const TWO_SUBJECT_TOC = [
  { id: 101, list_id: 1, book: '新大滿貫', publisher: '龍騰', title: '單元1 力學', level: '章',
    sections: [{ title: '節1 直線運動', level: '節', children: [] }] },
  { id: 201, list_id: 2, book: '新關鍵', publisher: '翰林', title: '單元1 大氣', level: '章',
    sections: [{ title: '節1 對流層', level: '節', children: [] }] },
];

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
    if (path === '/import/toc') return Promise.resolve(TWO_SUBJECT_TOC);
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
const previewBody = () => calls.filter(([p, o]) => p === '/schedule/preview' && o?.method === 'POST').at(-1)?.[1].body;

async function mountWizard(props = {}) {
  const r = render(<WizardView lists={fx.lists} reload={() => Promise.resolve()}
    goTasks={() => {}} goCalendar={() => {}} {...props} />);
  await waitFor(() => expect(calls.some(([p]) => p === '/import/toc')).toBe(true));
  await flush();
  return r;
}

const checkChapter = async label =>
  click(screen.getByText(label).closest('.row').querySelector('input[type=checkbox]'));

// 勾兩科各一章 → 第 2 步
async function toStep2({ both = true } = {}) {
  await checkChapter('單元1 力學');
  if (both) await checkChapter('單元1 大氣');
  await click(btn(/下一步：怎麼安排/));
}

const orderRows = () => [...document.querySelectorAll('.row')]
  .filter(r => r.querySelector('button[aria-label^="把"]'));
const orderedNames = () => orderRows().map(r => r.querySelector('.tag')?.textContent);
const moveDown = name => click(screen.getByRole('button', { name: `把${name}往後移` }));
const moveUp = name => click(screen.getByRole('button', { name: `把${name}往前移` }));

describe('什麼時候出現「先讀哪一科」', () => {
  it('1. 多科時才出現', async () => {
    await mountWizard();
    await toStep2();
    expect(screen.getByText('先讀哪一科？')).toBeInTheDocument();
    expect(orderedNames()).toEqual(['物理', '地科']);
    noCrash();
  });

  it('2. 只選一科時不出現（排順序沒有意義）', async () => {
    await mountWizard();
    await toStep2({ both: false });
    expect(screen.queryByText('先讀哪一科？')).not.toBeInTheDocument();
    noCrash();
  });

  it('3. 說明講清楚這不是「讀完才能開始下一科」', async () => {
    await mountWizard();
    await toStep2();
    // Help 內容預設收起來，展開來看
    const help = screen.getByText('先讀哪一科？').parentElement.querySelector('details, .help');
    if (help && help.tagName === 'DETAILS') help.open = true;
    expect(document.body.textContent).toMatch(/不是.*前一科讀完才能開始下一科/);
    noCrash();
  });
});

describe('沒排過就不送 subject_order', () => {
  it('4. 使用者沒動過順序 → request 裡完全沒有這個欄位', async () => {
    await mountWizard();
    await toStep2();
    await click(btn(/產生排程/));
    await flush();

    const body = previewBody();
    expect(body).toBeTruthy();
    expect(body).not.toHaveProperty('subject_order');
    noCrash();
  });

  it('5. buildSchedulePreviewRequest：空的或沒給都不送', async () => {
    const base = { items: [], startDate: '2026-01-01', endDate: '2026-01-09' };
    expect(buildSchedulePreviewRequest({ ...base, conditions: {} }))
      .not.toHaveProperty('subject_order');
    expect(buildSchedulePreviewRequest({ ...base, conditions: { subjectOrder: [] } }))
      .not.toHaveProperty('subject_order');
    expect(buildSchedulePreviewRequest({ ...base, conditions: { subjectOrder: [2, 1] } }).subject_order)
      .toEqual([2, 1]);
  });
});

describe('排過之後送出使用者排的順序', () => {
  it('6. 把地科往上移 → 畫面與 request 都是「地科 → 物理」', async () => {
    await mountWizard();
    await toStep2();
    expect(orderedNames()).toEqual(['物理', '地科']);

    await moveUp('地科');
    expect(orderedNames()).toEqual(['地科', '物理']);

    await click(btn(/產生排程/));
    await flush();

    const body = previewBody();
    expect(body.subject_order.map(String)).toEqual(['2', '1']);
    noCrash();
  });

  it('7. 往下移也對稱', async () => {
    await mountWizard();
    await toStep2();
    await moveDown('物理');
    expect(orderedNames()).toEqual(['地科', '物理']);
    noCrash();
  });

  it('8. 第一個不能再往上、最後一個不能再往下', async () => {
    await mountWizard();
    await toStep2();
    expect(screen.getByRole('button', { name: '把物理往前移' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '把地科往後移' })).toBeDisabled();
    noCrash();
  });

  it('9. 「取消指定順序」之後又回到不送', async () => {
    await mountWizard();
    await toStep2();
    await moveUp('地科');
    expect(screen.getByRole('button', { name: '取消指定順序' })).toBeInTheDocument();

    await click(btn(/取消指定順序/));
    await click(btn(/產生排程/));
    await flush();

    expect(previewBody()).not.toHaveProperty('subject_order');
    noCrash();
  });
});

describe('順序會被記住', () => {
  it('10. 成功套用後存進條件快照，重排才能沿用同一個排法', async () => {
    await mountWizard();
    await toStep2();
    await moveUp('地科');
    await click(btn(/產生排程/));
    await flush();
    await click(btn(/滿意，加入待辦/));
    await flush();

    const saved = readConfirmedConditions(99);
    expect(saved, '套用後要留下條件快照').toBeTruthy();
    expect(saved.subjectOrder.map(String)).toEqual(['2', '1']);
    noCrash();
  });
});
