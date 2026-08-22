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
const { applyDraftSelection, openItemIdsUnder, collectBlocked, materialSchedulingItems }
  = await import('../tt/material');
const { applyWizardSchedule } = await import('../tt/wizardApply');

const LISTS = [{ id: 1, name: '數學', color: '#0086CC' }, { id: 2, name: '英文', color: '#e03131' }];

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
// 統一書櫃（GET /study-materials?shelf=1）：正式教材與尚未確認內容的教材同一份清單，
// 同一個形狀。前端不知道、也不需要知道哪一本原本存在哪裡。
const shelfBook = (over = {}) => ({
  source: 'material', material_book_id: 1, title: '新大滿貫', publisher: '龍騰',
  subject_list_id: 1, progress: prog(5, 1), completion_supported: true,
  requires_content_confirmation: false, selectable: true, chapter_count: 1, selected_count: 0,
  ...over,
});
const SHELF = { books: [shelfBook()], counts: { material: 1, legacy: 0 } };
// 還沒確認過內容的教材：沒有 material_book_id、沒有 progress，
// 而且標明第一次要用時得先確認一次內容。
const NEEDS_CHECK = {
  source: 'legacy', legacy_ref: { list_id: 1, book: '舊講義' }, title: '舊講義',
  publisher: '', subject_list_id: 1, completion_supported: false,
  requires_content_confirmation: true, selectable: false, chapter_count: 2,
};
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
    if (path === '/study-materials') return Promise.resolve(SHELF);
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

  it('一項都還沒完成時不寫「已完成 0／N」——那是每一列都多一組看不懂的數字', async () => {
    treeResponse = () => {
      const t = makeTree();
      // 整本都還沒開始：章、節、主題的完成數都是 0
      t.progress = prog(5, 0);
      t.nodes[0].progress = prog(5, 0);
      t.nodes[0].children[0].progress = prog(2, 0);
      t.nodes[0].children[0].content_items[1].completed = false;
      t.nodes[0].children[1].progress = prog(1, 0);
      return t;
    };
    await openChapter({ planId: 55 });
    expect(document.body.textContent).not.toMatch(/已完成 0/);
    expect([...document.querySelectorAll('.mt-progress-text')].every(e => e.textContent === '')).toBe(true);
  });

  it('有進度時才寫出來，而且寫成看得懂的話', async () => {
    await openChapter({ planId: 55 });
    // 預設的樹：整章 5 項完成 1 項、1-1 兩項完成 1 項
    const texts = [...document.querySelectorAll('.mt-progress-text')]
      .map(e => e.textContent).filter(Boolean);
    expect(texts).toContain('已完成 1／5');
    expect(texts).toContain('已完成 1／2');
    expect(document.body.textContent).not.toMatch(/\b1\/5\b/);
  });

  it('標題本身就是內容種類時，不再重複掛一個一模一樣的標籤', async () => {
    treeResponse = () => {
      const t = makeTree();
      // 學生實際會看到的樣子：這一項的名字就叫「課本內容」
      t.nodes[0].children[0].content_items = [
        item(101, '課本內容', 'reading'), item(106, '第 3 節補充', 'reading'),
      ];
      return t;
    };
    await openChapter({ planId: 55 });
    const rows = [...document.querySelectorAll('.mt-item')];
    const plain = rows.find(r => r.querySelector('.mt-item-title').textContent === '課本內容');
    expect(plain.querySelector('.mt-kind')).toBeNull();
    // 名字與種類講的不是同一件事時，種類仍然要標出來
    const other = rows.find(r => r.querySelector('.mt-item-title').textContent === '第 3 節補充');
    expect(other.querySelector('.mt-kind').textContent).toBe('課本內容');
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
  it('Step 1 完全沒有分類 UI：不切分類、不新增分類、也不讀分類 API', async () => {
    render(<MaterialSelector planId={55} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    expect(screen.queryAllByRole('tab')).toEqual([]);
    expect(screen.queryByText('所有教材')).toBeNull();
    expect(screen.queryByText('第一次段考')).toBeNull();
    expect(document.body.textContent).not.toMatch(/分類/);
    // 分類 domain 在後端還在，但第 1 步一次都不碰它
    expect(calls.filter(([p]) => p.startsWith('/material/categories'))).toEqual([]);
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
    expect(calls.every(([p]) =>
      p.startsWith('/study-materials') || p.startsWith('/material/') || p.startsWith('/plans/'))).toBe(true);
  });
});

/* ============ Subject linkage（第一輪 Audit 必修） ============ */

describe('教材的科目（Subject）', () => {
  it('新增教材時把 subject_list_id 一起送出，而且用 id 不用名稱', async () => {
    render(<MaterialLibraryView lists={LISTS} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('新增教材名稱'), { target: { value: '新書' } });
    fireEvent.change(screen.getByLabelText('科目'), { target: { value: '2' } });
    await click(screen.getByRole('button', { name: '新增' }));
    await flush();
    const post = calls.find(([p, o]) => p === '/material/books' && o?.method === 'POST');
    expect(post[1].body).toEqual({ title: '新書', subject_list_id: 2 });
    // identity 是數字 id，不得出現科目名稱
    expect(JSON.stringify(post[1].body)).not.toContain('英文');
    expect(typeof post[1].body.subject_list_id).toBe('number');
  });

  it('沒選科目時不會偷偷塞一個，欄位直接不送', async () => {
    render(<MaterialLibraryView lists={LISTS} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('新增教材名稱'), { target: { value: '沒科目的書' } });
    await click(screen.getByRole('button', { name: '新增' }));
    await flush();
    const post = calls.find(([p, o]) => p === '/material/books' && o?.method === 'POST');
    expect(post[1].body).toEqual({ title: '沒科目的書' });
  });

  it('既有教材可以補科目，走 PATCH 且送 id', async () => {
    setApi({ '/material/books': [{ ...BOOKS[0], subject_list_id: null }] });
    render(<MaterialLibraryView lists={LISTS} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    expect(screen.getByText(/需要先指定科目/)).toBeTruthy();
    await click(screen.getByRole('button', { name: /新大滿貫/ }));
    await flush();
    fireEvent.change(screen.getByLabelText('科目'), { target: { value: '1' } });
    await flush();
    const patch = calls.find(([p, o]) => p === '/material/books/1' && o?.method === 'PATCH');
    expect(patch[1].body).toEqual({ subject_list_id: 1 });
  });

  it('沒有科目的教材在 selector 第一層就標示出來，不是排到最後才失敗', async () => {
    setApi({ '/study-materials': { books: [shelfBook({ subject_list_id: null })], counts: {} } });
    render(<MaterialSelector planId={55} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    expect(screen.getByText('需要先指定科目')).toBeTruthy();
  });

  it('打開沒有科目的教材時，選取被鎖住並說明原因', async () => {
    setApi({ '/study-materials': { books: [shelfBook({ subject_list_id: null })], counts: {} } });
    render(<MaterialSelector planId={55} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    await click(screen.getByRole('button', { name: /新大滿貫/ }));
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(/還沒有指定科目/);
    await click(screen.getByRole('button', { name: /第一章/ }));
    await flush();
    // 所有選取框都是 disabled，點了也不會送出任何 selection
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every(b => b.disabled)).toBe(true);
    boxes.forEach(b => b.click());
    await flush();
    expect(sent('/plans/55/material-items', 'POST')).toEqual([]);
    expect(sent('/plans/55/material-nodes/', 'POST')).toEqual([]);
  });
});

describe('materialSchedulingItems（Material → 排程項目）', () => {
  const picked = [
    { id: 101, title: '內文A', kind: 'reading', estimated_minutes: 45, book_id: 1, book_title: '新大滿貫', path: ['第一章', '1-1'] },
    { id: 105, title: '例題X', kind: 'example', estimated_minutes: null, book_id: 1, book_title: '新大滿貫', path: ['第一章', '主題一'] },
  ];

  it('subject 用正式的 lists.id，不是名稱', () => {
    const { items, blocked } = materialSchedulingItems(picked, BOOKS, LISTS);
    expect(blocked).toEqual([]);
    expect(items.map(i => i.subject_id)).toEqual([1, 1]);
    expect(items.every(i => typeof i.subject_id === 'number')).toBe(true);
    expect(items[0].name).toBe('數學');       // 名稱只用於顯示
    expect(items[0].color).toBe('#0086CC');
  });

  it('linkage 不會遺失：每一項都帶得上 material_content_item_id', () => {
    const { items } = materialSchedulingItems(picked, BOOKS, LISTS);
    expect(items.map(i => i.material_content_item_id)).toEqual([101, 105]);
    expect(items.map(i => i.key)).toEqual(['mat-101', 'mat-105']);
  });

  it('沒有科目的書進 blocked，不會靜默變成無科目項目', () => {
    const noSubject = [{ ...BOOKS[0], subject_list_id: null }];
    const { items, blocked } = materialSchedulingItems(picked, noSubject, LISTS);
    expect(items).toEqual([]);
    expect(blocked).toEqual([{ book_id: 1, book_title: '新大滿貫', count: 2 }]);
  });

  it('科目改了之後，同一批選取會產生新的 subject_id', () => {
    const moved = [{ ...BOOKS[0], subject_list_id: 2 }];
    const { items } = materialSchedulingItems(picked, moved, LISTS);
    expect(items.map(i => i.subject_id)).toEqual([2, 2]);
    expect(items[0].name).toBe('英文');
  });

  it('estimated_minutes 有值就用它，沒有才退回預設', () => {
    const { items } = materialSchedulingItems(picked, BOOKS, LISTS);
    expect(items.map(i => i.minutes)).toEqual([45, 60]);
  });

  it('標題只是顯示用組字，identity 仍是 content_item_id', () => {
    const { items } = materialSchedulingItems(picked, BOOKS, LISTS);
    expect(items[0].title).toBe('新大滿貫｜第一章｜1-1｜內文A');
    expect(items[0].material_content_item_id).toBe(101);
  });
});

describe('Material-backed Task 的最終 subject 與 linkage', () => {
  it('建立計畫時，task_creates 同時帶正確的 subject（list_id）與 material linkage', async () => {
    setApi({ '/plans': { id: 99 } });
    const { items } = materialSchedulingItems(
      [{ id: 101, title: '內文A', kind: 'reading', estimated_minutes: 45, book_id: 1,
        book_title: '新大滿貫', path: ['第一章', '1-1'] }], BOOKS, LISTS);
    // preview 回來的 block 保留 subject_id 與 title
    const blocks = items.map(it => ({
      subject_id: it.subject_id, title: it.title, date: '2026-09-01', minutes: it.minutes,
    }));
    const materialByBlock = Object.fromEntries(
      items.map(it => [`${it.subject_id}|${it.title}`, it.material_content_item_id]));

    await applyWizardSchedule({ mode: 'create', name: '教材計畫', blocks, materialByBlock });

    const apply = calls.find(([p, o]) => p === '/schedule/apply' && o?.method === 'POST');
    const created = apply[1].body.task_creates;
    expect(created.length).toBe(1);
    expect(created[0].list_id).toBe(1);                        // 正式 subject id
    expect(created[0].material_content_item_id).toBe(101);     // 正式 material linkage
  });

  it('Manual Task（沒有 material linkage）不受影響，material 欄位為 null', async () => {
    setApi({ '/plans': { id: 99 } });
    const blocks = [{ subject_id: 2, title: '自己整理的錯題本', date: '2026-09-02' }];
    await applyWizardSchedule({ mode: 'create', name: '手動計畫', blocks, materialByBlock: {} });
    const apply = calls.find(([p, o]) => p === '/schedule/apply' && o?.method === 'POST');
    const created = apply[1].body.task_creates;
    expect(created[0].list_id).toBe(2);
    expect(created[0].material_content_item_id).toBeNull();
  });

  it('同一批裡教材任務與手動任務並存時，只有教材那筆帶 linkage', async () => {
    setApi({ '/plans': { id: 99 } });
    const blocks = [
      { subject_id: 1, title: '新大滿貫｜第一章｜1-1｜內文A', date: '2026-09-01' },
      { subject_id: 1, title: '自己加的複習', date: '2026-09-02' },
    ];
    await applyWizardSchedule({
      mode: 'create', name: '混合計畫', blocks,
      materialByBlock: { '1|新大滿貫｜第一章｜1-1｜內文A': 101 },
    });
    const created = calls.find(([p, o]) => p === '/schedule/apply' && o?.method === 'POST')[1].body.task_creates;
    expect(created.map(c => c.material_content_item_id)).toEqual([101, null]);
    expect(created.every(c => c.list_id === 1)).toBe(true);
  });
});

/* ============ 編輯教材：打錯字要有得救 ============ */

describe('編輯教材', () => {
  const openEditor = async () => {
    render(<MaterialLibraryView lists={LISTS} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    await click(screen.getByRole('button', { name: /新大滿貫/ }));
    await flush();
    await click(screen.getByRole('button', { name: '編輯' }));
    await flush();
  };

  it('章／節／主題與內容項目都改得動，離開欄位才送出', async () => {
    await openEditor();
    const input = screen.getByLabelText('第一章 的名稱');
    fireEvent.change(input, { target: { value: '第 1 章 力學' } });
    // 打字當下不打 API——每敲一個字送一次會讓游標跳掉
    expect(sent('/material/nodes/', 'PATCH')).toEqual([]);
    fireEvent.blur(input);
    await flush();
    const patch = sent('/material/nodes/10', 'PATCH');
    expect(patch.length).toBe(1);
    expect(patch[0][1].body).toEqual({ title: '第 1 章 力學' });
  });

  it('內容種類改得動，而且只在同一層裡換', async () => {
    await openEditor();
    // 節底下的內文只能在課本內容／範例／例題之間換
    const sel = screen.getByLabelText('內文A 的內容種類');
    expect([...sel.options].map(o => o.textContent)).toEqual(['課本內容', '範例', '例題']);
    fireEvent.change(sel, { target: { value: 'example_problem' } });
    await flush();
    expect(sent('/material/content-items/101', 'PATCH')[0][1].body).toEqual({ kind: 'example_problem' });
    // 章底下的單元練習只在單元練習／歷屆試題之間換
    expect([...screen.getByLabelText('單元練習 的內容種類').options].map(o => o.textContent))
      .toEqual(['單元練習', '歷屆試題']);
  });

  it('編輯模式不出現完成度勾選框——改名字不該有機會誤按成已完成', async () => {
    await openEditor();
    expect(screen.queryByLabelText(/點擊標記完成/)).toBeNull();
    expect(completionCalls()).toEqual([]);
  });

  it('名字沒真的改就不送出，也不會送空白名稱', async () => {
    await openEditor();
    const input = screen.getByLabelText('第一章 的名稱');
    fireEvent.blur(input);                                  // 完全沒動
    fireEvent.change(input, { target: { value: '   ' } });   // 只有空白
    fireEvent.blur(input);
    await flush();
    expect(sent('/material/nodes/', 'PATCH')).toEqual([]);
  });

  it('刪不掉的時候說出原因，不是只說失敗', async () => {
    setApi({
      '/material/content-items/101': () => {
        const e = new Error('這個項目已經有使用紀錄（完成度、計畫選取或任務），不能刪除');
        e.status = 409;
        e.payload = { references: { progress: 1, plan_selections: 0, tasks: 2 } };
        return Promise.reject(e);
      },
    });
    await openEditor();
    await click(screen.getByRole('button', { name: '刪除 內文A' }));
    await flush();
    const msg = screen.getByRole('alert').textContent;
    expect(msg).toContain('已經標記完成');
    expect(msg).toContain('已經排進任務');
    expect(msg).not.toContain('正被計畫選取');
  });

  it('乾淨的項目刪得掉，走的是正式 DELETE', async () => {
    await openEditor();
    await click(screen.getByRole('button', { name: '刪除 內文A' }));
    await flush();
    expect(sent('/material/content-items/101', 'DELETE').length).toBe(1);
  });
});
