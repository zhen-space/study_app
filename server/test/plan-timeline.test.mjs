// 段考進度時間軸（projection）迴歸。純讀 CURRENT world，投影出「日期區間 → 應完成內容」。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'tl-')), 'tl.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const sched = await import('../src/schedule/persistence.js');
const { getPlanTimeline } = await import('../src/routes/schedule.js');
const { buildPlanTimeline } = await import('../src/schedule/timeline.js');
const { todayTW, addDays } = await import('../src/util/date.js');

const TODAY = todayTW();
const D = n => addDays(TODAY, n);
let uid = 8000;
const nextUser = () => ++uid;

async function mkUser(id) {
  await q.run('INSERT INTO users (id,email,password_hash,sleep_start,sleep_end,meal_windows) VALUES (?,?,?,?,?,?)',
    [id, `tl${id}@t`, 'x', '23:00', '07:00', '[]']);
}
async function mkPlan(u, status = 'active', target = D(30)) {
  return (await q.run('INSERT INTO plans (user_id,name,status,target_date) VALUES (?,?,?,?)', [u, `計畫${u}`, status, target])).lastInsertRowid;
}
async function mkList(u, name = '數學') {
  return (await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [u, name])).lastInsertRowid;
}
async function mkTask(u, planId, listId, o = {}) {
  return (await q.run(
    `INSERT INTO tasks (user_id,list_id,title,plan_id,estimated_minutes,deadline_date,deadline_time,task_kind,school_assignment_type,material_content_item_id,material_book_id,completed,cancelled,deleted)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [u, listId, o.title || '任務', planId, o.est ?? 60, o.deadline_date ?? null, o.deadline_time ?? null,
      o.kind || 'standard', o.sat ?? null, o.mci ?? null, o.mbook ?? null, o.completed ? 1 : 0, o.cancelled ? 1 : 0, o.deleted ? 1 : 0])).lastInsertRowid;
}
async function seedVersion(u, blocks) {
  return (await sched.createScheduleVersion(u, { source: sched.SOURCE.INITIAL, effectiveFrom: D(0), blocks })).version_id;
}
async function mkMaterial(u, listId, { chapter = '第一章', section = null, item = '閱讀' } = {}) {
  const book = (await q.run('INSERT INTO material_books (user_id,title,subject_list_id) VALUES (?,?,?)', [u, '課本', listId])).lastInsertRowid;
  const ch = (await q.run('INSERT INTO material_nodes (user_id,book_id,parent_id,kind,title) VALUES (?,?,?,?,?)', [u, book, null, 'chapter', chapter])).lastInsertRowid;
  let node = ch;
  if (section) node = (await q.run('INSERT INTO material_nodes (user_id,book_id,parent_id,kind,title) VALUES (?,?,?,?,?)', [u, book, ch, 'section', section])).lastInsertRowid;
  const cid = (await q.run('INSERT INTO material_content_items (user_id,book_id,node_id,kind,title,estimated_minutes) VALUES (?,?,?,?,?,?)', [u, book, node, 'reading', item, 60])).lastInsertRowid;
  return { book, cid };
}
const tl = async (u, planId) => (await getPlanTimeline(u, planId)).body;

before(async () => { await initSchema(); });

describe('段考進度時間軸 projection', () => {
  test('T1 同一 Task 多個 block 合併成單一完成區間（不重複列）', async () => {
    const u = nextUser(); await mkUser(u);
    const plan = await mkPlan(u); const list = await mkList(u);
    const t = await mkTask(u, plan, list, { est: 120, title: '數學 Ch1' });
    await seedVersion(u, [
      { task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: t, date: D(4), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
    ]);
    const r = await tl(u, plan);
    const item = r.items.find(i => i.task_id === Number(t));
    assert.equal(item.display_mode, 'range');
    assert.equal(item.range_start, D(2));
    assert.equal(item.range_end, D(4));
    assert.equal(item.block_ids.length, 2);
    assert.equal(item.day_blocks.length, 2);
    assert.equal(item.planned_minutes, 120);
    // segments：一個區間、一個科目群組、只列這個 task 一次。
    assert.equal(r.segments.length, 1);
    assert.deepEqual(r.segments[0].groups[0].task_ids, [Number(t)]);
  });

  test('T2 Material Task 顯示科目 + 教材 + 章節路徑', async () => {
    const u = nextUser(); await mkUser(u);
    const list = await mkList(u, '物理'); const plan = await mkPlan(u);
    const { book, cid } = await mkMaterial(u, list, { chapter: '力學', section: '牛頓運動定律', item: '例題 1' });
    const t = await mkTask(u, plan, list, { est: 60, title: '力學 例題 1', mci: cid, mbook: book });
    await seedVersion(u, [{ task_id: t, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const item = (await tl(u, plan)).items.find(i => i.task_id === Number(t));
    assert.equal(item.kind, 'material');
    assert.equal(item.subject_name, '物理');
    assert.equal(item.material.book_title, '課本');
    assert.deepEqual(item.material.path.map(p => p.title), ['力學', '牛頓運動定律']);
    assert.equal(item.material.item_title, '例題 1');
  });

  test('T3 School Assignment 以 deadline 呈現，deadline_date/time 完整保留、不被 target 覆寫', async () => {
    const u = nextUser(); await mkUser(u);
    const list = await mkList(u); const plan = await mkPlan(u, 'active', D(30));
    const sa = await mkTask(u, plan, list, { kind: 'school_assignment', sat: 'homework', deadline_date: D(6), deadline_time: '18:00', title: '交物理講義' });
    await seedVersion(u, [{ task_id: sa, date: D(3), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const r = await tl(u, plan);
    const item = r.items.find(i => i.task_id === Number(sa));
    assert.equal(item.display_mode, 'deadline');
    assert.equal(item.deadline_date, D(6));
    assert.equal(item.deadline_time, '18:00');
    assert.ok(r.deadlines.some(d => d.task_id === Number(sa)), '應在 deadlines lane');
    assert.ok(!r.segments.some(s => s.groups.some(g => g.task_ids.includes(Number(sa)))), 'deadline 不混進日期區間 segment');
  });

  test('T4 在計畫內卻沒排入 → unscheduled，另列不混進時間軸', async () => {
    const u = nextUser(); await mkUser(u);
    const list = await mkList(u); const plan = await mkPlan(u);
    const placed = await mkTask(u, plan, list, { est: 60, title: '已排' });
    const unp = await mkTask(u, plan, list, { est: 60, title: '沒排' });
    await seedVersion(u, [{ task_id: placed, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const r = await tl(u, plan);
    assert.ok(r.unscheduled.some(i => i.task_id === Number(unp)));
    assert.ok(!r.segments.some(s => s.groups.some(g => g.task_ids.includes(Number(unp)))));
  });

  test('T5 完成／實際學習狀態：completed vs in_progress vs not_started（不冒充計畫）', async () => {
    const u = nextUser(); await mkUser(u);
    const list = await mkList(u); const plan = await mkPlan(u);
    const done = await mkTask(u, plan, list, { est: 60, title: '已完成', completed: true });
    const prog = await mkTask(u, plan, list, { est: 60, title: '進行中' });
    const fresh = await mkTask(u, plan, list, { est: 60, title: '未開始' });
    await seedVersion(u, [
      { task_id: prog, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: fresh, date: D(2), start_time: '20:10', end_time: '21:10', planned_minutes: 60 },
    ]);
    // prog 有實際 StudySession；done 已完成（不在 active blocks，但仍是 CURRENT task）。
    await q.run('INSERT INTO study_sessions (user_id,task_id,started_at,actual_minutes,status,source) VALUES (?,?,?,?,?,?)',
      [u, prog, `${D(0)}T10:00:00`, 20, 'completed', 'manual']);
    const r = await tl(u, plan);
    assert.equal(r.items.find(i => i.task_id === Number(done)).completion, 'completed');
    assert.equal(r.items.find(i => i.task_id === Number(prog)).completion, 'in_progress');
    assert.equal(r.items.find(i => i.task_id === Number(fresh)).completion, 'not_started');
  });

  test('T6 沒有 active ScheduleVersion → no_active_schedule，不捏造完成區間', async () => {
    const u = nextUser(); await mkUser(u);
    const list = await mkList(u); const plan = await mkPlan(u);
    await mkTask(u, plan, list, { est: 60, title: '任務' });
    const r = await tl(u, plan);
    assert.equal(r.no_active_schedule, true);
    assert.equal(r.range, null);
    assert.equal(r.segments.length, 0);
    assert.ok(r.unscheduled.length >= 1, '無排程時任務列在 unscheduled，不捏造區間');
  });

  test('T7 block 超過有效上限（deadline/target）→ gap 明確標記，不假裝乾淨區間', async () => {
    const u = nextUser(); await mkUser(u);
    const list = await mkList(u); const plan = await mkPlan(u, 'active', D(30));
    const t = await mkTask(u, plan, list, { est: 60, deadline_date: D(1), title: '期限已過卻排在後面' });
    await seedVersion(u, [{ task_id: t, date: D(5), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const r = await tl(u, plan);
    const item = r.items.find(i => i.task_id === Number(t));
    assert.equal(item.display_mode, 'gap');
    assert.ok(item.warnings.includes('deadline_violation'));
    assert.ok(r.gaps.some(g => g.task_id === Number(t)));
    assert.ok(!r.segments.some(s => s.groups.some(g => g.task_ids.includes(Number(t)))), 'gap 不混進正常時間軸');
  });

  test('T8 非現役計畫（paused）唯讀：不進入現役排程（忽略舊 active blocks）', async () => {
    const u = nextUser(); await mkUser(u);
    const list = await mkList(u); const plan = await mkPlan(u, 'active');
    const t = await mkTask(u, plan, list, { est: 60, title: 'x' });
    await seedVersion(u, [{ task_id: t, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    await q.run('UPDATE plans SET status=? WHERE id=? AND user_id=?', ['paused', plan, u]);
    const r = await tl(u, plan);
    assert.equal(r.active, false);
    assert.equal(r.no_active_schedule, true);
    assert.equal(r.segments.length, 0, 'paused 計畫不投影現役排程區間');
    assert.ok(r.items.every(i => i.display_mode !== 'range'));
  });

  test('T9 同區間多科目 → 一個 segment、多個科目群組', async () => {
    const u = nextUser(); await mkUser(u);
    const math = await mkList(u, '數學'); const phys = await mkList(u, '物理'); const plan = await mkPlan(u);
    const a = await mkTask(u, plan, math, { est: 60, title: '數 Ch3' });
    const b = await mkTask(u, plan, phys, { est: 60, title: '物 U1' });
    await seedVersion(u, [
      { task_id: a, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 },
      { task_id: b, date: D(2), start_time: '20:10', end_time: '21:10', planned_minutes: 60 },
    ]);
    const r = await tl(u, plan);
    assert.equal(r.segments.length, 1);
    const subs = r.segments[0].groups.map(g => g.subject_name).sort();
    assert.deepEqual(subs, ['數學', '物理'].sort());
  });

  test('T10 CURRENT world：版本建立後新增的 Task 仍出現（不因舊版本而遺失）', async () => {
    const u = nextUser(); await mkUser(u);
    const list = await mkList(u); const plan = await mkPlan(u);
    const t1 = await mkTask(u, plan, list, { est: 60, title: '原本' });
    await seedVersion(u, [{ task_id: t1, date: D(2), start_time: '19:00', end_time: '20:00', planned_minutes: 60 }]);
    const t2 = await mkTask(u, plan, list, { est: 60, title: '後來加入' });   // 不在該版本
    const r = await tl(u, plan);
    assert.ok(r.items.some(i => i.task_id === Number(t2)), '後加入的 CURRENT task 不得遺失');
    assert.ok(r.unscheduled.some(i => i.task_id === Number(t2)));
  });

  test('T11 buildPlanTimeline 純函式：空計畫 → empty', () => {
    const r = buildPlanTimeline({ plan: { id: 1, status: 'active', target_date: null }, activeVersionId: 1, tasks: [], blocks: [], today: TODAY });
    assert.equal(r.empty, true);
    assert.equal(r.segments.length, 0);
  });
});
