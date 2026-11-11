// 段考計畫「調整」的原子契約：不是新建另一份 Plan，也不是前端串多支 API。
// preview 與 PUT 都帶 plan_id；PUT 在同一交易內更新 scope/task/version。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { day, startServer } from './helpers.mjs';

let S, base, H;
const call = async (path, opts = {}) => {
  const r = await fetch(base + path, {
    ...opts, headers: H,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (path, body) => call(path, { method: 'POST', body });
const patch = (path, body) => call(path, { method: 'PATCH', body });
const get = path => call(path);
const preview = body => post('/exam-plans/preview', body);
const create = async body => {
  const pv = await preview(body);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  return post('/exam-plans', { ...body, preview_token: pv.body.preview_token });
};
const update = (planId, body, token) => call(`/exam-plans/${planId}`, {
  method: 'PUT', body: { ...body, preview_token: token },
});

before(async () => { S = await startServer(); base = S.base; H = S.H; });
after(() => S?.stop());

async function subject(name) { return (await post('/lists', { name })).body; }
async function item(subjectId, title) {
  const book = (await post('/material/books', { title: `${title}課本`, subject_list_id: subjectId })).body;
  const node = (await post('/material/nodes', { book_id: book.id, kind: 'chapter', title })).body;
  return (await post('/material/content-items', {
    node_id: node.id, kind: 'reading', title: `${title}內容`, estimated_minutes: 30,
  })).body;
}

describe('PUT /exam-plans/:id（原子調整）', () => {
  test('保留相同 scope 的 task id/完成狀態；移除項取消但不刪除；新 scope 才建 task', async () => {
    const math = await subject('數學-update-keep');
    const keep = await item(math.id, '保留');
    const remove = await item(math.id, '移除');
    const added = await item(math.id, '新增');
    const initial = {
      name: '第二次段考', start_date: day(0), end_date: day(12), level: 'daily',
      subjects: [{ subject_list_id: math.id, exam_date: day(10) }],
      material_scope: [keep.id, remove.id], manual_scope: [],
    };
    const made = await create(initial);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const planId = made.body.plan.id;
    const beforeTasks = (await get('/tasks')).body.filter(t => Number(t.plan_id) === Number(planId));
    const keptBefore = beforeTasks.find(t => Number(t.material_content_item_id) === Number(keep.id));
    const removedBefore = beforeTasks.find(t => Number(t.material_content_item_id) === Number(remove.id));
    assert.ok(keptBefore && removedBefore);
    assert.equal((await patch(`/tasks/${keptBefore.id}`, { completed: true })).status, 200);

    const changed = { ...initial, plan_id: planId, name: '第二次段考（調整）',
      material_scope: [keep.id, added.id] };
    const pv = await preview(changed);
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    const saved = await update(planId, changed, pv.body.preview_token);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.plan.id, planId, '必須更新原 Plan，不能偷建新 Plan');

    const afterTasks = (await get('/tasks')).body.filter(t => Number(t.plan_id) === Number(planId));
    const keptAfter = afterTasks.find(t => Number(t.material_content_item_id) === Number(keep.id));
    const removedAfter = afterTasks.find(t => Number(t.id) === Number(removedBefore.id));
    const addedAfter = afterTasks.find(t => Number(t.material_content_item_id) === Number(added.id));
    assert.equal(keptAfter.id, keptBefore.id, '相同 scope 不能換 task id');
    assert.equal(Boolean(keptAfter.completed), true, '已完成歷史不能被重置');
    assert.equal(Boolean(removedAfter.cancelled), true, '移除的未完成 task 要安全取消');
    assert.ok(removedAfter.cancelled_at, '取消結果必須有時間戳，不能只改 boolean');
    assert.equal(Boolean(removedAfter.deleted), false, '移除不等於刪除歷史');
    assert.ok(addedAfter?.id && addedAfter.id !== keptBefore.id && addedAfter.id !== removedBefore.id);

    const selections = (await get(`/plans/${planId}/material-items`)).body;
    assert.equal(selections.find(x => Number(x.content_item_id) === Number(keep.id)).selected, true);
    const deselected = selections.find(x => Number(x.content_item_id) === Number(remove.id));
    assert.equal(deselected.selected, false);
    assert.ok(deselected.removed_at, '取消選取必須留 tombstone');
    assert.equal(selections.find(x => Number(x.content_item_id) === Number(added.id)).selected, true);
  });

  test('stale preview 不可部分寫入；同一 token 重送不可重複建 task/version', async () => {
    const math = await subject('數學-update-stale');
    const first = await item(math.id, '原範圍');
    const second = await item(math.id, '新範圍');
    const initial = { name: '可重排段考', start_date: day(0), end_date: day(15), level: 'daily',
      subjects: [{ subject_list_id: math.id }], material_scope: [first.id], manual_scope: [] };
    const made = await create(initial);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const planId = made.body.plan.id;
    const changed = { ...initial, plan_id: planId, material_scope: [first.id, second.id] };
    const pv = await preview(changed);
    assert.equal(pv.status, 200, JSON.stringify(pv.body));

    const firstSave = await update(planId, changed, pv.body.preview_token);
    assert.equal(firstSave.status, 200, JSON.stringify(firstSave.body));
    const taskIds = (await get('/tasks')).body.filter(t => Number(t.plan_id) === Number(planId)).map(t => t.id).sort();
    const replay = await update(planId, changed, pv.body.preview_token);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual((await get('/tasks')).body.filter(t => Number(t.plan_id) === Number(planId)).map(t => t.id).sort(), taskIds,
      '重送同一份確認不得產生第二組 task');

    // 舊 token 簽的是上一個 CURRENT world；即使 body 形狀一樣也必須 fail closed。
    const stale = await update(planId, { ...changed, name: '不應寫入的名稱' }, pv.body.preview_token);
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const projection = await get(`/plans/${planId}/exam`);
    assert.notEqual(projection.body.plan.name, '不應寫入的名稱');
    assert.deepEqual((await get('/tasks')).body.filter(t => Number(t.plan_id) === Number(planId)).map(t => t.id).sort(), taskIds);
  });
});
