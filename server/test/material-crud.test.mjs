// 教材 CRUD 與安全刪除（B5）：
//   ・rename / 改科目 / 改教材類型
//   ・刪除前 CURRENT 影響（Plan 依狀態、Task linkage、完成度、StudySession、Block）
//   ・active/paused Plan 使用中 → 擋刪除（IN_USE_BY_ACTIVE_PLAN）；unlink 後可刪
//   ・soft-delete 不 cascade：Task／完成度歷史保留
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let S, base, H;
const call = async (path, opts = {}, headers = H) => {
  const r = await fetch(base + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (p, b) => call(p, { method: 'POST', body: b ?? {} });
const patch = (p, b) => call(p, { method: 'PATCH', body: b ?? {} });
const del = p => call(p, { method: 'DELETE' });
const get = p => call(p);
before(async () => { S = await startServer(); base = S.base; H = S.H; });
after(() => S?.stop());

async function seedBook(title = '課本', subjectId = null) {
  const book = (await post('/material/books', { title, subject_list_id: subjectId })).body;
  const ch = (await post('/material/nodes', { book_id: book.id, kind: 'chapter', title: '第一章' })).body;
  const it = (await post('/material/content-items', { node_id: ch.id, kind: 'reading', title: '內文' })).body;
  return { book, ch, it };
}

describe('段考範圍投影所需欄位', () => {
  test('EX getPlanSelection 帶 book_title / chapter_title / subject', async () => {
    const s = (await post('/lists', { name: '數學' })).body;
    const book = (await post('/material/books', { title: '數學課本', subject_list_id: s.id })).body;
    const ch = (await post('/material/nodes', { book_id: book.id, kind: 'chapter', title: '第一課 力學' })).body;
    const sec = (await post('/material/nodes', { book_id: book.id, parent_id: ch.id, kind: 'section', title: '1-1 位移' })).body;
    const it = (await post('/material/content-items', { node_id: sec.id, kind: 'reading', title: '內文' })).body;
    const plan = (await post('/plans', { name: 'P', status: 'active' })).body;
    await post(`/plans/${plan.id}/material-items`, { content_item_ids: [it.id], selected: true });
    const rows = (await get(`/plans/${plan.id}/material-items`)).body;
    const row = rows.find(r => r.content_item_id === it.id);
    assert.equal(row.book_title, '數學課本');
    assert.equal(Number(row.subject_list_id), Number(s.id));
    assert.equal(row.chapter_title, '第一課 力學'); // 節往上取父章
    assert.equal(row.node_title, '1-1 位移');
  });
});

describe('教材 CRUD', () => {
  test('CRUD1 rename / 改科目 / 改教材類型', async () => {
    const s1 = (await post('/lists', { name: '數學' })).body;
    const s2 = (await post('/lists', { name: '物理' })).body;
    const { book } = await seedBook('舊名', s1.id);
    const u = await patch(`/material/books/${book.id}`, { title: '新名', subject_list_id: s2.id, book_type: '講義' });
    assert.equal(u.status, 200);
    assert.equal(u.body.title, '新名');
    assert.equal(Number(u.body.subject_list_id), Number(s2.id));
    assert.equal(u.body.book_type, '講義');
  });
});

describe('教材刪除影響與安全刪除', () => {
  test('CRUD2 impact 反映完成度／計畫（依狀態）', async () => {
    const { book, it } = await seedBook('影響書');
    await call(`/material/content-items/${it.id}/completion`, { method: 'PUT', body: { completed: true } });
    const impact = (await get(`/material/books/${book.id}/impact`)).body;
    assert.equal(impact.completion_records, 1);
    assert.ok('plans_by_status' in impact);
    assert.deepEqual(impact.blocking_plans, []);
  });

  test('CRUD3 未使用教材可直接 soft-delete，且不再出現在教材庫', async () => {
    const { book } = await seedBook('可刪');
    const r = await del(`/material/books/${book.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.soft, true);
    assert.equal((await get('/material/books')).body.some(b => b.id === book.id), false);
    assert.equal((await get(`/material/books/${book.id}/tree`)).status, 404);
  });

  test('CRUD4 active Plan 使用中 → 擋刪除；unlink 後可刪，且不 cascade Task/完成度', async () => {
    const { book, ch, it } = await seedBook('使用中');
    // 另一項標記完成（歷史），it 選入 active plan
    const it2 = (await post('/material/content-items', { node_id: ch.id, kind: 'reading', title: '練習' })).body;
    await call(`/material/content-items/${it2.id}/completion`, { method: 'PUT', body: { completed: true } });
    const plan = (await post('/plans', { name: '使用計畫', status: 'active' })).body;
    await post(`/plans/${plan.id}/material-items`, { content_item_ids: [it.id], selected: true });
    const task = (await post('/tasks', { title: '掛計畫任務', plan_id: plan.id })).body;

    // 擋刪除
    const blocked = await del(`/material/books/${book.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'IN_USE_BY_ACTIVE_PLAN');
    assert.equal(blocked.body.impact.blocking_plans.length, 1);
    assert.equal((await get(`/material/books/${book.id}/tree`)).status, 200, '擋下後書必須還在');

    // unlink 後可刪
    const ok = await del(`/material/books/${book.id}?unlink=1`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.soft, true);
    assert.equal((await get('/material/books')).body.some(b => b.id === book.id), false);

    // 不 cascade：Task 仍在、未取消／刪除
    const tasks = (await get('/tasks')).body;
    const t = (Array.isArray(tasks) ? tasks : []).find(x => x.id === task.id);
    assert.ok(t && !t.cancelled && !t.deleted, 'Task 不得被 cascade 刪除／取消');
    // Plan 選取被安全解除（selected=0），但選取列仍在（provenance）
    const sel = (await get(`/plans/${plan.id}/material-items`)).body;
    const row = sel.find(r => r.content_item_id === it.id);
    assert.ok(row && row.selected === false, 'unlink 後選取應為 false（但列保留）');
  });
});
