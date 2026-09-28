// 教材合併／增補目錄：
//   ・純 preview 分類（新增/已存在/疑似重複），順序 fail-closed，fingerprint。
//   ・apply（HTTP）：保留完成度／Plan 選取／Task linkage、不重建既有章節、
//     stale fingerprint 擋下、疑似重複與不可靠順序未確認擋下且不寫入（atomic）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { previewTocMerge, bookFingerprint } from '../src/material/merge.js';

/* ---------------- 純 preview（無 DB） ---------------- */

const existing = {
  nodes: [
    { id: 1, parent_id: null, kind: 'chapter', title: '第一課 力學', order_index: 0 },
    { id: 2, parent_id: null, kind: 'chapter', title: '第二課 熱學', order_index: 1 },
  ],
  items: [{ id: 11, node_id: 1, kind: 'reading', title: '1-1 內文', order_index: 0 }],
};
const draftOf = chapters => ({ book: { title: 'x' }, chapters });

describe('previewTocMerge', () => {
  test('MG1 已存在章、章內新增內容、全新章', () => {
    const p = previewTocMerge(existing, draftOf([
      { title: '第一課 力學', content_items: [{ title: '1-1 內文', kind: 'reading' }, { title: '1-2 例題', kind: 'reading' }], children: [] },
      { title: '第三課 光學', content_items: [{ title: '3-1', kind: 'reading' }], children: [] },
    ]));
    const ch1 = p.chapters[0];
    assert.equal(ch1.status, 'exists');
    assert.equal(ch1.items[0].status, 'exists');
    assert.equal(ch1.items[1].status, 'new');
    assert.equal(p.chapters[1].status, 'new');
    assert.equal(p.order_status, 'ok'); // 第三課序數可靠
  });

  test('MG2 疑似重複：同序數不同名', () => {
    const p = previewTocMerge(existing, draftOf([
      { title: '第二課 熱與能', content_items: [], children: [] }, // 與「第二課 熱學」同序數
    ]));
    assert.equal(p.chapters[0].status, 'suspected_duplicate');
    assert.equal(p.has_suspected_duplicates, true);
  });

  test('MG3 新章序數不可靠 → ORDER_CONFIRMATION_REQUIRED', () => {
    const p = previewTocMerge(existing, draftOf([
      { title: '總複習', content_items: [{ title: 'r', kind: 'reading' }], children: [] },
    ]));
    assert.equal(p.order_status, 'ORDER_CONFIRMATION_REQUIRED');
  });

  test('MG4 fingerprint 隨樹改變', () => {
    const fp1 = bookFingerprint(existing.nodes, existing.items);
    const fp2 = bookFingerprint(existing.nodes, [...existing.items, { id: 99, node_id: 1, kind: 'reading', title: 'z', order_index: 1 }]);
    assert.notEqual(fp1, fp2);
  });
});

/* ---------------- apply（HTTP） ---------------- */

let S, base, H, other;
const call = async (path, opts = {}, headers = H) => {
  const r = await fetch(base + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (p, b) => call(p, { method: 'POST', body: b ?? {} });
const get = p => call(p);
before(async () => { S = await startServer(); base = S.base; H = S.H; other = (await S.secondUser()).H; });
after(() => S?.stop());

// 一本書：一章「第一課」+ 一個 reading。回傳 ids。
async function seedBook() {
  const book = (await post('/material/books', { title: '物理課本', subject_list_id: null })).body;
  const ch = (await post('/material/nodes', { book_id: book.id, kind: 'chapter', title: '第一課 力學' })).body;
  const it = (await post('/material/content-items', { node_id: ch.id, kind: 'reading', title: '1-1 內文' })).body;
  return { book, ch, it };
}
const treeItems = tree => {
  const out = [];
  const walk = ns => ns.forEach(n => { (n.content_items || []).forEach(i => out.push(i)); walk(n.children || []); });
  walk(tree.nodes || []);
  return out;
};

describe('applyBookMerge：保留與安全', () => {
  test('MG5 增補目錄：新增章與內容，既有完成度／Plan 選取／Task linkage 保留', async () => {
    const { book, ch, it } = await seedBook();
    // 另一個內容用來驗「選取＋Task linkage 保留」（已完成的內容不能被選取，故分開兩項）
    const it2 = (await post('/material/content-items', { node_id: ch.id, kind: 'reading', title: '1-1b 練習' })).body;
    // it：標記完成（驗完成度保留）
    await call(`/material/content-items/${it.id}/completion`, { method: 'PUT', body: { completed: true } });
    // it2：選入計畫（驗選取保留）。另建一個直接掛在計畫的 Task，驗 merge 不動 Task。
    const plan = (await post('/plans', { name: 'P', status: 'active' })).body;
    await post(`/plans/${plan.id}/material-items`, { content_item_ids: [it2.id], selected: true });
    const task0 = (await post('/tasks', { title: '既有任務', plan_id: plan.id })).body;

    // preview 增補：第一課新增一節 + 全新第二課
    const draft = draftOf([
      { title: '第一課 力學', content_items: [{ title: '1-2 進階', kind: 'reading' }], children: [] },
      { title: '第二課 熱學', content_items: [{ title: '2-1', kind: 'reading' }], children: [] },
    ]);
    const pv = await post(`/material/books/${book.id}/merge/preview`, { draft });
    assert.equal(pv.status, 200);
    assert.equal(pv.body.order_status, 'ok');

    const ap = await post(`/material/books/${book.id}/merge`, { draft, expected_fingerprint: pv.body.fingerprint });
    assert.equal(ap.status, 201, JSON.stringify(ap.body));

    // 既有完成度保留
    const tree = (await get(`/material/books/${book.id}/tree`)).body;
    const items = treeItems(tree);
    const orig = items.find(i => i.id === it.id);
    assert.ok(orig && orig.completed === true, '既有完成度必須保留');
    // 沒有重複建立「第一課」：只有兩章
    assert.equal((tree.nodes || []).length, 2);
    // 新內容存在
    assert.ok(items.some(i => i.title === '1-2 進階'));
    assert.ok(items.some(i => i.title === '2-1'));
    // Plan 選取保留（it2）
    const sel1 = (await get(`/plans/${plan.id}/material-items`)).body;
    const row = sel1.find(r => r.content_item_id === it2.id);
    assert.ok(row && row.selected === true, 'Plan 選取必須保留');
    // merge 不得動 Task：既有任務仍在、未被取消／刪除
    const tasks = (await get('/tasks')).body;
    const t1 = (Array.isArray(tasks) ? tasks : []).find(t => t.id === task0.id);
    assert.ok(t1 && !t1.cancelled && !t1.deleted, 'Task 必須原樣保留');
  });

  test('MG6 stale fingerprint → 409，且不寫入', async () => {
    const { book } = await seedBook();
    const draft = draftOf([{ title: '第九課 新', content_items: [{ title: 'n', kind: 'reading' }], children: [] }]);
    const before = (await get(`/material/books/${book.id}/tree`)).body.nodes.length;
    const ap = await post(`/material/books/${book.id}/merge`, { draft, expected_fingerprint: 'STALE' });
    assert.equal(ap.status, 409);
    const after = (await get(`/material/books/${book.id}/tree`)).body.nodes.length;
    assert.equal(after, before, '拒絕時不得寫入');
  });

  test('MG7 疑似重複未確認 → 409 DUPLICATE_CONFIRMATION_REQUIRED，不寫入；確認後寫入', async () => {
    const { book } = await seedBook();
    const draft = draftOf([{ title: '第一課 力學導論', content_items: [{ title: 'x', kind: 'reading' }], children: [] }]); // 與第一課同序數
    const pv = await post(`/material/books/${book.id}/merge/preview`, { draft });
    assert.equal(pv.body.has_suspected_duplicates, true);
    const rej = await post(`/material/books/${book.id}/merge`, { draft, expected_fingerprint: pv.body.fingerprint });
    assert.equal(rej.status, 409);
    assert.equal(rej.body.code, 'DUPLICATE_CONFIRMATION_REQUIRED');
    assert.equal((await get(`/material/books/${book.id}/tree`)).body.nodes.length, 1);
    // 確認後另建新章
    const ok = await post(`/material/books/${book.id}/merge`, { draft, expected_fingerprint: pv.body.fingerprint, confirm_duplicates: true, confirm_order: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await get(`/material/books/${book.id}/tree`)).body.nodes.length, 2);
  });

  test('MG9 跨使用者：別人不能 preview／merge 我的教材（ownership / IDOR）', async () => {
    const { book } = await seedBook();
    const draft = draftOf([{ title: '第九課', content_items: [{ title: 'x', kind: 'reading' }], children: [] }]);
    const pv = await call(`/material/books/${book.id}/merge/preview`, { method: 'POST', body: { draft } }, other);
    assert.equal(pv.status, 404);
    const ap = await call(`/material/books/${book.id}/merge`, { method: 'POST', body: { draft, confirm_order: true } }, other);
    assert.equal(ap.status, 404);
    // 我的書沒有被動到
    assert.equal((await get(`/material/books/${book.id}/tree`)).body.nodes.length, 1);
  });

  test('MG8 不可靠順序未確認 → 409 ORDER_CONFIRMATION_REQUIRED', async () => {
    const { book } = await seedBook();
    const draft = draftOf([{ title: '總複習', content_items: [{ title: 'r', kind: 'reading' }], children: [] }]);
    const pv = await post(`/material/books/${book.id}/merge/preview`, { draft });
    assert.equal(pv.body.order_status, 'ORDER_CONFIRMATION_REQUIRED');
    const rej = await post(`/material/books/${book.id}/merge`, { draft, expected_fingerprint: pv.body.fingerprint });
    assert.equal(rej.status, 409);
    assert.equal(rej.body.code, 'ORDER_CONFIRMATION_REQUIRED');
    // 確認順序後可寫入（附在最後）
    const ok = await post(`/material/books/${book.id}/merge`, { draft, expected_fingerprint: pv.body.fingerprint, confirm_order: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });
});
