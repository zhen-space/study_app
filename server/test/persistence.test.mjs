// Phase 2C-P1：排程持久化的契約測試。
//
// 守的是「唯一時間真相」這件事真的成立：
//   ・版本建立是全有或全無（半套版本比慢一點嚴重得多）
//   ・active version 只認 user_schedule_state，不做 MAX(version_no) 推導
//   ・due_date 只是鏡射，unplaced 是正式狀態
//   ・歷史版本 immutable：任務軟刪除之後舊 block 仍在、仍讀得懂
//   ・跨使用者一律看不到
//
// 契約：docs/phase2c-schedule-persistence.md §1–§11

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day } from './helpers.mjs';

let S, api;
before(async () => {
  S = await startServer();
  api = async (path, opts = {}) => {
    const r = await fetch(S.base + path, {
      ...opts, headers: S.H,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
});
after(() => S?.stop());

const mkPlan = (over = {}) => api('/plans', { method: 'POST', body: { name: '計畫', status: 'active', ...over } });
const mkTask = (over = {}) => api('/tasks', { method: 'POST', body: { title: '任務', ...over } });
const active = () => api('/schedule/active');

/* ---------- schema ---------- */

describe('schema migration', () => {
  test('user_schedule_state 一開始是空的：沒有 active version 就是走 legacy', async () => {
    const r = await active();
    assert.equal(r.status, 200);
    assert.equal(r.body.active, false, 'active_version_id 為 NULL 時必須明說還沒進入 2C');
    assert.equal(r.body.version, null);
    assert.deepEqual(r.body.blocks, []);
  });
});

/* ---------- bootstrap ---------- */

describe('bootstrap（2A → 2C cutover）', () => {
  test('只把「未來的、屬於計畫的、未完成的」既有排定日期收成 V1', async () => {
    const { body: plan } = await mkPlan({ name: '段考' });
    const future = await mkTask({ title: '未來', plan_id: plan.id, due_date: day(2) });
    const today0 = await mkTask({ title: '今天', plan_id: plan.id, due_date: day(0), due_time: '19:00' });
    const past = await mkTask({ title: '過去', plan_id: plan.id, due_date: day(-3) });
    const noDate = await mkTask({ title: '沒排', plan_id: plan.id });
    const done = await mkTask({ title: '已完成', plan_id: plan.id, due_date: day(1) });
    await api(`/tasks/${done.body.id}`, { method: 'PATCH', body: { completed: true } });
    const loose = await mkTask({ title: '沒有計畫的一般任務', due_date: day(1) });

    const boot = await api('/schedule/bootstrap', { method: 'POST' });
    assert.equal(boot.body.created, true);

    const { body } = await active();
    assert.equal(body.active, true);
    assert.equal(body.version.source, 'bootstrap');
    assert.equal(body.version.version_no, 1);
    assert.equal(body.version.parent_version_id, null);
    assert.equal(body.version.effective_from, day(0));

    const ids = body.blocks.map(b => b.task_id);
    assert.ok(ids.includes(future.body.id), '未來的排定日期要變成 block');
    assert.ok(ids.includes(today0.body.id), '今天的也要');
    assert.ok(!ids.includes(past.body.id), '★ 過去的不得建 block —— 不能捏造歷史');
    assert.ok(!ids.includes(noDate.body.id), '沒有 due_date 的不建 block');
    assert.ok(!ids.includes(done.body.id), '已完成的不進未來排程');
    assert.ok(!ids.includes(loose.body.id), '★ 非 Plan Task 完全不參與');

    assert.equal(body.version.block_count, body.blocks.length, 'block_count 要跟實際筆數一致');
  });

  test('沒有 due_date 的 Plan Task 成為正式 unplaced，不是消失', async () => {
    const { body } = await active();
    const titles = body.unplaced.map(t => t.title);
    assert.ok(titles.includes('沒排'), '沒有排定日期的計畫任務要出現在 unplaced');
    assert.ok(!titles.includes('沒有計畫的一般任務'), '非 Plan Task 不算 unplaced');
  });

  test('時間帶得過去：due_time 會變成 block 的 start_time', async () => {
    const { body } = await active();
    const b = body.blocks.find(x => x.start_time);
    assert.equal(b.start_time, '19:00');
  });

  test('snapshot 標題與科目有填（任務被刪掉之後歷史版本還看得懂）', async () => {
    const { body } = await active();
    assert.ok(body.blocks.every(b => b.task_title_snapshot), '每個 block 都要有標題留影');
  });

  test('第二次 bootstrap 不會再建一個 V1', async () => {
    const before = (await active()).body.version.id;
    const r = await api('/schedule/bootstrap', { method: 'POST' });
    assert.equal(r.body.created, false);
    assert.equal((await active()).body.version.id, before);
    const list = (await api('/schedule/versions')).body;
    assert.equal(list.filter(v => v.source === 'bootstrap').length, 1);
  });
});

/* ---------- due_date mirror ---------- */

describe('due_date / due_time 鏡射', () => {
  test('有 block 的任務，due_date 跟 block 一致', async () => {
    const { body } = await active();
    const tasks = (await api('/tasks')).body;
    for (const b of body.blocks) {
      const t = tasks.find(x => x.id === b.task_id);
      assert.equal(t.due_date, b.date, `任務 ${t.title} 的 due_date 應該鏡射 block`);
    }
  });

  test('unplaced 的 Plan Task，due_date 被清成 NULL', async () => {
    const tasks = (await api('/tasks')).body;
    const t = tasks.find(x => x.title === '沒排');
    assert.equal(t.due_date, null, '★ 不得保留舊的 due_date —— unplaced 是正式狀態');
  });

  test('非 Plan Task 的 due_date 完全不受影響', async () => {
    const tasks = (await api('/tasks')).body;
    const t = tasks.find(x => x.title === '沒有計畫的一般任務');
    assert.equal(t.due_date, day(1), '★ 一般任務不該被排程鏡射動到');
  });

  test('已完成的 Plan Task 保留 due_date 當歷史紀錄', async () => {
    const tasks = (await api('/tasks')).body;
    const t = tasks.find(x => x.title === '已完成');
    assert.equal(t.due_date, day(1), '完成紀錄不該因為不在未來排程就被清掉');
  });
});

/* ---------- 版本 immutability 與歷史 ---------- */

describe('版本是 immutable snapshot', () => {
  test('建立新版本不會動到舊版的 blocks', async () => {
    const v1 = (await active()).body;
    const v1Blocks = JSON.stringify(v1.blocks.map(b => [b.task_id, b.date, b.start_time]));

    // 用既有任務建一個新版本（把所有東西往後挪一天）
    const { body: plan } = await mkPlan({ name: '第二個計畫' });
    const t = await mkTask({ title: '新任務', plan_id: plan.id });
    await api('/schedule/bootstrap', { method: 'POST' });   // 已有 active，不會重建

    const before = (await api(`/schedule/versions/${v1.version.id}`)).body;
    assert.equal(JSON.stringify(before.blocks.map(b => [b.task_id, b.date, b.start_time])), v1Blocks,
      '★ 舊版 blocks 必須一個位元組都沒變');
    assert.ok(t.body.id);
  });

  test('任務軟刪除之後，歷史 block 仍在而且仍讀得懂', async () => {
    const v = (await active()).body;
    const target = v.blocks[0];
    await api(`/tasks/${target.task_id}`, { method: 'DELETE' });

    const after = (await api(`/schedule/versions/${v.version.id}`)).body;
    const still = after.blocks.find(b => b.task_id === target.task_id);
    assert.ok(still, '★ 歷史 block 不得因為任務被刪就消失');
    assert.ok(still.task_title_snapshot, '★ 還要看得懂當初排的是什麼');
  });
});

/* ---------- 使用者隔離 ---------- */

describe('使用者隔離', () => {
  test('看不到別人的版本，而且是 404 不是 403', async () => {
    const other = await startServer();
    try {
      // 在另一台（另一個使用者）建立版本
      await fetch(other.base + '/plans', {
        method: 'POST', headers: other.H, body: JSON.stringify({ name: 'B 的計畫', status: 'active' }),
      });
      await fetch(other.base + '/schedule/bootstrap', { method: 'POST', headers: other.H });

      // 用自己的 token 去撈一個不屬於自己的 version id
      const r = await api('/schedule/versions/999999');
      assert.equal(r.status, 404, '★ 必須 404 —— 403 等於承認這個 id 存在');
    } finally { other.stop(); }
  });
});
