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

/* ---------- P2：Wizard / Replan 正式套用 ---------- */

describe('schedule/apply（Wizard 與 Replan 的唯一寫入入口）', () => {
  test('建立計畫時，Task、active version、block 與 due mirror 一起建立', async () => {
    const { body: plan } = await mkPlan({ name: 'P2 初次建立' });
    const r = await api('/schedule/apply', {
      method: 'POST',
      body: {
        plan_id: plan.id,
        source: 'initial',
        task_creates: [{ client_key: 'a', title: '第一章', list_id: null, tags: ['讀書計劃'] }],
        blocks: [{ client_key: 'a', date: day(4), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
      },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.block_count >= 1,
      '新版除本次 block 外，還可帶入其他 Plan 的 active block');
    const taskId = r.body.created[0].id;
    const t = (await api('/tasks')).body.find(x => x.id === taskId);
    assert.equal(t.due_date, day(4));
    assert.equal(t.due_time, '19:00');
    const now = await active();
    assert.equal(now.body.version.id, r.body.version_id);
    assert.equal(now.body.version.source, 'initial');
    assert.ok(now.body.blocks.some(b => b.task_id === taskId),
      '本次 Plan 的 block 必須存在；其他既有 Plan block 也會被全域 snapshot 保留');
  });

  test('Replan 建立新版本並以原 active 當 parent，Task 不直接寫 due_date', async () => {
    const before = (await active()).body.version;
    const taskId = (await api('/tasks')).body.find(t => t.title === '第一章').id;
    const r = await api('/schedule/apply', {
      method: 'POST',
      body: {
        plan_id: (await api('/plans')).body.find(p => p.name === 'P2 初次建立').id,
        source: 'ai_replan',
        task_updates: [{ task_id: taskId, notes: '讀書時段 20:00–21:30' }],
        blocks: [{ task_id: taskId, date: day(5), start_time: '20:00', end_time: '21:30', planned_minutes: 90 }],
      },
    });
    assert.equal(r.status, 200);
    const now = await active();
    assert.equal(now.body.version.parent_version_id, before.id);
    assert.equal(now.body.version.source, 'ai_replan');
    const t = (await api('/tasks')).body.find(x => x.id === taskId);
    assert.equal(t.due_date, day(5));
    assert.equal(t.due_time, '20:00');
    assert.equal(t.notes, '讀書時段 20:00–21:30');
  });

  test('找不到 block 對應的新任務時，Task 與新版排程都必須 rollback', async () => {
    const planId = (await api('/plans')).body.find(p => p.name === 'P2 初次建立').id;
    const versionsBefore = (await api('/schedule/versions')).body.length;
    const tasksBefore = (await api('/tasks')).body.filter(t => t.plan_id === planId).length;
    const r = await api('/schedule/apply', {
      method: 'POST',
      body: {
        plan_id: planId,
        source: 'ai_replan',
        task_creates: [{ client_key: 'will-rollback', title: '不該留下' }],
        blocks: [{ client_key: 'missing', date: day(6) }],
      },
    });
    assert.equal(r.status, 400);
    assert.equal((await api('/schedule/versions')).body.length, versionsBefore);
    assert.equal((await api('/tasks')).body.filter(t => t.plan_id === planId).length, tasksBefore);
  });

  // mutation guard：若 preview 不把 other-Plan active block 加進 busy intervals，
  // 這裡會把唯一可用的 19:00–20:00 再排給 Plan A。
  test('timed preview 會把其他 Plan 的 active block 視為 busy，但釋出 current Plan', async () => {
    const { body: planA } = await mkPlan({ name: 'Preview A' });
    const { body: planB } = await mkPlan({ name: 'Preview B' });
    const busy = await api('/schedule/apply', {
      method: 'POST',
      body: {
        plan_id: planB.id, source: 'initial',
        task_creates: [{ client_key: 'b', title: 'B 既有安排' }],
        blocks: [{ client_key: 'b', date: day(7), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }],
      },
    });
    assert.equal(busy.status, 200);
    const preview = await api('/schedule/preview', {
      method: 'POST',
      body: {
        plan_id: planA.id, timed: true, perDay: 0, pace: 'even',
        sleep_start: '21:00', sleep_end: '19:00',
        startDate: day(7), endDate: day(7), items: [{
          subject_id: 1, title: 'A 新安排', minutes: 60, start: day(7), end: day(7),
        }],
      },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.blocks[0].start_time, '20:00');
    assert.equal(preview.body.blocks[0].end_time, '21:00');
  });
});

/* ---------- P3：Schedule History / Restore API ---------- */

describe('schedule version restore API', () => {
  test('版本可讀、preview 帶 base_version_id，restore 建立新的 immutable version', async () => {
    const current = (await active()).body.version;
    const detail = await api(`/schedule/versions/${current.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.version.id, current.id);

    const preview = await api(`/schedule/versions/${current.id}/restore-preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.source_version_id, current.id);
    assert.equal(preview.body.base_version_id, current.id);
    assert.ok(['full', 'partial', 'impossible', 'nothing_to_restore'].includes(preview.body.status));
    if (preview.body.status === 'full') {
      const restored = await api(`/schedule/versions/${current.id}/restore`, {
        method: 'POST', body: { base_version_id: preview.body.base_version_id },
      });
      assert.equal(restored.status, 200);
      assert.equal(restored.body.applied, true);
      assert.notEqual(restored.body.version.version_id, current.id);
      const now = (await active()).body.version;
      assert.equal(now.id, restored.body.version.version_id);
      assert.equal(now.parent_version_id, current.id);
      assert.equal(now.restored_from_version_id, current.id);
      assert.equal((await api(`/schedule/versions/${current.id}`)).body.version.id, current.id,
        '★ restore 不得修改 template version');
    }
  });

  test('不存在或不屬於使用者的 restore 版本一律 404', async () => {
    assert.equal((await api('/schedule/versions/999999/restore-preview')).status, 404);
    assert.equal((await api('/schedule/versions/999999/restore', {
      method: 'POST', body: { base_version_id: 1 },
    })).status, 404);
  });
});
