// Material frontend integration 的互動測試。
//
// 這裡守的界線，每一條壞掉都會直接違反已定案的 hard contract：
//   ・selected 與 completed 是兩個完全獨立的狀態
//   ・Plan 的 checkbox 絕對不呼叫 completion endpoint
//   ・completion 操作絕對不改 Plan selection
//   ・Chapter / Section / Topic 的 checkbox 只做批次 selection
//   ・已完成的子項目不會被 parent 批次選取重新選入
//   ・Section 與 Topic 是 Chapter 的同層節點
//   ・Chapter-level 的單元練習／歷屆試題直接屬於 Chapter
//   ・Category 只 reference Book：同一本書在兩個分類仍是同一個 identity
//   ・blocked reconciliation 不得被靜默忽略
//   ・legacy TOC 不被當成正式 Material

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { act } from 'react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const MaterialSelector = (await import('../tt/MaterialSelector')).default;
const MaterialLibraryView = (await import('../tt/MaterialLibraryView')).default;
const { applyDraftSelection, openItemIdsUnder, collectBlocked } = await import('../tt/material');

/* ---------- 測試資料：完全照正式 hierarchy ---------- */
// 書「新大滿貫」
//   第一章
//     ├ 1-1（節）      → 內文A（未完成）、內文B（已完成）
//     ├ 主題一（主題）  → 例題X（未完成）        ← 與節同層，不是節的 child
//     ├ 單元練習       ← 直接掛在章底下
//     └ 歷屆試題       ← 直接掛在章底下

const item = (id, title, kind, completed = false, selected = false) =>
  ({ id, title, kind, estimated_minutes: null, order_index: id, completed, selected });

const prog = (t, c) => ({ total_items: t, completed_items: c, percent: t ? Math.round(c / t * 100) : 0 });

const makeTree = (over = {}) => ({
  book: { id: 1, title: '新大滿貫', publisher: '龍騰' },
  progress: prog(5, 1),
  selection: 'none',
  nodes: [{
    id: 10, kind: 'chapter', title: '第一章', parent_id: null, order_index: 0,
    progress: prog(5, 1), selection: 'none',
    content_items: [item(103, '單元練習', 'unit_exercise'), item(104, '歷屆試題', 'past_exam')],
    children: [
      {
        id: 11, kind: 'section', title: '1-1', parent_id: 10, order_index: 0,
        progress: prog(2, 1), selection: 'none', children: [],
        content_items: [item(101, '內文A', 'reading'), item(102, '內文B', 'reading', true)],
      },
      {
        id: 12, kind: 'topic', title: '主題一', parent_id: 10, order_index: 1,
        progress: prog(1, 0), selection: 'none', children: [],
        content_items: [item(105, '例題X', 'example')],
      },
    ],
  }],
  ...over,
});

const BOOKS = [{ id: 1, title: '新大滿貫', publisher: '龍騰', subject_list_id: 1, progress: prog(5, 1) }];
const CATEGORIES = [
  { id: 7, name: '第一次段考', books: [{ id: 1, title: '新大滿貫' }] },
  { id: 8, name: '複習', books: [{ id: 1, title: '新大滿貫' }] },
];

let calls;
let treeResponse;
const setApi = (over = {}) => {
  api.mockImplementation((raw, opts) => {
    calls.push([raw, opts]);
    const path = raw.split('?')[0];
    const hit = raw in over ? over[raw] : (path in over ? over[path] : undefined);
    if (hit !== undefined) return Promise.resolve(typeof hit === 'function' ? hit(opts, raw) : hit);
    if (path === '/material/categories') return Promise.resolve(CATEGORIES);
    if (path === '/material/books') return Promise.resolve(BOOKS);
    if (path === '/material/books/1/tree') return Promise.resolve(treeResponse());
    return Promise.resolve({});
  });
};

let errors;
beforeEach(() => {
  calls = [];
  errors = [];
  treeResponse = () => makeTree();
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
  setApi();
});
afterEach(() => { vi.restoreAllMocks(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const click = el => act(async () => { el.click(); });
const sent = (prefix, method) =>
  calls.filter(([p, o]) => p.startsWith(prefix) && (o?.method || 'GET') === method);
const completionCalls = () => calls.filter(([p]) => p.includes('/completion'));

// 開到書的目錄樹，並展開第一章
async function openChapter(extra = {}) {
  const r = render(<MaterialSelector {...extra} />);
  await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
  await click(screen.getByRole('button', { name: /新大滿貫/ }));
  await flush();
  await click(screen.getByRole('button', { name: /第一章/ }));
  await flush();
  return r;
}

/* ============ 1–2. Create / Edit Plan 的 Material 選取 ============ */

describe('Create Plan Material selection', () => {
  it('草稿模式選取不打 selection API，計數即時反映', async () => {
    let ids = new Set();
    const rerender = render(<MaterialSelector draftIds={ids} onDraftChange={s => { ids = s; }} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    await click(screen.getByRole('button', { name: /新大滿貫/ }));
    await flush();
    await click(screen.getByRole('button', { name: /第一章.*展開|第一章/ }));
    await flush();
    await click(screen.getByRole('checkbox', { name: '內文A' }));
    expect([...ids]).toEqual([101]);
    // Plan 還不存在，不該對 selection API 發任何請求
    expect(sent('/plans/', 'POST')).toEqual([]);
    rerender.unmount();
  });
});

describe('Edit Plan Material selection', () => {
  it('每次點擊都寫正式 selection API，且帶正確的 content_item_id', async () => {
    await openChapter({ planId: 55 });
    await click(screen.getByRole('checkbox', { name: '內文A' }));
    await flush();
    const posts = sent('/plans/55/material-items', 'POST');
    expect(posts.length).toBe(1);
    expect(posts[0][1].body).toEqual({ content_item_ids: [101], selected: true });
  });

  it('取消選取送 selected:false，而且不碰 completion', async () => {
    treeResponse = () => {
      const t = makeTree();
      t.nodes[0].children[0].content_items[0].selected = true;
      return t;
    };
    await openChapter({ planId: 55 });
    await click(screen.getByRole('checkbox', { name: '內文A' }));
    await flush();
    expect(sent('/plans/55/material-items', 'POST')[0][1].body.selected).toBe(false);
    expect(completionCalls()).toEqual([]);
  });
});

/* ============ 3–5. selected ≠ completed ============ */

describe('selected 與 completed 完全分離', () => {
  it('已完成的項目不畫成 checkbox，而且有文字說明', async () => {
    await openChapter({ planId: 55 });
    // 內文B 已完成 → 沒有 checkbox role，只有「已完成」徽章與文字
    expect(screen.queryByRole('checkbox', { name: '內文B' })).toBeNull();
    expect(screen.getByLabelText('內文B：已完成')).toBeTruthy();
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0);
    // 未完成的才有 checkbox
    expect(screen.getByRole('checkbox', { name: '內文A' })).toBeTruthy();
  });

  it('checkbox 絕對不呼叫 completion endpoint', async () => {
    await openChapter({ planId: 55 });
    await click(screen.getByRole('checkbox', { name: '內文A' }));
    await click(screen.getByRole('checkbox', { name: '例題X' }));
    await click(screen.getByRole('checkbox', { name: '第一章（整章）' }));
    await flush();
    expect(completionCalls()).toEqual([]);
  });

  it('completion 操作不改 Plan selection', async () => {
    render(<MaterialLibraryView />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    await click(screen.getByRole('button', { name: /新大滿貫/ }));
    await flush();
    await click(screen.getByRole('button', { name: /第一章/ }));
    await flush();
    await click(screen.getByRole('checkbox', { name: /內文A：未完成/ }));
    await flush();
    expect(completionCalls().length).toBe(1);
    expect(completionCalls()[0][1].body).toEqual({ completed: true });
    // 教材庫完全不碰 Plan selection
    expect(calls.filter(([p]) => p.includes('material-items') || p.includes('material-nodes'))).toEqual([]);
  });
});

/* ============ 6–9. tri-state ============ */

describe('Chapter / Section / Topic tri-state', () => {
  it('Chapter checkbox 走 node 批次端點，不逐項送', async () => {
    await openChapter({ planId: 55 });
    await click(screen.getByRole('checkbox', { name: '第一章（整章）' }));
    await flush();
    expect(sent('/plans/55/material-nodes/10', 'POST')[0][1].body).toEqual({ selected: true });
    expect(sent('/plans/55/material-items', 'POST')).toEqual([]);
  });

  it('Section checkbox 只作用在自己的節點', async () => {
    await openChapter({ planId: 55 });
    await click(screen.getByRole('checkbox', { name: '1-1（整組）' }));
    await flush();
    expect(sent('/plans/55/material-nodes/11', 'POST').length).toBe(1);
  });

  it('Topic checkbox 只作用在自己的節點', async () => {
    await openChapter({ planId: 55 });
    await click(screen.getByRole('checkbox', { name: '主題一（整組）' }));
    await flush();
    expect(sent('/plans/55/material-nodes/12', 'POST').length).toBe(1);
  });

  it('partial 狀態呈現為 mixed，而且不只靠顏色（有 – 符號）', async () => {
    treeResponse = () => {
      const t = makeTree();
      t.nodes[0].selection = 'some';
      t.nodes[0].children[0].selection = 'some';
      t.nodes[0].children[0].content_items[0].selected = true;
      return t;
    };
    await openChapter({ planId: 55 });
    const box = screen.getByRole('checkbox', { name: '第一章（整章）' });
    expect(box.getAttribute('aria-checked')).toBe('mixed');
    expect(box.textContent).toContain('–');
  });

  it('已完成的子項目不會被 parent 批次選取重新選入（草稿模式）', () => {
    const tree = makeTree();
    // 第一章底下：101 未完成、102 已完成、105 未完成、103/104 未完成
    const ids = openItemIdsUnder(tree.nodes[0]);
    expect(ids).not.toContain(102);
    expect(ids.sort((a, b) => a - b)).toEqual([101, 103, 104, 105]);
  });

  it('全部未完成項目都選才是 all；已完成不進分母', () => {
    const t = applyDraftSelection(makeTree(), new Set([101, 103, 104, 105]));
    expect(t.nodes[0].selection).toBe('all');
    expect(t.nodes[0].children[0].selection).toBe('all');   // 節底下唯一未完成的 101
  });

  it('整組都已完成時 selection 是 none 而不是 all', () => {
    const tree = makeTree();
    tree.nodes[0].children[0].content_items[0].completed = true;
    const t = applyDraftSelection(tree, new Set());
    expect(t.nodes[0].children[0].selection).toBe('none');
  });

  it('殘留的「已完成卻仍被選取」不算進 selection', () => {
    const t = applyDraftSelection(makeTree(), new Set([102]));
    expect(t.nodes[0].children[0].selection).toBe('none');
  });
});

/* ============ 10–12. hierarchy ============ */

describe('正式 hierarchy', () => {
  it('Section 與 Topic 是 Chapter 的同層子節點，各自標示', async () => {
    await openChapter({ planId: 55 });
    expect(screen.getByText('1-1')).toBeTruthy();
    expect(screen.getByText('主題一')).toBeTruthy();
    // 主題不在節的子樹裡
    const section = screen.getByText('1-1').closest('.mt-child');
    expect(within(section).queryByText('主題一')).toBeNull();
    // 兩者都直接掛在章的展開區底下
    const chapterBody = screen.getByText('第一章').closest('.mt-chapter').querySelector('.mt-chapter-body');
    expect(chapterBody.querySelectorAll(':scope > .mt-child').length).toBe(2);
    expect(screen.getByText('節')).toBeTruthy();
    expect(screen.getByText('主題')).toBeTruthy();
  });

  it('Chapter-level 單元練習不屬於任何 Section', async () => {
    await openChapter({ planId: 55 });
    const section = screen.getByText('1-1').closest('.mt-child');
    expect(within(section).queryByText('單元練習')).toBeNull();
    expect(within(section).queryByText('歷屆試題')).toBeNull();
    const own = screen.getAllByText('單元練習')
      .find(el => el.classList.contains('mt-item-title')).closest('.mt-chapter-level');
    expect(own).toBeTruthy();
    expect(within(own).getByText('本章直屬')).toBeTruthy();
  });

  it('Chapter-level 歷屆試題同樣直接屬於 Chapter，且可獨立選取', async () => {
    await openChapter({ planId: 55 });
    const topic = screen.getByText('主題一').closest('.mt-child');
    expect(within(topic).queryByText('歷屆試題')).toBeNull();
    await click(screen.getByRole('checkbox', { name: '歷屆試題' }));
    await flush();
    expect(sent('/plans/55/material-items', 'POST')[0][1].body).toEqual(
      { content_item_ids: [104], selected: true });
  });
});

/* ============ 13–14. Category ↔ Book ============ */

describe('Category 與 Book identity', () => {
  it('Category → Book：切換分類只換篩選，不換書', async () => {
    render(<MaterialSelector planId={55} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    expect(screen.getByRole('tab', { name: '所有教材' })).toBeTruthy();
    await click(screen.getByRole('tab', { name: '第一次段考' }));
    await flush();
    expect(screen.getAllByText('新大滿貫').length).toBe(1);
  });

  it('同一本書出現在兩個分類仍是同一個 identity，不畫成兩本', async () => {
    render(<MaterialLibraryView />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    // 兩個分類都指向 book id 1 → 清單只出現一次
    expect(screen.getAllByText('新大滿貫').length).toBe(1);
    expect(screen.getByText('同時列在 2 個分類')).toBeTruthy();
    // 開啟後也只有一份進度
    await click(screen.getByRole('button', { name: /新大滿貫/ }));
    await flush();
    expect(calls.filter(([p]) => p.startsWith('/material/books/1/tree')).length).toBe(1);
    const note = document.querySelector('.ml-samebook');
    expect(note.textContent).toContain('「第一次段考」、「複習」');
    expect(note.textContent).toContain('只有一份目錄與一份完成度');
  });
});

/* ============ 15. deselect ≠ completion ============ */

describe('Edit Plan 取消選取', () => {
  it('取消選取只送 selection，教材完成度完全沒被碰到', async () => {
    treeResponse = () => {
      const t = makeTree();
      t.nodes[0].children[1].content_items[0].selected = true;
      return t;
    };
    await openChapter({ planId: 55 });
    await click(screen.getByRole('checkbox', { name: '例題X' }));
    await flush();
    expect(sent('/plans/55/material-items', 'POST')[0][1].body)
      .toEqual({ content_item_ids: [105], selected: false });
    expect(completionCalls()).toEqual([]);
  });
});

/* ============ 16. blocked reconciliation UX ============ */

describe('blocked reconciliation', () => {
  it('blocked 非空時顯示明確 UI，列出項目與下一步，且不假裝成功', async () => {
    setApi({
      '/plans/55/material-items': () => ({
        selected: [], deselected: [105],
        task_exits: {
          cancelled: [{ task_id: 1, plan_id: 2 }],
          blocked: [{ task_id: 9, plan_id: 3, error: '任務被鎖定，無法移出排程' }],
        },
      }),
    });
    treeResponse = () => {
      const t = makeTree();
      t.nodes[0].children[1].content_items[0].selected = true;
      return t;
    };
    await openChapter({ planId: 55 });
    await click(screen.getByRole('checkbox', { name: '例題X' }));
    await flush();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/有 1 項無法從目前排程移除/)).toBeTruthy();
    expect(within(alert).getByText(/任務被鎖定，無法移出排程/)).toBeTruthy();
    expect(within(alert).getByText(/沒有自動修改/)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: '保留目前安排' })).toBeTruthy();
  });

  it('collectBlocked 同時吃 reconciliation 與 task_exits 兩種來源', () => {
    const out = collectBlocked(
      { reconciliation: { blocked: [{ task_id: 1 }] } },
      { task_exits: { blocked: [{ task_id: 2 }] } },
      null,
    );
    expect(out.map(x => x.task_id)).toEqual([1, 2]);
  });

  it('blocked 為空時不顯示任何警告', async () => {
    setApi({ '/plans/55/material-items': () => ({ selected: [101], task_exits: { cancelled: [], blocked: [] } }) });
    await openChapter({ planId: 55 });
    await click(screen.getByRole('checkbox', { name: '內文A' }));
    await flush();
    expect(screen.queryByText(/無法從目前排程移除/)).toBeNull();
  });
});

/* ============ 19. legacy 不被當成正式 Material ============ */

describe('legacy 共存邊界', () => {
  it('Material selector 只讀 Material API，完全不碰 legacy toc 端點', async () => {
    await openChapter({ planId: 55 });
    expect(calls.filter(([p]) => p.includes('/import/toc'))).toEqual([]);
    expect(calls.every(([p]) => p.startsWith('/material/') || p.startsWith('/plans/'))).toBe(true);
  });
});
