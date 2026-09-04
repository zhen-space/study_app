// Plan lifecycle cleanup：暫停／刪除計畫時，未完成 Task 要怎麼處理。
//
// 直接呼叫 persistence service（不走 HTTP），因為要驗的是 transaction 內部的
// 事實：Task 到底被改成什麼、舊版本有沒有被動到、lock 有沒有被釋放、
// material_progress 有沒有被碰。這些走 API 只看得到表面。
//
// 每個測試自己開一個 user，避免互相污染。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'plan-cleanup-')), 'db.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const sched = await import('../src/schedule/persistence.js');
const { planTaskDisposition, parseRetainChoice } = await import('../src/schedule/plan-cleanup.js');
const { todayTW } = await import('../src/util/date.js');

before(async () => { await initSchema(); });

let nextUser = 100;
const tomorrow = () => {
  const d = new Date(todayTW() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// 一個完整的樣本：計畫 + 兩個未完成 Task + 一個已完成 Task，
// 未完成 Task 都已經有明天的 ScheduledBlock（active version）。
async function seed({ status = 'active' } = {}) {
  const userId = nextUser++;
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, `u${userId}@t`, 'x']);
  const list = (await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [userId, '數學'])).lastInsertRowid;
  const planId = (await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)',
    [userId, '段考計畫', status])).lastInsertRowid;
  const mk = (title, over = {}) => q.run(
    `INSERT INTO tasks (user_id,list_id,title,plan_id,completed,completed_at,deadline_date,notes,
                        estimated_minutes,material_book_id,material_content_item_id,due_date,due_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [userId, list, title, planId, over.completed ?? 0, over.completed_at ?? null,
      over.deadline_date ?? null, over.notes ?? '', over.estimated_minutes ?? 60,
      over.material_book_id ?? null, over.material_content_item_id ?? null,
      over.due_date ?? null, over.due_time ?? null]);
  const openA = (await mk('第一章', {
    deadline_date: '2099-12-31', notes: '重點在例題', material_book_id: 7,
    material_content_item_id: 9, due_date: tomorrow(), due_time: '19:00',
  })).lastInsertRowid;
  const openB = (await mk('第二章', { due_date: tomorrow() })).lastInsertRowid;
  const done = (await mk('第零章', { completed: 1, completed_at: '2026-01-01T00:00:00Z' })).lastInsertRowid;

  // 另一個計畫的未完成 Task：它的未來安排必須被完整帶到新版本
  const otherPlanId = (await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)',
    [userId, '其他計畫', 'active'])).lastInsertRowid;
  const otherTask = (await q.run('INSERT INTO tasks (user_id,list_id,title,plan_id) VALUES (?,?,?,?)',
    [userId, list, '別的計畫的任務', otherPlanId])).lastInsertRowid;

  const version = await sched.createScheduleVersion(userId, {
    source: sched.SOURCE.INITIAL,
    effectiveFrom: todayTW(),
    blocks: [
      { task_id: openA, date: tomorrow(), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: openB, date: tomorrow(), start_time: '20:00', end_time: '21:00', planned_minutes: 60 },
      { task_id: otherTask, date: tomorrow(), start_time: '21:00', end_time: '22:00', planned_minutes: 60 },
    ],
  });
  return { userId, planId, otherPlanId, openA, openB, done, otherTask, versionId: version.id ?? version.version_id };
}

const task = (id) => q.get('SELECT * FROM tasks WHERE id=?', [id]);
const plan = (id) => q.get('SELECT * FROM plans WHERE id=?', [id]);
const activeBlocks = async (userId) => {
  const st = await q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
  return q.all('SELECT * FROM scheduled_blocks WHERE user_id=? AND schedule_version_id=? ORDER BY task_id',
    [userId, st.active_version_id]);
};

describe('retain 選項：只有暫停用得到', () => {
  test('缺少、字串、數字、null 一律拒絕；只有 boolean 通過', () => {
    for (const body of [{}, null, undefined, { retain_incomplete_tasks: 'true' },
      { retain_incomplete_tasks: 1 }, { retain_incomplete_tasks: 0 },
      { retain_incomplete_tasks: null }, { retain_incomplete_tasks: 'false' }]) {
      const r = parseRetainChoice(body);
      assert.equal(r.ok, false, `${JSON.stringify(body)} 不該被接受`);
      assert.equal(r.code, 'retain_choice_required');
    }
    assert.deepEqual(parseRetainChoice({ retain_incomplete_tasks: true }), { ok: true, value: true });
    assert.deepEqual(parseRetainChoice({ retain_incomplete_tasks: false }), { ok: true, value: false });
  });

  test('各動作的處置：暫停看 retain，刪除一律清掉全部', () => {
    // 暫停＋保留 → 全留；暫停＋不保留 → 未完成軟刪
    assert.deepEqual(planTaskDisposition({ action: 'pause', retain: true }),
      { mode: 'none', scope: 'incomplete' });
    assert.deepEqual(planTaskDisposition({ action: 'pause', retain: false }),
      { mode: 'soft_delete', scope: 'incomplete' });
    // 刪除沒有 retain：不管有沒有給，一律 soft-delete 所有 Task
    assert.deepEqual(planTaskDisposition({ action: 'delete' }),
      { mode: 'soft_delete', scope: 'all' });
    assert.deepEqual(planTaskDisposition({ action: 'delete', retain: true }),
      { mode: 'soft_delete', scope: 'all' }, '刪除忽略 retain');
    assert.deepEqual(planTaskDisposition({ action: 'delete', retain: false }),
      { mode: 'soft_delete', scope: 'all' });
    // 舊的「刪除＋保留 → detach standalone」行為必須完全消失
    for (const d of [planTaskDisposition({ action: 'delete', retain: true }),
      planTaskDisposition({ action: 'delete' })]) {
      assert.equal('detach' in d, false, 'detach 語意必須整個移除');
    }
    assert.throws(() => planTaskDisposition({ action: 'archive', retain: true }), /未知/);
    assert.throws(() => planTaskDisposition({ action: 'pause', retain: 'true' }), /boolean/);
  });
});

describe('暫停並保留未完成任務', () => {
  test('Task 留在原計畫、未來 block 移除、已完成與歷史全部保留', async () => {
    const s = await seed();
    const before = await q.all('SELECT * FROM scheduled_blocks WHERE schedule_version_id=?', [s.versionId]);
    assert.equal(before.length, 3);

    await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'paused', cleanupAction: 'pause', retainIncompleteTasks: true });

    const p = await plan(s.planId);
    assert.equal(p.status, 'paused');
    assert.ok(p.paused_at);
    assert.equal(p.lifecycle_retained_tasks, 1);

    for (const id of [s.openA, s.openB]) {
      const t = await task(id);
      assert.equal(Number(t.plan_id), Number(s.planId), '未完成 Task 仍歸屬原計畫');
      assert.equal(Number(t.deleted ?? 0), 0);
    }
    // 這個計畫的未來 block 不見了，別的計畫的還在
    const now = await activeBlocks(s.userId);
    assert.deepEqual(now.map(b => Number(b.task_id)), [s.otherTask]);
    // 排程鏡射也跟著清乾淨：計畫暫停之後不該還顯示「明天要做」
    assert.equal((await task(s.openA)).due_date, null);
    assert.equal((await task(s.openA)).due_time, null);
    assert.equal((await task(s.otherTask)).due_date, tomorrow(), '別的計畫的鏡射不受影響');

    // 已完成 Task 原封不動
    const d = await task(s.done);
    assert.equal(Number(d.completed), 1);
    assert.equal(d.completed_at, '2026-01-01T00:00:00Z');
    assert.equal(Number(d.deleted ?? 0), 0);

    // 舊版本是 immutable snapshot：三個 block 一個都不能少
    const old = await q.all('SELECT * FROM scheduled_blocks WHERE schedule_version_id=?', [s.versionId]);
    assert.equal(old.length, 3);
  });

  test('恢復後重新取得排程資格，但不會自動長回舊 block', async () => {
    const s = await seed();
    await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'paused', cleanupAction: 'pause', retainIncompleteTasks: true });
    await sched.transitionPlanLifecycle(s.userId, s.planId, { nextStatus: 'active' });

    assert.equal((await plan(s.planId)).status, 'active');
    const now = await activeBlocks(s.userId);
    assert.deepEqual(now.map(b => Number(b.task_id)), [s.otherTask], '舊 block 不得自動復活');
    // 但它們回到了 unplaced —— 也就是重新有資格被排
    const st = await q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [s.userId]);
    const unplaced = await sched.getUnplaced(s.userId, st.active_version_id);
    assert.deepEqual(unplaced.map(t => Number(t.id)).sort((a, b) => a - b), [s.openA, s.openB].sort((a, b) => a - b));
  });
});

describe('暫停但不保留未完成任務', () => {
  test('未完成 Task 走 soft-delete，不是 hard delete；恢復後不復活', async () => {
    const s = await seed();
    await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'paused', cleanupAction: 'pause', retainIncompleteTasks: false });

    assert.equal((await plan(s.planId)).lifecycle_retained_tasks, 0);
    for (const id of [s.openA, s.openB]) {
      const t = await task(id);
      assert.ok(t, '必須還在資料表裡——不得 hard delete');
      assert.equal(Number(t.deleted), 1);
      assert.equal(Number(t.plan_id), Number(s.planId), '軟刪除保留歸屬，歷史才看得懂');
    }
    assert.equal(Number((await task(s.done)).deleted ?? 0), 0, '已完成 Task 不受影響');

    await sched.transitionPlanLifecycle(s.userId, s.planId, { nextStatus: 'active' });
    for (const id of [s.openA, s.openB]) {
      assert.equal(Number((await task(id)).deleted), 1, '恢復計畫不得讓已刪除的任務復活');
    }
    const st = await q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [s.userId]);
    assert.deepEqual(await sched.getUnplaced(s.userId, st.active_version_id), []);
  });
});

describe('刪除計畫：所有任務一律 soft-delete，不 detach', () => {
  test('未完成、已完成、已取消的 Task 全部 soft-delete，plan_id 保留、絕不 standalone', async () => {
    const s = await seed();
    // 追加一個已取消的 Task，證明「所有狀態」都被涵蓋
    const cancelled = (await q.run(
      `INSERT INTO tasks (user_id,plan_id,title,cancelled,cancelled_at) VALUES (?,?,?,?,?)`,
      [s.userId, s.planId, '不做了', 1, '2026-01-02T00:00:00Z'])).lastInsertRowid;

    await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'deleted', cleanupAction: 'delete' });

    const p = await plan(s.planId);
    assert.equal(p.status, 'deleted');
    assert.ok(p.deleted_at, 'tombstone 必須留下刪除時間');

    // 未完成、已完成、已取消 —— 全部 deleted=1，全部保留 plan_id（絕不 detach）
    for (const id of [s.openA, s.openB, s.done, cancelled]) {
      const t = await task(id);
      assert.equal(Number(t.deleted), 1, `#${id} 必須被 soft-delete`);
      assert.equal(Number(t.plan_id), Number(s.planId), `#${id} 不得 detach 成 standalone`);
    }
    // 未完成 Task 的內容欄位不因刪除而被抹掉（soft-delete 只翻 deleted 旗標）
    const a = await task(s.openA);
    assert.equal(a.deadline_date, '2099-12-31');
    assert.equal(Number(a.material_content_item_id), 9);

    // 別的計畫的安排完全不受影響
    const now = await activeBlocks(s.userId);
    assert.deepEqual(now.map(b => Number(b.task_id)), [s.otherTask]);
    // 歷史版本是 immutable snapshot，一列都不能少
    const old = await q.all('SELECT * FROM scheduled_blocks WHERE schedule_version_id=?', [s.versionId]);
    assert.equal(old.length, 3, '歷史版本不得被修改');
  });

  test('刪除不需要、也不接受 retain：帶了也一律刪除全部任務', async () => {
    const s = await seed();
    // 就算誤帶 retain=true，也不會有任何 Task 存活成 standalone
    await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'deleted', cleanupAction: 'delete', retainIncompleteTasks: true });
    for (const id of [s.openA, s.openB, s.done]) {
      const t = await task(id);
      assert.equal(Number(t.deleted), 1);
      assert.notEqual(t.plan_id, null, '任何情況都不得出現 standalone');
    }
  });

  test('刪除是終點：不能再轉成任何狀態', async () => {
    const s = await seed();
    await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'deleted', cleanupAction: 'delete' });
    for (const nextStatus of ['active', 'paused', 'archived', 'completed', 'ended', 'deleted']) {
      await assert.rejects(
        () => sched.transitionPlanLifecycle(s.userId, s.planId, { nextStatus }),
        /已經刪除/, `不該允許 deleted → ${nextStatus}`);
    }
  });
});

describe('Material 安全', () => {
  test('暫停／刪除不會完成教材，也不會改寫 material_progress', async () => {
    for (const [action, nextStatus, retain] of [
      ['pause', 'paused', true], ['pause', 'paused', false],
      ['delete', 'deleted', true], ['delete', 'deleted', false],
    ]) {
      const s = await seed();
      await q.run(
        `INSERT INTO material_progress (user_id,content_item_id,completed,completed_at)
         VALUES (?,?,?,?)`, [s.userId, 9, 0, null]);
      const before = await q.get('SELECT * FROM material_progress WHERE user_id=? AND content_item_id=9', [s.userId]);

      await sched.transitionPlanLifecycle(s.userId, s.planId,
        { nextStatus, cleanupAction: action, retainIncompleteTasks: retain });

      const after = await q.get('SELECT * FROM material_progress WHERE user_id=? AND content_item_id=9', [s.userId]);
      assert.deepEqual(after, before, `${action}/retain=${retain} 不得改動 material_progress`);
      assert.equal(Number(after.completed), 0, '取消計畫選取不等於完成教材');
    }
  });
});

describe('ScheduleVersion 與 Lock', () => {
  test('產生新版本、舊版本不變、active 指標切過去', async () => {
    const s = await seed();
    const beforeVersions = (await q.get('SELECT COUNT(*) c FROM schedule_versions WHERE user_id=?', [s.userId])).c;
    const out = await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'paused', cleanupAction: 'pause', retainIncompleteTasks: true });

    assert.ok(out.version, '必須產生新的 ScheduleVersion');
    const row = await q.get('SELECT * FROM schedule_versions WHERE id=?', [out.version.version_id]);
    assert.equal(row.source, 'lifecycle');
    assert.match(row.reason, /暫停/);
    assert.equal(Number(row.parent_version_id), Number(s.versionId), '新版本掛在原本的 active 底下');
    const afterVersions = (await q.get('SELECT COUNT(*) c FROM schedule_versions WHERE user_id=?', [s.userId])).c;
    assert.equal(afterVersions, beforeVersions + 1);
    const st = await q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [s.userId]);
    assert.equal(Number(st.active_version_id), Number(out.version.version_id));
    assert.notEqual(Number(st.active_version_id), Number(s.versionId));
  });

  test('計畫底下 Task 的鎖會被釋放並留下理由，day 鎖不動', async () => {
    const s = await seed();
    await q.run('INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,?,?)', [s.userId, 'task', s.openA]);
    // 別的計畫的任務鎖不受影響
    await q.run('INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,?,?)', [s.userId, 'task', s.otherTask]);
    // day 鎖鎖的是整體排程，不屬於任何計畫；挑一個不會被這次變動碰到的日子
    await q.run('INSERT INTO schedule_locks (user_id,type,date) VALUES (?,?,?)', [s.userId, 'day', '2099-01-01']);

    await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'paused', cleanupAction: 'pause', retainIncompleteTasks: true });

    const locks = await q.all('SELECT * FROM schedule_locks WHERE user_id=? ORDER BY id', [s.userId]);
    assert.ok(locks[0].released_at, '計畫底下的 Task 鎖必須被釋放');
    assert.equal(locks[0].release_reason, 'plan_paused');
    assert.equal(locks[1].released_at, null, '別的計畫的 Task 鎖不得被動到');
    assert.equal(locks[2].released_at, null, 'day 鎖不屬於任何計畫，不得自動解除');
  });

  test('刪除計畫時釋放理由是 plan_deleted', async () => {
    const s = await seed();
    await q.run('INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,?,?)', [s.userId, 'task', s.openB]);
    await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'deleted', cleanupAction: 'delete', retainIncompleteTasks: true });
    const lock = await q.get('SELECT * FROM schedule_locks WHERE user_id=? AND task_id=?', [s.userId, s.openB]);
    assert.equal(lock.release_reason, 'plan_deleted');
  });

  test('day 鎖碰到這次要移除的安排時，整筆擋下來而不是偷偷解鎖', async () => {
    const s = await seed();
    await q.run('INSERT INTO schedule_locks (user_id,type,date) VALUES (?,?,?)', [s.userId, 'day', tomorrow()]);
    await assert.rejects(
      () => sched.transitionPlanLifecycle(s.userId, s.planId,
        { nextStatus: 'paused', cleanupAction: 'pause', retainIncompleteTasks: true }),
      err => err.name === 'ScheduleLockConflictError' && err.status === 409);
    // rollback：計畫、任務、鎖、active 版本全部回到原狀
    assert.equal((await plan(s.planId)).status, 'active');
    assert.equal(Number((await task(s.openA)).deleted ?? 0), 0);
    const lock = await q.get("SELECT * FROM schedule_locks WHERE user_id=? AND type='day'", [s.userId]);
    assert.equal(lock.released_at, null);
    const st = await q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [s.userId]);
    assert.equal(Number(st.active_version_id), Number(s.versionId));
  });
});

describe('Transaction rollback', () => {
  test('base_version_id 過期時整筆回滾，任務一個都不能被改到', async () => {
    const s = await seed();
    await assert.rejects(
      () => sched.transitionPlanLifecycle(s.userId, s.planId, {
        nextStatus: 'deleted', cleanupAction: 'delete', retainIncompleteTasks: false,
        baseVersionId: 999999,
      }));
    assert.equal((await plan(s.planId)).status, 'active');
    assert.equal((await plan(s.planId)).deleted_at, null);
    for (const id of [s.openA, s.openB]) {
      const t = await task(id);
      assert.equal(Number(t.deleted ?? 0), 0);
      assert.equal(Number(t.plan_id), Number(s.planId));
      assert.equal(t.due_date, tomorrow(), '排程鏡射不得被清掉');
    }
    const st = await q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [s.userId]);
    assert.equal(Number(st.active_version_id), Number(s.versionId));
  });

  test('沒有 active version 時仍然完成 lifecycle 與任務處理', async () => {
    const userId = nextUser++;
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, `u${userId}@t`, 'x']);
    const planId = (await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)',
      [userId, '沒排程的計畫', 'active'])).lastInsertRowid;
    const t = (await q.run('INSERT INTO tasks (user_id,title,plan_id,due_date) VALUES (?,?,?,?)',
      [userId, '任務', planId, tomorrow()])).lastInsertRowid;
    const out = await sched.transitionPlanLifecycle(userId, planId,
      { nextStatus: 'deleted', cleanupAction: 'delete' });
    assert.equal(out.version, null);
    assert.equal((await plan(planId)).status, 'deleted');
    const after = await task(t);
    assert.equal(Number(after.deleted), 1, '任務被 soft-delete');
    assert.equal(Number(after.plan_id), Number(planId), '不 detach，plan_id 保留');
  });
});

describe('封存功能已移除；既有 archived 舊資料仍可安全轉出', () => {
  test('任何進行中狀態都不能再轉成 archived', async () => {
    // 只需要一筆各狀態的 Plan（不需要 blocks），直接建列避免對 completed/ended
    // 建 ScheduleVersion 時的資格檢查
    for (const status of ['draft', 'active', 'paused', 'completed', 'ended']) {
      const userId = nextUser++;
      await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, `u${userId}@t`, 'x']);
      const planId = (await q.run('INSERT INTO plans (user_id,name,status) VALUES (?,?,?)',
        [userId, `${status} 計畫`, status])).lastInsertRowid;
      await assert.rejects(
        () => sched.transitionPlanLifecycle(userId, planId, { nextStatus: 'archived' }),
        /不能進行此狀態轉換/, `${status} → archived 應被拒絕`);
    }
  });

  test('刪除既有 archived 舊資料：所有 Task soft-delete，封存時間戳不被抹掉', async () => {
    const s = await seed();
    // 直接寫入一筆 archived 舊資料（模擬 production 既有資料，不經 transition）
    await q.run("UPDATE plans SET status='archived', archived_at='2026-01-01T00:00:00Z', archived_from_status='completed' WHERE id=?", [s.planId]);
    await sched.transitionPlanLifecycle(s.userId, s.planId,
      { nextStatus: 'deleted', cleanupAction: 'delete' });
    const p = await plan(s.planId);
    assert.equal(p.status, 'deleted');
    assert.equal(p.archived_at, '2026-01-01T00:00:00Z', 'tombstone 不得抹掉歷史時間戳');
    for (const id of [s.openA, s.openB, s.done]) {
      assert.equal(Number((await task(id)).deleted), 1);
    }
  });
});

// 這一組是靜態契約，不是行為測試。
//
// 理由：把候選版本的 `p.status IN ('draft','active')` 改回黑名單
// `p.status NOT IN ('paused',…)`，以今天的資料形狀跑起來行為完全一樣——
// 已刪除計畫底下不可能還有「未刪除、未完成、仍掛著 plan_id」的 Task，
// 所以任何行為測試都殺不掉那個突變。但黑名單本身就是缺陷：下一個新增的
// lifecycle 狀態會被預設當成「仍在排程」而安靜漏進未來安排，而那正是這次
// 加 'deleted' 時差點發生的事。所以直接守寫法。
describe('排程資格一律用白名單', () => {
  test('server/src 裡不得出現 p.status NOT IN 這種黑名單寫法', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files = [];
    (function walk(dir) {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.js')) files.push(full);
      }
    })(srcDir);
    assert.ok(files.length > 10, '應該掃到整個 src');

    const offenders = [];
    for (const file of files) {
      // 先去掉註解，免得這條測試被解釋文字自己絆倒
      const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
      if (/\bp\.status\s+NOT\s+IN/i.test(code) || /\bplan_status\s+NOT\s+IN/i.test(code)) {
        offenders.push(path.relative(srcDir, file));
      }
    }
    assert.deepEqual(offenders, [],
      '計畫排程資格必須列舉「哪些狀態可以排」，不是列舉「哪些不行」');
  });

  test('每一處 p.status IN (…) 列的都只有 draft／active', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const targets = ['schedule/persistence.js', 'routes/schedule.js', 'routes/ticktick.js'];
    const found = [];
    for (const rel of targets) {
      const code = readFileSync(path.join(srcDir, rel), 'utf8').replace(/\/\/.*$/gm, '');
      for (const m of code.matchAll(/p\.status\s+IN\s*\(([^)]*)\)/gi)) found.push([rel, m[1].replace(/\s/g, '')]);
    }
    assert.ok(found.length >= 5, `應該找得到多處資格判斷，實際 ${found.length}`);
    for (const [rel, list] of found) {
      assert.equal(list, "'draft','active'", `${rel} 的排程資格清單不該是 ${list}`);
    }
  });
});

describe('跨使用者隔離', () => {
  test('只能處理自己的計畫，而且不會動到別人同名的任務', async () => {
    const mine = await seed();
    const theirs = await seed();
    await assert.rejects(
      () => sched.transitionPlanLifecycle(theirs.userId, mine.planId,
        { nextStatus: 'deleted', cleanupAction: 'delete', retainIncompleteTasks: false }),
      /找不到這個計畫/);

    await sched.transitionPlanLifecycle(mine.userId, mine.planId,
      { nextStatus: 'deleted', cleanupAction: 'delete', retainIncompleteTasks: false });
    for (const id of [theirs.openA, theirs.openB]) {
      const t = await task(id);
      assert.equal(Number(t.deleted ?? 0), 0, '別人的任務不得被刪');
      assert.equal(Number(t.plan_id), Number(theirs.planId));
    }
    assert.equal((await plan(theirs.planId)).status, 'active');
    const blocks = await activeBlocks(theirs.userId);
    assert.equal(blocks.length, 3, '別人的排程不得被影響');
  });
});
