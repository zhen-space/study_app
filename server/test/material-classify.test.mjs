// 教材庫分類／篩選 + 同名偵測。
//   ・listBooks 帶出分類欄位（kinds／in_use／plan_ids），並支援 server 端篩選。
//   ・name-check：同名＋同科目才算衝突（正規化空白與大小寫），供前端做
//     「合併／另存／取消」三選一——這一步不寫任何東西。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let S;
before(async () => { S = await startServer(); });
after(() => S?.stop());

const api = async (method, path, body) => {
  const r = await fetch(S.base + path, { method, headers: S.H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const ok = async (method, path, body) => {
  const r = await api(method, path, body);
  assert.ok(r.status < 400, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

// 一本書：一章 + n 個指定題型的內容。回傳 { book, itemIds }。
async function seed(title, subjectId, kinds = ['reading']) {
  const book = await ok('POST', '/material/books', { title, subject_list_id: subjectId ?? null });
  const ch = await ok('POST', '/material/nodes', { book_id: book.id, kind: 'chapter', title: '第一章' });
  const itemIds = [];
  for (const k of kinds) {
    const it = await ok('POST', '/material/content-items', { node_id: ch.id, kind: k, title: k });
    itemIds.push(it.id);
  }
  return { book, itemIds };
}

describe('教材庫分類與篩選', () => {
  test('listBooks 帶出 kinds／in_use／plan_ids', async () => {
    const subj = await ok('POST', '/lists', { name: '數學' });
    const { book, itemIds } = await seed('數學課本', subj.id, ['reading', 'unit_exercise']);
    let books = await ok('GET', '/material/books');
    let b = books.find(x => x.id === book.id);
    assert.deepEqual([...b.kinds].sort(), ['reading', 'unit_exercise']);
    assert.equal(b.in_use, false);
    assert.deepEqual(b.plan_ids, []);
    // 選進一個計畫 → in_use 變 true、plan_ids 有值
    const plan = await ok('POST', '/plans', { name: 'P', status: 'active' });
    await ok('POST', `/plans/${plan.id}/material-items`, { content_item_ids: [itemIds[0]], selected: true });
    books = await ok('GET', '/material/books');
    b = books.find(x => x.id === book.id);
    assert.equal(b.in_use, true);
    assert.deepEqual(b.plan_ids, [Number(plan.id)]);
  });

  test('篩選：subject_list_id / kind / in_use / plan_id', async () => {
    const math = await ok('POST', '/lists', { name: '數學篩選' });
    const eng = await ok('POST', '/lists', { name: '英文篩選' });
    const m = await seed('數學A', math.id, ['reading']);
    const e = await seed('英文B', eng.id, ['past_exam']);
    const plan = await ok('POST', '/plans', { name: 'PF', status: 'active' });
    await ok('POST', `/plans/${plan.id}/material-items`, { content_item_ids: [m.itemIds[0]], selected: true });

    const bySubject = await ok('GET', `/material/books?subject_list_id=${math.id}`);
    assert.ok(bySubject.every(b => Number(b.subject_list_id) === Number(math.id)));
    assert.ok(bySubject.some(b => b.id === m.book.id) && !bySubject.some(b => b.id === e.book.id));

    const byKind = await ok('GET', '/material/books?kind=past_exam');
    assert.ok(byKind.some(b => b.id === e.book.id) && !byKind.some(b => b.id === m.book.id));

    const inUse = await ok('GET', '/material/books?in_use=1');
    assert.ok(inUse.some(b => b.id === m.book.id) && !inUse.some(b => b.id === e.book.id));

    const notUsed = await ok('GET', '/material/books?in_use=0');
    assert.ok(notUsed.some(b => b.id === e.book.id) && !notUsed.some(b => b.id === m.book.id));

    const byPlan = await ok('GET', `/material/books?plan_id=${plan.id}`);
    assert.deepEqual(byPlan.map(b => b.id), [m.book.id]);
  });
});

describe('同名偵測（name-check）', () => {
  test('同名＋同科目 → 衝突；空白／大小寫正規化後也算', async () => {
    const subj = await ok('POST', '/lists', { name: '化學' });
    await seed('有機化學', subj.id);
    const hit = await ok('GET', `/material/name-check?title=${encodeURIComponent('  有機化學 ')}&subject_list_id=${subj.id}`);
    assert.equal(hit.has_conflict, true);
    assert.equal(hit.same_name_books.length, 1);
  });

  test('同名但不同科目 → 不算衝突', async () => {
    const a = await ok('POST', '/lists', { name: '科目甲' });
    const b = await ok('POST', '/lists', { name: '科目乙' });
    await seed('講義', a.id);
    const res = await ok('GET', `/material/name-check?title=${encodeURIComponent('講義')}&subject_list_id=${b.id}`);
    assert.equal(res.has_conflict, false);
  });

  test('name-check 不寫入任何東西', async () => {
    const before = await ok('GET', '/material/books');
    await ok('GET', `/material/name-check?title=${encodeURIComponent('不存在的書')}`);
    const after = await ok('GET', '/material/books');
    assert.equal(after.length, before.length);
  });
});
