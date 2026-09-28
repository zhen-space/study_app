// 段考建立的**真正單一交易**原子性（P0-4）：直接呼叫 createExamPlanAtomic，
// 故意在「Plan＋Task 已插入之後」讓交易中途失敗，證明零可見殘留——
// 沒有 Plan、沒有 Task、沒有 plan_manual_scope、沒有 schedule_versions/blocks。
// 這是舊「補償刪除」做不到的：補償刪除的錯誤被吞掉就會留下半成品。
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'exam-atomic-')), 'ep.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const sched = await import('../src/schedule/persistence.js');
const { todayTW, addDays } = await import('../src/util/date.js');

const rel = n => addDays(todayTW(), n);
const USER = 1;
let subjId;

before(async () => {
  await initSchema();
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER, 'ep@test', 'x']);
});
beforeEach(async () => {
  // 每個案例都用乾淨的世界，確保「零殘留」斷言只反映這次呼叫。
  for (const t of ['scheduled_blocks', 'schedule_versions', 'user_schedule_state',
    'plan_manual_scope', 'plan_exam_subjects', 'plan_material_items', 'tasks', 'plans', 'lists']) {
    await q.run(`DELETE FROM ${t} WHERE user_id=?`, [USER]);
  }
  const l = await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [USER, '數學']);
  subjId = Number(l.lastInsertRowid);
});

const residue = async () => ({
  plans: (await q.get('SELECT COUNT(*) c FROM plans WHERE user_id=?', [USER])).c,
  tasks: (await q.get('SELECT COUNT(*) c FROM tasks WHERE user_id=?', [USER])).c,
  manual: (await q.get('SELECT COUNT(*) c FROM plan_manual_scope WHERE user_id=?', [USER])).c,
  subjects: (await q.get('SELECT COUNT(*) c FROM plan_exam_subjects WHERE user_id=?', [USER])).c,
  versions: (await q.get('SELECT COUNT(*) c FROM schedule_versions WHERE user_id=?', [USER])).c,
  blocks: (await q.get('SELECT COUNT(*) c FROM scheduled_blocks WHERE user_id=?', [USER])).c,
});
const base = extra => ({
  name: '段考', startDate: rel(0), endDate: rel(10), level: 'daily',
  subjects: [{ subject_list_id: subjId, exam_date: rel(5) }],
  materialIds: [], manual: [{ subject_list_id: subjId, label: '講義第三章', estimated_minutes: 60 }],
  ...extra,
});

describe('createExamPlanAtomic 單一交易原子性（P0-4）', () => {
  test('happy path：Plan＋Task＋各科考試日＋version＋block 一次建立', async () => {
    const { planId } = await sched.createExamPlanAtomic(USER, base({
      computedBlocks: [{ subject_id: subjId, title: '講義第三章', date: rel(2) }],
      scopeSig: null,
    }));
    assert.ok(planId);
    const r = await residue();
    assert.equal(r.plans, 1);
    assert.equal(r.tasks, 1);
    assert.equal(r.manual, 1);
    assert.equal(r.versions, 1);
    assert.equal(r.blocks, 1);
    const ms = await q.get('SELECT task_id FROM plan_manual_scope WHERE user_id=?', [USER]);
    assert.ok(ms.task_id, '手動 scope 應綁定 task_id');
  });

  test('中途失敗①：block 超過該科考試日（deadline 違反，發生在 Plan/Task 已插入之後）→ 零殘留', async () => {
    await assert.rejects(
      sched.createExamPlanAtomic(USER, base({
        computedBlocks: [{ subject_id: subjId, title: '講義第三章', date: rel(30) }], // > exam_date rel(5)
        scopeSig: null,
      })),
      e => e.name === 'ScheduleDeadlineViolationError' || e.code === 'DEADLINE_VIOLATION');
    assert.deepEqual(await residue(), { plans: 0, tasks: 0, manual: 0, subjects: 0, versions: 0, blocks: 0 });
  });

  test('中途失敗②：有 scope item 沒被任何 block 覆蓋 → EXAM_SCHEDULE_GAP，零殘留', async () => {
    await assert.rejects(
      sched.createExamPlanAtomic(USER, base({ computedBlocks: [], scopeSig: null })),
      e => e.code === 'EXAM_SCHEDULE_GAP');
    assert.deepEqual(await residue(), { plans: 0, tasks: 0, manual: 0, subjects: 0, versions: 0, blocks: 0 });
  });

  test('中途失敗③：block 對不到 CURRENT scope（stale）→ 零殘留', async () => {
    await assert.rejects(
      sched.createExamPlanAtomic(USER, base({
        computedBlocks: [{ subject_id: subjId, title: '這個範圍不存在', date: rel(2) }],
        scopeSig: null,
      })),
      e => e.code === 'STALE_SCHEDULE_PREVIEW');
    assert.deepEqual(await residue(), { plans: 0, tasks: 0, manual: 0, subjects: 0, versions: 0, blocks: 0 });
  });

  test('中途失敗④：scope 指紋與 preview 當時不一致（TOCTOU）→ 零殘留', async () => {
    await assert.rejects(
      sched.createExamPlanAtomic(USER, base({
        computedBlocks: [{ subject_id: subjId, title: '講義第三章', date: rel(2) }],
        scopeSig: 'STALE-SIGNATURE',
      })),
      e => e.code === 'STALE_SCHEDULE_PREVIEW');
    assert.deepEqual(await residue(), { plans: 0, tasks: 0, manual: 0, subjects: 0, versions: 0, blocks: 0 });
  });
});
