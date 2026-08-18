// Phase 2A：Plan domain 的回歸測試。
// 契約見 docs/phase2-plan-domain.md。重點守的是這幾條：
//   - Plan ≠ 科目：一個 Plan 可以跨科目，一個科目可以有多個 Plan
//   - 進度一律現算，不存在 plans 表
//   - 封存不刪任務
//   - 刪除任務只作用在該計畫自己身上（跨 Plan 防誤刪 ← 阻斷級要求）
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, today, day } from './helpers.mjs';

let S, H, base;
const api = async (path, opts = {}) => {
  const r = await fetch(base + path, {
    ...opts, headers: H,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
};
const mkPlan = (over = {}) => api('/plans', { method: 'POST', body: { name: '測試計畫', ...over } });
const mkTask = (over = {}) => api('/tasks', { method: 'POST', body: { title: '測試任務', ...over } });

before(async () => { S = await startServer(); H = S.H; base = S.base.replace(/\/api$/, '/api'); });
after(() => S?.stop());

describe('Plan CRUD', () => {
  test('建立後讀得回來，進度從任務現算', async () => {
    const { status, body: p } = await mkPlan({ name: '第二次段考準備', start_date: day(0), target_date: day(20) });
    assert.equal(status, 200);
    assert.equal(p.name, '第二次段考準備');
    assert.equal(p.status, 'draft');          // 預設 draft
    assert.equal(p.source, 'manual');
    assert.ok(p.id);

    await mkTask({ title: 'A', plan_id: p.id });
    const t2 = await mkTask({ title: 'B', plan_id: p.id });
    await api(`/tasks/${t2.body.id}`, { method: 'PATCH', body: { completed: true } });

    const list = await api('/plans');
    const got = list.body.find(x => x.id === p.id);
    assert.equal(got.task_count, 2);
    assert.equal(got.completed_task_count, 1);
    // 進度不該被存進 plans 表
    assert.equal('progress_percent' in got, false);
  });

  test('GET /plans/:id 回 plan + tasks + summary', async () => {
    const { body: p } = await mkPlan({ name: '明細測試' });
    await mkTask({ title: '未完成', plan_id: p.id, due_date: day(-2) });   // 逾期
    const done = await mkTask({ title: '完成', plan_id: p.id });
    await api(`/tasks/${done.body.id}`, { method: 'PATCH', body: { completed: true } });

    const { body } = await api(`/plans/${p.id}`);
    assert.equal(body.plan.id, p.id);
    assert.equal(body.tasks.length, 2);
    assert.deepEqual(body.summary, {
      total_tasks: 2, completed_tasks: 1, remaining_tasks: 1, overdue_tasks: 1,
    });
  });

  test('PATCH 只吃白名單欄位，server 自有的欄位改不動', async () => {
    const { body: p } = await mkPlan();
    const { body: after } = await api(`/plans/${p.id}`, {
      method: 'PATCH',
      body: { name: '改過的名字', source: 'ai', user_id: 999, created_at: '1999-01-01' },
    });
    assert.equal(after.name, '改過的名字');
    assert.equal(after.source, 'manual');            // source 由 server 決定
    assert.equal(after.created_at, p.created_at);    // created_at 動不了
  });

  test('找不到的計畫回 404', async () => {
    assert.equal((await api('/plans/999999')).status, 404);
    assert.equal((await api('/plans/999999', { method: 'PATCH', body: { name: 'x' } })).status, 404);
  });
});

describe('Plan 驗證', () => {
  test('名稱必填', async () => {
    const r = await mkPlan({ name: '   ' });
    assert.equal(r.status, 400);
  });
  test('狀態必須是合法 enum', async () => {
    assert.equal((await mkPlan({ status: '亂寫' })).status, 400);
  });
  test('結束日不能早於開始日', async () => {
    assert.equal((await mkPlan({ start_date: day(10), target_date: day(3) })).status, 400);
  });
  test('primary_list_id 必須是自己的科目', async () => {
    assert.equal((await mkPlan({ primary_list_id: 987654 })).status, 400);
  });
});

describe('Plan 生命週期', () => {
  test('complete：有未完成任務時先回報，force 才真的完成', async () => {
    const { body: p } = await mkPlan();
    await mkTask({ title: '還沒做', plan_id: p.id });

    const first = await api(`/plans/${p.id}/complete`, { method: 'POST', body: {} });
    assert.equal(first.body.needs_confirm, true);
    assert.equal(first.body.unresolved.length, 1);
    assert.equal(first.body.plan.status, 'draft');        // 還沒真的改狀態

    const second = await api(`/plans/${p.id}/complete`, { method: 'POST', body: { force: true } });
    assert.equal(second.body.plan.status, 'completed');
    assert.ok(second.body.plan.completed_at);
  });

  test('archive 不刪任何任務，restore 拉得回來', async () => {
    const { body: p } = await mkPlan({ status: 'active' });
    const t = await mkTask({ title: '封存後還要在', plan_id: p.id });

    const arch = await api(`/plans/${p.id}/archive`, { method: 'POST', body: {} });
    assert.equal(arch.body.status, 'archived');
    assert.ok(arch.body.archived_at);

    // 任務還在，plan_id 也沒被清掉
    const tasks = await api('/tasks');
    const still = tasks.body.find(x => x.id === t.body.id);
    assert.ok(still, '封存不應該刪掉任務');
    assert.equal(still.plan_id, p.id);

    const rest = await api(`/plans/${p.id}/restore`, { method: 'POST', body: {} });
    assert.equal(rest.body.status, 'active');
    assert.equal(rest.body.archived_at, null);          // 離開封存要清掉時間戳
  });

  test('只有封存的計畫可以 restore', async () => {
    const { body: p } = await mkPlan({ status: 'active' });
    assert.equal((await api(`/plans/${p.id}/restore`, { method: 'POST', body: {} })).status, 400);
  });

  test('離開 completed 會清掉 completed_at', async () => {
    const { body: p } = await mkPlan({ status: 'completed' });
    assert.ok(p.completed_at);
    const { body: back } = await api(`/plans/${p.id}`, { method: 'PATCH', body: { status: 'active' } });
    assert.equal(back.completed_at, null);
  });

  test('封存的計畫預設不出現在清單，includeArchived 才出現', async () => {
    const { body: p } = await mkPlan({ name: '被封存的' });
    await api(`/plans/${p.id}/archive`, { method: 'POST', body: {} });
    const plain = await api('/plans');
    assert.equal(plain.body.some(x => x.id === p.id), false);
    const all = await api('/plans?includeArchived=1');
    assert.equal(all.body.some(x => x.id === p.id), true);
  });
});

describe('Task ↔ Plan', () => {
  test('任務可以沒有 Plan', async () => {
    const { body: t } = await mkTask({ title: '買筆' });
    assert.equal(t.plan_id, null);
  });

  test('不能掛到不存在的計畫', async () => {
    assert.equal((await mkTask({ title: 'x', plan_id: 999999 })).status, 400);
  });

  test('不能掛到已封存或已完成的計畫', async () => {
    const { body: arch } = await mkPlan({ status: 'archived' });
    assert.equal((await mkTask({ title: 'x', plan_id: arch.id })).status, 400);
    const { body: done } = await mkPlan({ status: 'completed' });
    assert.equal((await mkTask({ title: 'x', plan_id: done.id })).status, 400);
  });

  test('deadline_date 與 due_date 是不同欄位，各自存得住', async () => {
    const { body: p } = await mkPlan();
    const { body: t } = await mkTask({ title: '有截止日', plan_id: p.id, due_date: day(3), deadline_date: day(9) });
    assert.equal(t.due_date, day(3));
    assert.equal(t.deadline_date, day(9));
    // 改排定日期不會動到截止日
    // （PATCH /tasks/:id 回的是 { ok, earned } 不是任務本身，所以要重抓）
    await api(`/tasks/${t.id}`, { method: 'PATCH', body: { due_date: day(5) } });
    const t2 = (await api('/tasks')).body.find(x => x.id === t.id);
    assert.equal(t2.due_date, day(5));
    assert.equal(t2.deadline_date, day(9));
  });

  test('一個 Plan 可以跨科目（Plan ≠ 科目）', async () => {
    const l1 = await api('/lists', { method: 'POST', body: { name: '數學' } });
    const l2 = await api('/lists', { method: 'POST', body: { name: '英文' } });
    const { body: p } = await mkPlan({ name: '第二次段考準備', primary_list_id: l1.body.id });
    await mkTask({ title: '數學 Ch3', plan_id: p.id, list_id: l1.body.id });
    await mkTask({ title: '英文 U5', plan_id: p.id, list_id: l2.body.id });

    const { body } = await api(`/plans/${p.id}`);
    assert.equal(body.tasks.length, 2);
    assert.equal(new Set(body.tasks.map(t => t.list_id)).size, 2, '同一個 Plan 底下要能有不同科目的任務');
  });

  test('一個科目可以有多個 Plan', async () => {
    const l = await api('/lists', { method: 'POST', body: { name: '物理' } });
    const a = await mkPlan({ name: '物理段考', primary_list_id: l.body.id });
    const b = await mkPlan({ name: '物理競賽', primary_list_id: l.body.id });
    assert.notEqual(a.body.id, b.body.id);
    const list = await api('/plans');
    const same = list.body.filter(x => x.primary_list_id === l.body.id);
    assert.ok(same.length >= 2, '同一科目底下要能同時存在多個 Plan');
  });

  test('bulk 建立也帶得動 plan_id / deadline_date', async () => {
    const { body: p } = await mkPlan();
    const r = await api('/tasks/bulk', {
      method: 'POST',
      body: { tasks: [
        { title: '批次A', plan_id: p.id, due_date: day(1), deadline_date: day(6) },
        { title: '批次B', plan_id: p.id, due_date: day(2) },
      ] },
    });
    assert.equal(r.body.added, 2);
    const { body } = await api(`/plans/${p.id}`);
    assert.equal(body.tasks.length, 2);
    assert.equal(body.tasks.find(t => t.title === '批次A').deadline_date, day(6));
  });

  test('bulk 掛到已封存的計畫要被擋下來', async () => {
    const { body: p } = await mkPlan({ status: 'archived' });
    const r = await api('/tasks/bulk', { method: 'POST', body: { tasks: [{ title: 'x', plan_id: p.id }] } });
    assert.equal(r.status, 400);
  });
});

describe('Plan-scoped 刪除（跨 Plan 防誤刪）', () => {
  test('只刪自己計畫的未完成任務，別的計畫一根寒毛都不能動', async () => {
    const { body: A } = await mkPlan({ name: '計畫A' });
    const { body: B } = await mkPlan({ name: '計畫B' });

    // A：一筆未完成、一筆已完成
    const a1 = await mkTask({ title: 'A-未完成', plan_id: A.id, tags: ['讀書計劃'] });
    const a2 = await mkTask({ title: 'A-已完成', plan_id: A.id, tags: ['讀書計劃'] });
    await api(`/tasks/${a2.body.id}`, { method: 'PATCH', body: { completed: true } });
    // B：兩筆未完成——標籤與標題都長得跟舊 heuristic 會命中的一樣
    const b1 = await mkTask({ title: 'B｜某書｜單元1', plan_id: B.id, tags: ['讀書計劃'] });
    const b2 = await mkTask({ title: 'B｜某書｜單元2', plan_id: B.id, tags: ['讀書計劃'] });
    // 沒有 Plan 的一般任務，標題也含｜
    const loose = await mkTask({ title: '手打的｜東西' });

    const del = await api(`/plans/${A.id}/tasks?incomplete=1`, { method: 'DELETE' });
    assert.equal(del.body.removed, 1);

    // 2C 前置條件：改成軟刪除。任務仍在資料庫（進垃圾桶、救得回來），
    // 歷史 ScheduleVersion 的 block 也不會因此變成 orphan。
    const all = (await api('/tasks')).body;
    const byId = new Map(all.map(t => [t.id, t]));
    const live = id => byId.has(id) && !byId.get(id).deleted;

    assert.equal(!!byId.get(a1.body.id)?.deleted, true, 'A 的未完成任務應該被軟刪除');
    assert.equal(byId.has(a1.body.id), true, '★ 必須是軟刪除，資料不得真的消失');
    assert.equal(live(a2.body.id), true, 'A 的已完成任務要保留當紀錄');
    assert.equal(live(b1.body.id), true, '★ 計畫B 的任務不得被誤刪');
    assert.equal(live(b2.body.id), true, '★ 計畫B 的任務不得被誤刪');
    assert.equal(live(loose.body.id), true, '★ 沒有 Plan 的一般任務不得被誤刪');

    // 軟刪除的意義就是救得回來
    await api(`/tasks/${a1.body.id}`, { method: 'PATCH', body: { deleted: false } });
    const after = (await api('/tasks')).body.find(t => t.id === a1.body.id);
    assert.equal(!!after && !after.deleted, true, '軟刪除的任務必須救得回來');
  });

  test('沒帶 incomplete=1 要拒絕，不做任何事', async () => {
    const { body: p } = await mkPlan();
    const t = await mkTask({ title: '不該被刪', plan_id: p.id });
    const r = await api(`/plans/${p.id}/tasks`, { method: 'DELETE' });
    assert.equal(r.status, 400);
    const all = (await api('/tasks')).body;
    assert.ok(all.some(x => x.id === t.body.id));
  });

  test('對不存在的計畫刪除回 404', async () => {
    assert.equal((await api('/plans/999999/tasks?incomplete=1', { method: 'DELETE' })).status, 404);
  });
});

describe('使用者隔離', () => {
  test('看不到、也改不動別人的計畫', async () => {
    const other = await startServer();
    try {
      const mk = await fetch(other.base + '/plans', {
        method: 'POST', headers: other.H, body: JSON.stringify({ name: '別人的計畫' }),
      }).then(r => r.json());
      // 兩台伺服器各自獨立資料庫，id 可能相同——重點是查詢一定要帶 user_id
      const mineList = await api('/plans?includeArchived=1');
      assert.equal(mineList.body.some(p => p.name === '別人的計畫'), false);
      assert.ok(mk.id);
    } finally { other.stop(); }
  });

  test('不能把自己的任務掛到別人的計畫 id 上（不存在就該擋）', async () => {
    const r = await mkTask({ title: 'x', plan_id: 123456789 });
    assert.equal(r.status, 400);
  });
});

describe('舊端點相容', () => {
  test('DELETE /plan-tasks 仍然可用（legacy-only）', async () => {
    const t = await mkTask({ title: '舊的｜計劃任務', tags: ['讀書計劃'] });
    const r = await api('/plan-tasks', { method: 'DELETE' });
    assert.equal(r.status, 200);
    const all = (await api('/tasks')).body;
    assert.equal(all.some(x => x.id === t.body.id), false);
  });

  test('沒有任何 Plan 時 /plans 回空陣列，不是錯誤', async () => {
    const fresh = await startServer();
    try {
      const r = await fetch(fresh.base + '/plans', { headers: fresh.H });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), []);
    } finally { fresh.stop(); }
  });
});
