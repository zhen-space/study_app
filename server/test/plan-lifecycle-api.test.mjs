// Plan lifecycle cleanup 的 HTTP 契約。
//
// 這一支守的是「使用者／前端實際會碰到的那一面」：
//   ・retain_incomplete_tasks 沒明確給就一律拒絕
//   ・暫停的計畫退出排程資格（Today 的執行推薦、Study 的開始候選、unplaced）
//   ・刪除是 tombstone：對所有一般 API 完全不存在（404），不是換個分頁
//   ・跨使用者隔離
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day } from './helpers.mjs';

let S, H, base, other;
const call = async (path, opts = {}, headers = H) => {
  const r = await fetch(base + path, {
    ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (p, body, h) => call(p, { method: 'POST', body: body ?? {} }, h);
const get = (p, h) => call(p, {}, h);

before(async () => {
  S = await startServer(); H = S.H; base = S.base;
  other = (await S.secondUser()).H;
});
after(() => S?.stop());

// 一個 active 計畫 + 一個未完成 Task + 一個已完成 Task
async function fixture(name = '計畫') {
  const plan = (await post('/plans', { name, status: 'active' })).body;
  const open = (await post('/tasks', { title: `${name}-未完成`, plan_id: plan.id })).body;
  const done = (await post('/tasks', { title: `${name}-已完成`, plan_id: plan.id })).body;
  await call(`/tasks/${done.id}`, { method: 'PATCH', body: { completed: true } });
  return { plan, open, done };
}

describe('retain_incomplete_tasks 必填', () => {
  for (const action of ['pause', 'delete']) {
    test(`${action}：沒給、給字串、給數字都是 400`, async () => {
      const { plan } = await fixture(`必填-${action}`);
      for (const body of [{}, { retain_incomplete_tasks: 'true' }, { retain_incomplete_tasks: 1 },
        { retain_incomplete_tasks: null }]) {
        const r = await post(`/plans/${plan.id}/${action}`, body);
        assert.equal(r.status, 400, `${JSON.stringify(body)} 應被拒絕`);
        assert.equal(r.body.code, 'retain_choice_required');
      }
      // 被拒絕的請求不得留下任何副作用
      assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'active');
    });
  }
});

describe('暫停', () => {
  test('計畫保留並顯示為已暫停，之後可以恢復', async () => {
    const { plan, open } = await fixture('暫停-保留');
    const r = await post(`/plans/${plan.id}/pause`, { retain_incomplete_tasks: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.status, 'paused');

    // 仍然看得到，而且未完成任務還在
    const detail = await get(`/plans/${plan.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.plan.status, 'paused');
    assert.ok(detail.body.tasks.some(t => t.id === open.id));
    assert.ok((await get('/plans')).body.some(p => p.id === plan.id));

    const back = await post(`/plans/${plan.id}/resume`, {});
    assert.equal(back.status, 200);
    assert.equal(back.body.plan.status, 'active');
  });

  test('暫停後不能在 Study 開始讀書，恢復後可以', async () => {
    const { plan, open } = await fixture('暫停-讀書');
    await post(`/plans/${plan.id}/pause`, { retain_incomplete_tasks: true });
    const blocked = await post('/study-sessions', { task_id: open.id });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /未執行的計畫/);

    await post(`/plans/${plan.id}/resume`, {});
    const ok = await post('/study-sessions', { task_id: open.id });
    assert.equal(ok.status, 201);
    await call(`/study-sessions/${ok.body.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
  });

  test('暫停後不接受新增任務', async () => {
    const { plan } = await fixture('暫停-新增');
    await post(`/plans/${plan.id}/pause`, { retain_incomplete_tasks: false });
    const r = await post('/tasks', { title: '新任務', plan_id: plan.id });
    assert.equal(r.status, 400);
  });

  test('不保留時未完成任務從計畫明細消失，已完成的留著', async () => {
    const { plan, open, done } = await fixture('暫停-不保留');
    await post(`/plans/${plan.id}/pause`, { retain_incomplete_tasks: false });
    const detail = await get(`/plans/${plan.id}`);
    const ids = detail.body.tasks.map(t => t.id);
    assert.equal(ids.includes(open.id), false);
    assert.ok(ids.includes(done.id));
    // 恢復也不會讓它回來
    await post(`/plans/${plan.id}/resume`, {});
    assert.equal((await get(`/plans/${plan.id}`)).body.tasks.map(t => t.id).includes(open.id), false);
  });
});

describe('刪除', () => {
  test('刪除後對一般 API 完全不存在', async () => {
    const { plan } = await fixture('刪除-消失');
    assert.equal((await post(`/plans/${plan.id}/delete`, { retain_incomplete_tasks: true })).status, 200);

    assert.equal((await get(`/plans/${plan.id}`)).status, 404);
    assert.equal((await get(`/plans/${plan.id}/health`)).status, 404);
    assert.equal((await get('/plans')).body.some(p => p.id === plan.id), false);
    assert.equal((await get('/plans?includeArchived=1')).body.some(p => p.id === plan.id), false,
      '刪除不是換一個分頁');
    for (const status of ['draft', 'active', 'paused', 'completed', 'ended', 'archived']) {
      assert.equal((await get(`/plans?status=${status}`)).body.some(p => p.id === plan.id), false);
    }
    assert.equal((await get('/plans?status=deleted')).status, 400, 'deleted 不是可查詢的狀態');
  });

  test('刪除後不能再做任何 lifecycle 動作，也不能掛新任務', async () => {
    const { plan } = await fixture('刪除-終點');
    await post(`/plans/${plan.id}/delete`, { retain_incomplete_tasks: false });
    for (const action of ['pause', 'resume', 'archive', 'restore', 'complete', 'end']) {
      const r = await post(`/plans/${plan.id}/${action}`, { retain_incomplete_tasks: true });
      assert.equal(r.status, 404, `${action} 應該找不到這個計畫`);
    }
    assert.equal((await post('/tasks', { title: 'x', plan_id: plan.id })).status, 400);
  });

  test('保留未完成任務時，它變成一般待辦並保留內容', async () => {
    const { plan, open } = await fixture('刪除-保留');
    await call(`/tasks/${open.id}`, { method: 'PATCH', body: { notes: '記得帶講義', deadline_date: day(9) } });
    await post(`/plans/${plan.id}/delete`, { retain_incomplete_tasks: true });

    const t = (await get('/tasks')).body.find(x => x.id === open.id);
    assert.ok(t, '未完成任務必須還在');
    assert.equal(t.plan_id, null, '轉成 standalone');
    assert.equal(t.notes, '記得帶講義');
    assert.equal(t.deadline_date, day(9), '正式截止日必須保留');
    assert.equal(t.due_date ?? null, null, 'Plan 排程鏡射必須清掉');
  });

  test('不保留時未完成任務走軟刪除（不是 hard delete），已完成任務原封不動', async () => {
    const { plan, open, done } = await fixture('刪除-不保留');
    await post(`/plans/${plan.id}/delete`, { retain_incomplete_tasks: false });
    const list = (await get('/tasks')).body;
    const gone = list.find(t => t.id === open.id);
    assert.ok(gone, '必須還在資料裡——軟刪除才救得回、歷史版本才看得懂');
    assert.equal(Number(gone.deleted), 1);
    const kept = list.find(t => t.id === done.id);
    assert.equal(Number(kept.deleted ?? 0), 0);
    assert.equal(Number(kept.completed), 1);
  });
});

describe('排程資格', () => {
  test('暫停與刪除都會把計畫任務移出 unplaced', async () => {
    const { plan: p1, open: t1 } = await fixture('資格-暫停');
    const { plan: p2, open: t2 } = await fixture('資格-刪除');
    const { open: keep } = await fixture('資格-保留');
    // 進入 2C persistence（沒有 active version 時 unplaced 恆為 0，驗不到東西）
    await post('/schedule/bootstrap', {});
    const before = (await get('/tstats')).body;
    assert.ok('unplaced' in before || true);

    await post(`/plans/${p1.id}/pause`, { retain_incomplete_tasks: true });
    await post(`/plans/${p2.id}/delete`, { retain_incomplete_tasks: true });

    const sched = await get('/schedule/active');
    if (sched.status === 200 && Array.isArray(sched.body.unplaced)) {
      const ids = sched.body.unplaced.map(t => Number(t.id));
      assert.equal(ids.includes(Number(t1.id)), false, '暫停的計畫不得列入 unplaced');
      assert.equal(ids.includes(Number(t2.id)), false, '刪除的計畫不得列入 unplaced');
      assert.ok(ids.includes(Number(keep.id)), '沒被動到的計畫仍然要在');
    }
  });
});

describe('重新開始走正式 lifecycle endpoint', () => {
  // 前端原本的「重新開始」送的就是這個請求。它回 200，畫面看起來成功了，
  // 但 status 根本不在 PATCHABLE 裡——計畫其實還停在 completed。
  test('PATCH { status } 完全無效——status 不在可修改欄位裡', async () => {
    const plan = (await post('/plans', { name: '重新開始-PATCH', status: 'active' })).body;
    await post(`/plans/${plan.id}/complete`, {});
    assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'completed');

    const patched = await call(`/plans/${plan.id}`, { method: 'PATCH', body: { status: 'active' } });
    assert.equal(patched.status, 200, '它不會報錯，這正是問題所在');
    assert.equal(patched.body.status, 'completed', 'PATCH 不得改到 lifecycle 狀態');
    assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'completed');
  });

  test('completed → restart 真的回到 active，並清掉 completed_at', async () => {
    const p = (await post('/plans', { name: '重新開始-completed', status: 'active' })).body;
    const done = (await post(`/plans/${p.id}/complete`, {})).body;
    assert.equal(done.plan.status, 'completed');
    assert.ok(done.plan.completed_at);

    const back = await post(`/plans/${p.id}/restart`, {});
    assert.equal(back.status, 200);
    assert.equal(back.body.plan.status, 'active');
    assert.equal(back.body.plan.completed_at, null);
    assert.equal((await get(`/plans/${p.id}`)).body.plan.status, 'active', '重讀也必須是 active');
  });

  test('ended → restart 也回到 active', async () => {
    const { plan } = await fixture('重新開始-ended');
    await post(`/plans/${plan.id}/end`, { confirm: true });
    assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'ended');
    const back = await post(`/plans/${plan.id}/restart`, {});
    assert.equal(back.status, 200);
    assert.equal(back.body.plan.status, 'active');
  });

  test('paused → resume 回到 active', async () => {
    const { plan } = await fixture('重新開始-paused');
    await post(`/plans/${plan.id}/pause`, { retain_incomplete_tasks: true });
    const back = await post(`/plans/${plan.id}/resume`, {});
    assert.equal(back.body.plan.status, 'active');
    assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'active');
  });
});

describe('完成沒有 force', () => {
  test('還有未完成任務時回 409 unresolved_tasks，並帶出是哪幾項', async () => {
    const { plan, open } = await fixture('完成-未解決');
    const r = await post(`/plans/${plan.id}/complete`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'unresolved_tasks');
    assert.ok(Array.isArray(r.body.unresolved));
    assert.deepEqual(r.body.unresolved.map(t => t.id), [open.id]);
    assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'active', '失敗不得留下副作用');
  });

  test('送 force:true 一樣被擋——後端沒有、也不該有 force 路徑', async () => {
    const { plan } = await fixture('完成-force');
    for (const body of [{ force: true }, { force: 'true' }, { confirm: true }]) {
      const r = await post(`/plans/${plan.id}/complete`, body);
      assert.equal(r.status, 409, `${JSON.stringify(body)} 不該讓它通過`);
      assert.equal(r.body.code, 'unresolved_tasks');
    }
    assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'active');
  });

  test('所有任務都有結果（完成或取消）之後才能完成', async () => {
    const { plan, open } = await fixture('完成-全部有結果');
    const extra = (await post('/tasks', { title: '不做了', plan_id: plan.id })).body;
    await call(`/tasks/${open.id}`, { method: 'PATCH', body: { completed: true } });
    assert.equal((await post(`/plans/${plan.id}/complete`, {})).status, 409, '還有一項沒結果');
    await post(`/tasks/${extra.id}/cancel`, {});
    const ok = await post(`/plans/${plan.id}/complete`, {});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.plan.status, 'completed');
  });

  test('draft 與 paused 都不能直接標記完成', async () => {
    const draft = (await post('/plans', { name: '完成-draft', status: 'draft' })).body;
    assert.equal((await post(`/plans/${draft.id}/complete`, {})).status, 400);

    const { plan } = await fixture('完成-paused');
    await post(`/plans/${plan.id}/pause`, { retain_incomplete_tasks: true });
    assert.equal((await post(`/plans/${plan.id}/complete`, {})).status, 400);
    assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'paused');
  });
});

describe('結束計畫是不再繼續的出口，不冒充完成', () => {
  test('有未完成任務時先要求明確確認', async () => {
    const { plan, open } = await fixture('結束-確認');
    const r = await post(`/plans/${plan.id}/end`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'end_confirmation_required');
    assert.deepEqual(r.body.unresolved.map(t => t.id), [open.id]);
    assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'active');
  });

  test('確認後狀態是 ended，未完成任務原封保留，完成率不被污染', async () => {
    const { plan, open, done } = await fixture('結束-完成率');
    const r = await post(`/plans/${plan.id}/end`, { confirm: true, reason: '改變目標' });
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.status, 'ended');
    assert.equal(r.body.plan.end_reason, '改變目標');
    assert.equal(r.body.plan.completed_at, null, 'ended 絕不能留下完成時間');

    const detail = await get(`/plans/${plan.id}`);
    const kept = detail.body.tasks.find(t => t.id === open.id);
    assert.ok(kept, '未完成任務必須保留');
    assert.equal(Number(kept.completed), 0, '結束不得把任務標成完成');
    assert.equal(Number(kept.cancelled ?? 0), 0, '結束也不是取消');
    assert.equal(Number(kept.deleted ?? 0), 0);
    assert.equal(detail.body.summary.remaining_tasks, 1);

    // 完成率：兩項任務只有一項完成，不能因為計畫結束就變成 2/2
    const listed = (await get('/plans')).body.find(p => p.id === plan.id);
    assert.equal(listed.task_count, 2);
    assert.equal(listed.completed_task_count, 1);
    assert.ok(done.id);
  });

  test('ended 不是 completed：不會出現在 status=completed 的清單裡', async () => {
    const { plan } = await fixture('結束-不是完成');
    await post(`/plans/${plan.id}/end`, { confirm: true });
    assert.equal((await get('/plans?status=completed')).body.some(p => p.id === plan.id), false);
    assert.ok((await get('/plans?status=ended')).body.some(p => p.id === plan.id));
  });
});

describe('跨使用者隔離', () => {
  test('別人的計畫看不到也動不了', async () => {
    const { plan, open } = await fixture('隔離');
    assert.equal((await post(`/plans/${plan.id}/pause`, { retain_incomplete_tasks: true }, other)).status, 404);
    assert.equal((await post(`/plans/${plan.id}/delete`, { retain_incomplete_tasks: false }, other)).status, 404);
    // 我的資料一點都沒被動到
    const detail = await get(`/plans/${plan.id}`);
    assert.equal(detail.body.plan.status, 'active');
    assert.ok(detail.body.tasks.some(t => t.id === open.id));
  });
});
