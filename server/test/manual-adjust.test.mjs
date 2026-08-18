// Phase 2C-P6-A：手動調整 AI 排程的契約測試。
//
// 這一支守的是「使用者可以自己改，但改不出違法的排程」：
//   ・調整永遠產生新的 source='manual' 版本，不就地改 active 那一版
//   ・沒被碰到的 block（含其他 Plan）原封不動帶進新版本
//   ・過去、超過 deadline_date、撞固定行程、撞別的安排、撞鎖定 → 一律擋
//   ・dry_run 不寫任何東西，而且跟真正套用用同一份規則
//   ・base_version_id 對不上 → 409，絕不重試（不能默默蓋掉沒看過的排程）

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
const manual = body => api('/schedule/manual', { method: 'POST', body });

// 建一份有 active version 的排程：一個計畫、若干任務、一個 initial 版本。
//
// 走 /schedule/apply 而不是 bootstrap：bootstrap 一個使用者只會成功一次，
// 整個測試檔共用同一個帳號，第二個 seed 就會拿不到 block。apply 每次都會
// 建立新版本，而且會把先前其他計畫的 block 帶過來——正好是我們要測的情境。
//
// tasks 的 date/start_time/end_time 是它在這一版的排定位置；
// deadline_date 之類的任務欄位照原樣送進 /tasks。
async function seed(specs) {
  const { body: plan } = await mkPlan();
  const made = [];
  const blocks = [];
  for (const { date, start_time, end_time, ...taskFields } of specs) {
    const { body } = await mkTask({ plan_id: plan.id, ...taskFields });
    made.push(body);
    blocks.push({ task_id: body.id, date, start_time: start_time ?? null, end_time: end_time ?? null });
  }
  const applied = await api('/schedule/apply', {
    method: 'POST',
    body: { plan_id: plan.id, source: 'initial', blocks },
  });
  assert.equal(applied.status, 200, '測試前置的排程套用必須成功：' + JSON.stringify(applied.body));
  const { body: state } = await active();
  return { plan, tasks: made, state };
}

const blockOf = (state, taskId) => state.blocks.find(b => Number(b.task_id) === Number(taskId));

describe('手動調整：正常路徑', () => {
  test('調整產生新的 manual 版本，未被碰到的 block 原封不動帶過去', async () => {
    const { tasks, state } = await seed([
      { title: '要搬的', date: day(3) },
      { title: '不要動的', date: day(5), start_time: '19:00', end_time: '20:00' },
    ]);
    const moving = blockOf(state, tasks[0].id);
    const untouched = blockOf(state, tasks[1].id);

    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: moving.id, date: day(8), start_time: '14:00', end_time: '15:30' }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    const { body: after } = await active();
    assert.equal(after.version.source, 'manual', '必須是 manual 來源，不能混進 ai_replan');
    assert.equal(after.version.parent_version_id, state.version.id, '新版本要接在原本 active 之後');
    assert.notEqual(after.version.id, state.version.id, '絕不能就地改舊版本');
    assert.equal(after.blocks.length, state.blocks.length, '調整不會增加或減少 block');

    const moved = blockOf(after, tasks[0].id);
    assert.equal(moved.date, day(8));
    assert.equal(moved.start_time, '14:00');
    assert.equal(moved.end_time, '15:30');

    const kept = blockOf(after, tasks[1].id);
    assert.equal(kept.date, untouched.date, '沒被碰到的 block 日期不能變');
    assert.equal(kept.start_time, untouched.start_time, '沒被碰到的 block 時間不能變');
  });

  test('舊版本仍然存在且內容不變（immutable snapshot）', async () => {
    const { tasks, state } = await seed([{ title: '搬一下', date: day(2) }]);
    await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(6) }],
    });
    const old = await api(`/schedule/versions/${state.version.id}`);
    assert.equal(old.status, 200);
    assert.equal(old.body.blocks[0].date, day(2), '舊版本的 block 不可以被改寫');
  });

  test('due_date 鏡射跟著新版本走', async () => {
    const { tasks, state } = await seed([{ title: '鏡射', date: day(2) }]);
    await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(9), start_time: '20:00', end_time: '21:00' }],
    });
    const { body: all } = await api('/tasks');
    const t = all.find(x => Number(x.id) === Number(tasks[0].id));
    assert.equal(t.due_date, day(9), 'due_date 必須鏡射到新的排定位置');
    assert.equal(t.due_time, '20:00');
  });

  test('只調日期、不給時間也可以（純待辦模式）', async () => {
    const { tasks, state } = await seed([{ title: '只有日期', date: day(2) }]);
    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(4) }],
    });
    assert.equal(r.status, 200);
    const { body: after } = await active();
    assert.equal(blockOf(after, tasks[0].id).start_time, null);
  });

  test('同一次可以調多筆', async () => {
    const { tasks, state } = await seed([
      { title: 'A', date: day(2) },
      { title: 'B', date: day(3) },
    ]);
    const r = await manual({
      base_version_id: state.version.id,
      moves: [
        { block_id: blockOf(state, tasks[0].id).id, date: day(10) },
        { block_id: blockOf(state, tasks[1].id).id, date: day(11) },
      ],
    });
    assert.equal(r.status, 200);
    const { body: after } = await active();
    assert.equal(blockOf(after, tasks[0].id).date, day(10));
    assert.equal(blockOf(after, tasks[1].id).date, day(11));
  });
});

describe('手動調整：可行性不能被繞過', () => {
  test('不能搬到已經過去的日期', async () => {
    const { tasks, state } = await seed([{ title: '搬到過去', date: day(3) }]);
    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(-2) }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.conflicts[0].type, 'past');
    const { body: after } = await active();
    assert.equal(after.version.id, state.version.id, '被擋下來時不可以留下新版本');
  });

  test('不能搬到超過 deadline_date 的日期', async () => {
    const { tasks, state } = await seed([{ title: '有硬性期限', date: day(2), deadline_date: day(5) }]);
    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(6) }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.conflicts[0].type, 'deadline');
    assert.equal(r.body.conflicts[0].deadline_date, day(5));
  });

  test('不能搬到跟固定行程重疊的時段', async () => {
    const { tasks, state } = await seed([{ title: '撞社團', date: day(2) }]);
    await api('/events', {
      method: 'POST',
      body: { title: '社團', date: day(7), start_time: '15:00', end_time: '17:00' },
    });
    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(7), start_time: '16:00', end_time: '17:30' }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.conflicts[0].type, 'fixed_event');
    assert.match(r.body.conflicts[0].message, /社團/);
  });

  test('不能搬到跟其他計畫的安排重疊的時段（跨 Plan 碰撞）', async () => {
    // 先讓別的計畫佔住一個時段。apply 會把它帶進 active snapshot，
    // 之後本計畫的手動調整就必須看得見它。
    const occupier = await seed([{ title: '別的計畫的', date: day(9), start_time: '19:00', end_time: '20:00' }]);
    const { tasks, state } = await seed([{ title: '本計畫', date: day(2) }]);
    assert.ok(blockOf(state, occupier.tasks[0].id), '其他計畫的 block 必須留在 active snapshot 裡');

    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(9), start_time: '19:30', end_time: '20:30' }],
    });
    assert.equal(r.status, 409, '別的計畫佔住的時段不能被手動塞進去');
    assert.equal(r.body.conflicts[0].type, 'schedule_collision');
  });

  test('同一次調整內部彼此撞到也要擋', async () => {
    const { tasks, state } = await seed([
      { title: 'A', date: day(2) },
      { title: 'B', date: day(3) },
    ]);
    const r = await manual({
      base_version_id: state.version.id,
      moves: [
        { block_id: blockOf(state, tasks[0].id).id, date: day(8), start_time: '19:00', end_time: '20:00' },
        { block_id: blockOf(state, tasks[1].id).id, date: day(8), start_time: '19:30', end_time: '20:30' },
      ],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.conflicts[0].type, 'schedule_collision');
  });

  test('鎖定的位置不能被手動調整動到', async () => {
    const { tasks, state } = await seed([{ title: '被鎖住', date: day(4) }]);
    const lock = await api('/schedule/locks', { method: 'POST', body: { type: 'task', task_id: tasks[0].id } });
    assert.equal(lock.status, 201);
    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(9) }],
    });
    assert.equal(r.status, 409, 'Lock 不能被手動調整繞過');
    assert.ok(r.body.conflicts.some(c => c.type === 'LOCKED_TASK_MOVED'));
  });

  test('鎖住的那一天，別人的 block 也不能被搬進去', async () => {
    const { tasks, state } = await seed([
      { title: '要搬的', date: day(3) },
      { title: '鎖那天的', date: day(12) },
    ]);
    const lock = await api('/schedule/locks', { method: 'POST', body: { type: 'day', date: day(12) } });
    assert.equal(lock.status, 201);
    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(12) }],
    });
    assert.equal(r.status, 409);
    assert.ok(r.body.conflicts.some(c => c.type === 'LOCKED_DAY_CHANGED'));
  });
});

describe('手動調整：輸入與併發', () => {
  test('base_version_id 對不上就是 409，而且不留下任何新版本', async () => {
    const { tasks, state } = await seed([{ title: '併發', date: day(2) }]);
    const r = await manual({
      base_version_id: state.version.id + 999,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(5) }],
    });
    assert.equal(r.status, 409);
    const { body: after } = await active();
    assert.equal(after.version.id, state.version.id);
  });

  test('別人的 block id 一律當作不存在', async () => {
    const { tasks, state } = await seed([{ title: '越界', date: day(2) }]);
    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: 999999, date: day(5) }],
    });
    assert.equal(r.status, 400);
  });

  test('只給開始時間、時間顛倒、缺日期都要擋下來', async () => {
    const { tasks, state } = await seed([{ title: '格式', date: day(2) }]);
    const id = blockOf(state, tasks[0].id).id;
    const only = await manual({ base_version_id: state.version.id, moves: [{ block_id: id, date: day(5), start_time: '19:00' }] });
    assert.equal(only.status, 400, '只給開始時間不算合法時段');
    const rev = await manual({ base_version_id: state.version.id, moves: [{ block_id: id, date: day(5), start_time: '20:00', end_time: '19:00' }] });
    assert.equal(rev.status, 400, '結束時間必須晚於開始時間');
    const noDate = await manual({ base_version_id: state.version.id, moves: [{ block_id: id }] });
    assert.equal(noDate.status, 400);
    const none = await manual({ base_version_id: state.version.id, moves: [] });
    assert.equal(none.status, 400, '沒有內容就不該建立版本');
  });

  test('同一個 block 不能在一次請求裡被調兩次', async () => {
    const { tasks, state } = await seed([{ title: '重複', date: day(2) }]);
    const id = blockOf(state, tasks[0].id).id;
    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: id, date: day(5) }, { block_id: id, date: day(6) }],
    });
    assert.equal(r.status, 400);
  });
});

describe('手動調整：dry run', () => {
  test('dry_run 不寫任何東西，但給出跟正式套用一樣的判定', async () => {
    const { tasks, state } = await seed([{ title: '試算', date: day(2), deadline_date: day(4) }]);
    const id = blockOf(state, tasks[0].id).id;
    const before = (await api('/schedule/versions')).body.length;

    const bad = await manual({ base_version_id: state.version.id, dry_run: true, moves: [{ block_id: id, date: day(9) }] });
    assert.equal(bad.status, 200, 'dry run 本身是成功的請求，衝突放在 body 裡');
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.conflicts[0].type, 'deadline');

    const good = await manual({ base_version_id: state.version.id, dry_run: true, moves: [{ block_id: id, date: day(3) }] });
    assert.equal(good.body.ok, true, JSON.stringify(good.body.conflicts));
    assert.deepEqual(good.body.conflicts, []);

    const { body: after } = await active();
    assert.equal(after.version.id, state.version.id, 'dry run 絕對不可以建立版本');
    const versions = await api('/schedule/versions');
    assert.equal(versions.body.length, before, 'dry run 之後版本數不變');
  });
});

describe('手動調整：版本紀錄', () => {
  test('diff 認得出手動搬動，而且是 moved 不是 removed + added', async () => {
    const { tasks, state } = await seed([
      { title: '搬的', date: day(2) },
      { title: '沒搬的', date: day(3) },
    ]);
    const r = await manual({
      base_version_id: state.version.id,
      moves: [{ block_id: blockOf(state, tasks[0].id).id, date: day(7) }],
    });
    const diff = await api(`/schedule/versions/${r.body.version_id}/diff?include_unchanged=0`);
    assert.equal(diff.status, 200);
    assert.equal(diff.body.summary.moved, 1);
    assert.equal(diff.body.summary.added, 0);
    assert.equal(diff.body.summary.removed, 0);
    // include_unchanged=0：只有真正被動到的那一項會列出來，
    // 其他計畫沿用過來的 block 一律是 unchanged，不該混進來。
    assert.equal(diff.body.items.length, 1);
    assert.equal(diff.body.items[0].task_id, tasks[0].id);
    assert.equal(diff.body.items[0].change_flags.date_changed, true);
  });
});
