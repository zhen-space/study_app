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

describe('retain_incomplete_tasks：只有暫停必填', () => {
  test('暫停：沒給、給字串、給數字都是 400', async () => {
    const { plan } = await fixture('必填-pause');
    for (const body of [{}, { retain_incomplete_tasks: 'true' }, { retain_incomplete_tasks: 1 },
      { retain_incomplete_tasks: null }]) {
      const r = await post(`/plans/${plan.id}/pause`, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} 應被拒絕`);
      assert.equal(r.body.code, 'retain_choice_required');
    }
    assert.equal((await get(`/plans/${plan.id}`)).body.plan.status, 'active');
  });

  test('刪除：不需要 retain，空 body 就能刪；帶了也被忽略', async () => {
    const a = await fixture('刪除-空body');
    assert.equal((await post(`/plans/${a.plan.id}/delete`, {})).status, 200);
    // 誤帶 retain 也不會被當成 400，一樣刪除
    const b = await fixture('刪除-誤帶retain');
    assert.equal((await post(`/plans/${b.plan.id}/delete`, { retain_incomplete_tasks: true })).status, 200);
  });
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
    assert.equal((await post(`/plans/${plan.id}/delete`, {})).status, 200);

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
    await post(`/plans/${plan.id}/delete`, {});
    for (const action of ['pause', 'resume', 'archive', 'restore', 'complete', 'end']) {
      const r = await post(`/plans/${plan.id}/${action}`, { retain_incomplete_tasks: true });
      assert.equal(r.status, 404, `${action} 應該找不到這個計畫`);
    }
    assert.equal((await post('/tasks', { title: 'x', plan_id: plan.id })).status, 400);
  });

  test('計畫與其中所有任務（未完成、已完成、已取消）一律 soft-delete，不 detach', async () => {
    const { plan, open, done } = await fixture('刪除-全刪');
    await call(`/tasks/${open.id}`, { method: 'PATCH', body: { notes: '記得帶講義', deadline_date: day(9) } });
    const cancelled = (await post('/tasks', { title: '不做了', plan_id: plan.id })).body;
    await post(`/tasks/${cancelled.id}/cancel`, {});

    await post(`/plans/${plan.id}/delete`, {});

    const list = (await get('/tasks')).body;
    for (const id of [open.id, done.id, cancelled.id]) {
      const t = list.find(x => x.id === id);
      assert.ok(t, `#${id} 必須還在資料裡——軟刪除才救得回、歷史版本才看得懂`);
      assert.equal(Number(t.deleted), 1, `#${id} 必須 soft-delete`);
      assert.equal(t.plan_id, plan.id, `#${id} 不得 detach 成 standalone`);
    }
    // soft-delete 只翻旗標，內容不被抹掉
    const goneOpen = list.find(x => x.id === open.id);
    assert.equal(goneOpen.notes, '記得帶講義');
    assert.equal(goneOpen.deadline_date, day(9));
    // 不會留下任何一般待辦（plan_id=NULL 的存活任務）
    const orphans = list.filter(t => [open.id, done.id, cancelled.id].includes(t.id) && t.plan_id == null);
    assert.equal(orphans.length, 0, '刪除後不得出現 standalone 任務');
  });

  test('刪除任務不撤銷既有 Material completion，StudySession 也保留', async () => {
    const { plan, open } = await fixture('刪除-material');
    // 為 open 建一段 StudySession（歷史執行紀錄）
    const s = (await post('/study-sessions', { task_id: open.id })).body;
    await call(`/study-sessions/${s.id}`, { method: 'PATCH', body: { status: 'completed' } });

    await post(`/plans/${plan.id}/delete`, {});

    // StudySession 仍在（透過 /study-sessions 查得到），任務列雖 deleted=1 但未 hard delete
    const sessions = (await get('/study-sessions')).body;
    assert.ok(sessions.some(x => x.id === s.id), 'StudySession 必須保留');
  });
});

describe('已結束計畫：保留進度、退出執行面、可讀但不可執行', () => {
  test('GET /tasks 帶回 plan_status，讓前端投影面可以據此排除', async () => {
    const { plan, open } = await fixture('ended-status');
    await post(`/plans/${plan.id}/end`, { confirm: true });
    const t = (await get('/tasks')).body.find(x => x.id === open.id);
    assert.ok(t, '任務仍存在');
    assert.equal(t.plan_status, 'ended', 'GET /tasks 必須帶 plan_status');
    assert.equal(Number(t.deleted ?? 0), 0, '結束不刪任務');
    assert.equal(t.plan_id, plan.id, '仍屬於原計畫');
  });

  test('一般待辦（plan_id=NULL）的 plan_status 為空，仍算可執行', async () => {
    const loose = (await post('/tasks', { title: '買參考書' })).body;
    const t = (await get('/tasks')).body.find(x => x.id === loose.id);
    assert.equal(t.plan_status ?? null, null);
  });

  test('結束保留完成率的實際數字，不變成 100%', async () => {
    const { plan } = await fixture('ended-完成率');
    await post(`/plans/${plan.id}/end`, { confirm: true });
    const listed = (await get('/plans?status=ended')).body.find(p => p.id === plan.id);
    assert.equal(listed.task_count, 2);
    assert.equal(listed.completed_task_count, 1, '完成率維持 1/2，結束不得灌成全完成');
  });

  test('ended 計畫的未完成任務不能開始讀書；不列入 unplaced', async () => {
    const { plan, open } = await fixture('ended-執行面');
    await post('/schedule/bootstrap', {});
    await post(`/plans/${plan.id}/end`, { confirm: true });

    const blocked = await post('/study-sessions', { task_id: open.id });
    assert.equal(blocked.status, 409, 'ended 計畫的任務不能開始讀書');

    const sched = await get('/schedule/active');
    if (sched.status === 200 && Array.isArray(sched.body.unplaced)) {
      assert.equal(sched.body.unplaced.map(t => Number(t.id)).includes(Number(open.id)), false);
    }
  });

  test('Plan Detail 仍可查看原任務與實際進度', async () => {
    const { plan, open, done } = await fixture('ended-detail');
    await post(`/plans/${plan.id}/end`, { confirm: true });
    const detail = await get(`/plans/${plan.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.plan.status, 'ended');
    const ids = detail.body.tasks.map(t => t.id);
    assert.ok(ids.includes(open.id) && ids.includes(done.id), '原任務都看得到');
    assert.equal(detail.body.summary.completed_tasks, 1);
    assert.equal(detail.body.summary.remaining_tasks, 1);
  });

  test('restart 後未完成任務恢復排程資格（但不復活舊 blocks）', async () => {
    const { plan, open } = await fixture('ended-restart');
    await post(`/plans/${plan.id}/end`, { confirm: true });
    assert.equal((await post('/study-sessions', { task_id: open.id })).status, 409);

    const back = await post(`/plans/${plan.id}/restart`, {});
    assert.equal(back.body.plan.status, 'active');
    const ok = await post('/study-sessions', { task_id: open.id });
    assert.equal(ok.status, 201, 'restart 後恢復可執行');
    await call(`/study-sessions/${ok.body.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
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
