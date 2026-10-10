import { q } from '../db/init.js';
import { dayOfWeek, todayTW, isValidDay } from '../util/date.js';
import { checkLocks } from './locks.js';
import { calculateScheduleDiff } from './diff.js';
import { classifyPlacement, findSelfCollisions, timedOverlap } from './feasibility.js';
import { canonicalizeBlockTiming, timingProblem } from './timing.js';
import { planTaskDisposition, lockReleaseReason } from './plan-cleanup.js';
import { samePlacement, effectiveDeadlineViolation } from './rolling.js';
import { verifyMaterialSnapshotToken } from './material-token.js';
import { verifyExamSubjectToken } from './exam-subject-token.js';
import { signMaterialScopeRemovalToken, verifyMaterialScopeRemovalToken } from './material-scope-removal-token.js';
import { verifyExamPlanPreview } from './exam-plan-token.js';
import { buildExamProgressSegments } from './exam-progress.js';
import { createHash } from 'node:crypto';

// 手動調整的說法：使用者是「現在正要放」，不是「想恢復舊安排」。
const MANUAL_MESSAGES = {
  task_constraint: '這個任務已不屬於任何計畫，不能安排時間',
  past: '不能安排到已經過去的時間',
  deadline: '這一天已經超過這個任務的截止日',
  fixed_event: title => `這個時段與固定行程「${title}」重疊`,
};

// Phase 2C-P1：排程持久化。
//
// 契約：docs/phase2c-schedule-persistence.md（2C-1～2C-4 已定案）
//
// 這個檔案是**唯一**會寫 schedule_versions / scheduled_blocks /
// user_schedule_state 的地方，也是 2C 之後唯一會動 Plan Task
// due_date / due_time 的地方。routes 只呼叫這裡，不自己拼 SQL。
//
// 核心不變式：
//   ・ScheduleVersion 是 immutable future-schedule snapshot，寫完不再改
//   ・ScheduledBlock 是 Plan Task 排定時間的唯一 source of truth
//   ・block 只認 task_id，不存 plan_id（Plan 關係走 task.plan_id）
//   ・active version 的唯一來源是 user_schedule_state.active_version_id，
//     不做 MAX(version_no) 之類的 fallback 推導
//   ・snapshot 標題／科目只作顯示，不是 identity

export const SOURCE = {
  BOOTSTRAP: 'bootstrap',
  INITIAL: 'initial',
  MANUAL: 'manual',
  LIFECYCLE: 'lifecycle',
  AI_REPLAN: 'ai_replan',
  RESTORE: 'restore',
};

export const BOOTSTRAP_REASON = '從既有排定日期建立第一版';

// 送進持久化層的 block 不是「盡量寫進去」的資料；它必須是目前使用者一個
// 有效、未完成的 Plan Task。用明確錯誤讓 route / caller 能回報輸入問題，並讓
// transaction 在寫入任何 version metadata 前就 rollback。
export class ScheduleInputError extends Error {
  constructor(message, code = undefined) {
    super(message);
    this.name = 'ScheduleInputError';
    this.status = 400;
    if (code) this.code = code;
  }
}

// Restore 的 preview 只是一份「以當下資料推導出的提案」。真正套用前必須在
// transaction 內再算一次，並確認使用者看到的 active version 沒有變；這不是
// 可重試的 version_no 衝突，否則會靜默覆蓋使用者未看過的新排程。
export class ScheduleRestoreStaleError extends Error {
  constructor() {
    super('目前生效的排程已更新，請重新檢視恢復內容');
    this.name = 'ScheduleRestoreStaleError';
    this.status = 409;
    this.code = 'STALE_SCHEDULE_PREVIEW';
  }
}

export class ScheduleRestoreConfirmationError extends Error {
  constructor() {
    super('此版本只能部分恢復，請確認後再套用');
    this.name = 'ScheduleRestoreConfirmationError';
    this.status = 409;
  }
}

export class ScheduleVersionNotFoundError extends Error {
  constructor() {
    super('找不到這個版本');
    this.name = 'ScheduleVersionNotFoundError';
    this.status = 404;
  }
}

export class ScheduleLockConflictError extends Error {
  constructor(conflicts) { super('因鎖定無法重排，請先解鎖後再試'); this.name = 'ScheduleLockConflictError'; this.status = 409; this.conflicts = conflicts; }
}

export class MaterialScopeRemovalError extends Error {
  constructor(message, status = 409, code = 'MATERIAL_SCOPE_REMOVAL_FAILED') {
    super(message); this.name = 'MaterialScopeRemovalError'; this.status = status; this.code = code;
  }
}

const removalSnapshot = (userId, planId, contentItemId, activeVersionId, selection, task) => ({
  user_id: Number(userId), plan_id: Number(planId), content_item_id: Number(contentItemId),
  selection_id: Number(selection.id), selection_updated_at: selection.updated_at,
  linked_task_id: task?.id == null ? null : Number(task.id),
  task_completed: task == null ? null : Number(task.completed || 0),
  task_cancelled: task == null ? null : Number(task.cancelled || 0),
  task_deleted: task == null ? null : Number(task.deleted || 0),
  base_version_id: activeVersionId == null ? null : Number(activeVersionId),
});

async function materialScopeRemovalCurrent(db, userId, planId, contentItemId) {
  const plan = await db.get('SELECT id,status FROM plans WHERE id=? AND user_id=?', [planId, userId]);
  if (!plan) throw new MaterialScopeRemovalError('找不到這個計畫', 404, 'PLAN_NOT_FOUND');
  if (plan.status !== 'active') throw new MaterialScopeRemovalError('只有進行中的計畫可以移除教材範圍', 409, 'PLAN_NOT_ACTIVE');
  const selection = await db.get(
    `SELECT pmi.*,i.title FROM plan_material_items pmi
       JOIN material_content_items i ON i.id=pmi.content_item_id AND i.user_id=pmi.user_id
      WHERE pmi.user_id=? AND pmi.plan_id=? AND pmi.content_item_id=? AND pmi.selected=1`,
    [userId, planId, contentItemId]);
  if (!selection) throw new MaterialScopeRemovalError('這項教材已不在目前段考範圍，請重新整理', 409, 'MATERIAL_SCOPE_STALE');
  const state = await db.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
  const task = selection.task_id == null ? null : await db.get(
    'SELECT id,completed,cancelled,deleted,title FROM tasks WHERE id=? AND user_id=? AND plan_id=? AND material_content_item_id=?',
    [selection.task_id, userId, planId, contentItemId]);
  if (selection.task_id != null && !task) throw new MaterialScopeRemovalError('教材連結任務已變更，請重新整理', 409, 'MATERIAL_SCOPE_STALE');
  return { selection, task, activeVersionId: state?.active_version_id ?? null };
}

async function removalCandidate(db, userId, activeVersionId, task) {
  if (activeVersionId == null) return [];
  const cancelTaskId = task && !task.completed && !task.cancelled && !task.deleted ? Number(task.id) : null;
  const rows = await db.all(
    `SELECT b.task_id,b.date,b.start_time,b.end_time,b.planned_minutes
       FROM scheduled_blocks b JOIN tasks t ON t.id=b.task_id AND t.user_id=b.user_id
       JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
      WHERE b.user_id=? AND b.schedule_version_id=? AND (? IS NULL OR b.task_id<>?)
        AND COALESCE(t.deleted,0)=0 AND t.completed=0 AND COALESCE(t.cancelled,0)=0
        AND p.status IN ('draft','active') ORDER BY b.date,COALESCE(b.start_time,''),b.id`,
    [userId, activeVersionId, cancelTaskId, cancelTaskId]);
  return rows.map(canonicalizeBlockTiming);
}

export async function previewMaterialScopeRemoval(userId, { planId, contentItemId }) {
  const cur = await materialScopeRemovalCurrent(q, userId, Number(planId), Number(contentItemId));
  const candidate = await removalCandidate(q, userId, cur.activeVersionId, cur.task);
  await assertCandidateLocks(q, userId, cur.activeVersionId, candidate);
  const snap = removalSnapshot(userId, planId, contentItemId, cur.activeVersionId, cur.selection, cur.task);
  const removedBlocks = cur.activeVersionId == null || cur.task == null ? 0 : Number((await q.get(
    'SELECT COUNT(*) c FROM scheduled_blocks WHERE user_id=? AND schedule_version_id=? AND task_id=?',
    [userId, cur.activeVersionId, cur.task.id])).c || 0);
  return { plan_id: Number(planId), content_item_id: Number(contentItemId), title: cur.selection.title,
    base_version_id: cur.activeVersionId, linked_task_id: cur.task?.id ?? null,
    will_cancel_task: !!(cur.task && !cur.task.completed && !cur.task.cancelled && !cur.task.deleted),
    removed_block_count: removedBlocks, token: signMaterialScopeRemovalToken(snap) };
}

export async function applyMaterialScopeRemoval(userId, { planId, contentItemId, baseVersionId, token }) {
  const signed = verifyMaterialScopeRemovalToken(token);
  if (!signed || Number(signed.user_id) !== Number(userId) || Number(signed.plan_id) !== Number(planId)
      || Number(signed.content_item_id) !== Number(contentItemId)) {
    throw new MaterialScopeRemovalError('確認資料無效，請重新預覽', 409, 'MATERIAL_SCOPE_STALE');
  }
  return serializeWrite(() => withVersionNoRetry(() => q.tx(async tx => {
    const cur = await materialScopeRemovalCurrent(tx, userId, Number(planId), Number(contentItemId));
    const snap = removalSnapshot(userId, planId, contentItemId, cur.activeVersionId, cur.selection, cur.task);
    if (Number(baseVersionId ?? -1) !== Number(cur.activeVersionId ?? -1)
        || JSON.stringify(snap) !== JSON.stringify(signed)) {
      throw new MaterialScopeRemovalError('教材範圍或排程已更新，請重新預覽', 409, 'MATERIAL_SCOPE_STALE');
    }
    const candidate = await removalCandidate(tx, userId, cur.activeVersionId, cur.task);
    await assertCandidateLocks(tx, userId, cur.activeVersionId, candidate);
    await tx.run(`UPDATE plan_material_items SET selected=0,removed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
                   WHERE id=? AND user_id=? AND selected=1`, [cur.selection.id, userId]);
    const shouldCancel = cur.task && !cur.task.completed && !cur.task.cancelled && !cur.task.deleted;
    if (shouldCancel) await tx.run(
      `UPDATE tasks SET cancelled=1,cancelled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND user_id=? AND completed=0 AND COALESCE(cancelled,0)=0 AND COALESCE(deleted,0)=0`, [cur.task.id, userId]);
    // 尚未有任何版本的使用者也要能以 null 作 optimistic base；先在同一交易內
    // 建立空 state row，後面的 conditional swap 才能辨認「仍然沒有 active」。
    if (cur.activeVersionId == null) await tx.run(
      'INSERT INTO user_schedule_state (user_id,active_version_id) VALUES (?,NULL) ON CONFLICT(user_id) DO NOTHING', [userId]);
    const version = await createScheduleVersionInTx(tx, userId, {
      source: SOURCE.LIFECYCLE, reason: `移除教材範圍「${cur.selection.title}」`,
      parentVersionId: cur.activeVersionId, expectedActiveVersionId: cur.activeVersionId, blocks: candidate,
    });
    return { removed: true, cancelled_task_id: shouldCancel ? cur.task.id : null, version };
  })));
}

// Rolling（段考滾動排程）的 apply 期 defence-in-depth。preview 是 UX 防線，
// apply 仍在 transaction 內用「此刻的 DB 世界」再驗一次，不能只信前端送回的 candidate。
export class ScheduleStalePreviewError extends Error {
  constructor(activeVersionId) { super('排程在你預覽之後已被其他變更取代，請重新預覽'); this.name = 'ScheduleStalePreviewError'; this.status = 409; this.code = 'STALE_SCHEDULE_PREVIEW'; this.active_version_id = activeVersionId ?? null; }
}
export class ScheduleFreezeViolationError extends Error {
  constructor(violations) { super('今天／明天的既定安排必須維持不變'); this.name = 'ScheduleFreezeViolationError'; this.status = 409; this.code = 'FREEZE_VIOLATION'; this.violations = violations; }
}
export class ScheduleDeadlineViolationError extends Error {
  constructor(violations) { super('有安排超過任務的硬性截止時間'); this.name = 'ScheduleDeadlineViolationError'; this.status = 409; this.code = 'DEADLINE_VIOLATION'; this.violations = violations; }
}

// complete 的條件必須和 Plan status 寫入、ScheduleVersion 建立在同一筆交易中。
// 否則兩個請求交錯時，可能在 transaction 外看起來都已完成，實際上卻留下
// 尚未完成 Task 的 completed Plan。
export class PlanCompletionIncompleteError extends Error {
  constructor(unresolved) {
    super('仍有未完成任務，請先完成或取消；若不再繼續請結束計畫');
    this.name = 'PlanCompletionIncompleteError';
    this.status = 409;
    this.code = 'unresolved_tasks';
    this.unresolved = unresolved;
  }
}

// 資料完整性最後一道防線：preview 是 UX 層，不能假設所有 caller 都經過它。
// 只有同日、同時帶 start/end 的 block 才佔用實際時段；待辦模式的 date-only
// block 可以同日並存，絕不能被這裡誤判為碰撞。
export function validateTimedBlockOverlaps(blocks) {
  const timed = blocks
    .filter(b => b.date && b.start_time && b.end_time)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date)
      || a.start_time.localeCompare(b.start_time)
      || a.end_time.localeCompare(b.end_time));
  let previous = null;
  for (const block of timed) {
    if (previous && previous.date === block.date && block.start_time < previous.end_time) {
      throw new ScheduleInputError(`排程時段重疊：${block.date} ${block.start_time}–${block.end_time}`);
    }
    // 按 start_time 排序後，只需保留結束最晚的區塊，才能抓到巢狀 overlap。
    if (!previous || previous.date !== block.date || block.end_time > previous.end_time) previous = block;
  }
}

// 版本號競爭最多重試幾次（§7.2）
const VERSION_NO_RETRIES = 3;

/* ============================================================
   讀取
   ============================================================ */

// active version 的唯一來源。沒有 state 或 active_version_id 為 NULL
// ＝ 這個使用者還沒進入 2C persistence，呼叫端要走 legacy 路徑。
export async function getActiveVersionId(userId) {
  const st = await q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
  return st?.active_version_id ?? null;
}

export async function getActiveVersion(userId) {
  const id = await getActiveVersionId(userId);
  if (id == null) return null;
  return getVersion(userId, id);
}

// 一律 user scoped：別人的 version 一律當作不存在（回 null → route 回 404，
// 不是 403——不要洩漏「這個 id 存在」）
export async function getVersion(userId, versionId) {
  return q.get('SELECT * FROM schedule_versions WHERE id=? AND user_id=?', [versionId, userId]) ?? null;
}

export async function getBlocks(userId, versionId) {
  const rows = await q.all(
    `SELECT id, task_id, date, start_time, end_time, planned_minutes,
            task_title_snapshot, subject_name_snapshot
       FROM scheduled_blocks
      WHERE schedule_version_id=? AND user_id=?
      ORDER BY date, COALESCE(start_time,''), id`,
    [versionId, userId]);
  // init repair 會持久化修好；這一層則是 runtime safety net，確保極少數尚未經過
  // repair 的 historical row 不會在 Lock／manual path 以第三種 shape 流動。
  return rows.map(canonicalizeBlockTiming);
}

export async function getVersionWithBlocks(userId, versionId) {
  const version = await getVersion(userId, versionId);
  if (!version) return null;
  return { version, blocks: await getBlocks(userId, version.id) };
}

// 歷史 diff 一律 child → parent，使用 child.effective_from 排除已經成為歷史的
// base blocks。沒有 parent 的初版只回初次建立摘要，不把整份初始排程假裝成變更。
export async function getVersionDiff(userId, versionId, { includeUnchanged = true } = {}) {
  const candidate = await getVersion(userId, versionId);
  if (!candidate) return null;
  const after = await getBlocks(userId, candidate.id);
  if (candidate.parent_version_id == null) {
    return calculateScheduleDiff([], after, {
      comparisonFrom: candidate.effective_from,
      candidateVersionId: candidate.id,
      isInitial: true,
    });
  }
  const base = await getVersion(userId, candidate.parent_version_id);
  // 正常資料不會發生，但 parent 缺失時不能拿別人的 version 作 baseline。
  if (!base) return null;
  const before = await getBlocks(userId, base.id);
  return calculateScheduleDiff(before, after, {
    comparisonFrom: candidate.effective_from,
    baseVersionId: base.id,
    candidateVersionId: candidate.id,
    includeUnchanged,
  });
}

export async function listVersions(userId, limit = 30) {
  return q.all(
    `SELECT id, version_no, parent_version_id, restored_from_version_id,
            reason, source, effective_from, block_count, created_at
       FROM schedule_versions WHERE user_id=? ORDER BY version_no DESC LIMIT ?`,
    [userId, limit]);
}

// 在計畫裡但這一版沒有 block 的未完成任務 —— 這就是正式的 unplaced（§4.4）
export async function getUnplaced(userId, versionId) {
  return q.all(
    `SELECT t.id, t.title, t.plan_id, t.list_id, t.deadline_date, t.deadline_time
       FROM tasks t
       JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
      WHERE t.user_id=? AND t.plan_id IS NOT NULL
        AND COALESCE(t.deleted,0)=0 AND t.completed=0 AND COALESCE(t.cancelled,0)=0
        AND p.status IN ('draft','active')
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_blocks b
           WHERE b.schedule_version_id=? AND b.task_id=t.id)
      ORDER BY t.plan_id, t.id`,
    [userId, versionId ?? -1]);
}

export async function getActiveSchedule(userId) {
  const version = await getActiveVersion(userId);
  if (!version) return { active: false, version: null, blocks: [], unplaced: [] };
  const [blocks, unplaced] = await Promise.all([
    q.all(
      `SELECT b.id,b.task_id,b.date,b.start_time,b.end_time,b.planned_minutes,
              b.task_title_snapshot,b.subject_name_snapshot
         FROM scheduled_blocks b
         JOIN tasks t ON t.id=b.task_id AND t.user_id=b.user_id
         JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
        WHERE b.schedule_version_id=? AND b.user_id=?
          AND COALESCE(t.deleted,0)=0 AND t.completed=0 AND COALESCE(t.cancelled,0)=0
          AND p.status IN ('draft','active')
        ORDER BY b.date,COALESCE(b.start_time,''),b.id`, [version.id, userId]).then(rows => rows.map(canonicalizeBlockTiming)),
    getUnplaced(userId, version.id),
  ]);
  return { active: true, version, blocks, unplaced };
}

/* ============================================================
   Restore preview / apply（2C-P3）
   ============================================================ */

const twNowHM = () => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date());

const lockNow = () => ({ day: todayTW(), time: twNowHM() });
async function assertCandidateLocks(tx, userId, activeVersionId, candidate) {
  if (activeVersionId == null) return;
  const [locks, tasks, active] = await Promise.all([
    tx.all('SELECT * FROM schedule_locks WHERE user_id=? AND released_at IS NULL', [userId]),
    tx.all('SELECT id,deleted,completed,cancelled FROM tasks WHERE user_id=?', [userId]),
    tx.all('SELECT task_id,date,start_time,end_time,planned_minutes FROM scheduled_blocks WHERE user_id=? AND schedule_version_id=?', [userId, activeVersionId]),
  ]);
  const conflicts = checkLocks(candidate, active, locks, tasks, lockNow());
  if (conflicts.length) throw new ScheduleLockConflictError(conflicts);
}

async function getRestorePreviewFrom(db, userId, sourceVersionId, {
  planningDay = todayTW(), nowHM = twNowHM(),
} = {}) {
  const source = await db.get(
    'SELECT * FROM schedule_versions WHERE id=? AND user_id=?', [sourceVersionId, userId]);
  if (!source) return null;

  const [sourceBlocks, liveTasks, events, state, locks] = await Promise.all([
    db.all(`SELECT id, task_id, date, start_time, end_time, planned_minutes, task_title_snapshot
              FROM scheduled_blocks WHERE schedule_version_id=? AND user_id=?
             ORDER BY date, COALESCE(start_time,''), id`, [sourceVersionId, userId]),
    db.all(`SELECT t.id,t.title,t.plan_id,t.deadline_date,t.deadline_time,t.deleted,t.completed,t.cancelled,
                   p.status AS plan_status
              FROM tasks t LEFT JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
             WHERE t.user_id=?`, [userId]),
    db.all('SELECT date,start_time,end_time,recurring,title FROM fixed_events WHERE user_id=?', [userId]),
    db.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]),
    db.all('SELECT * FROM schedule_locks WHERE user_id=? AND released_at IS NULL', [userId]),
  ]);
  const tasks = new Map(liveTasks.map(t => [Number(t.id), t]));
  const candidates = [];
  const conflicts = [];
  const skipped = [];

  for (const rawBlock of sourceBlocks) {
    // 舊版 snapshot 可能早於 timing write gate。Restore 是把歷史 placement
    // 帶進新的版本，先以與 Lock / manual 相同的保守 canonical shape 讀取；
    // 這不放寬新 caller 的輸入驗證，而是不讓 Class A 半時段 row 毒化 restore。
    const block = canonicalizeBlockTiming(rawBlock);
    // 規則本身在 schedule/feasibility.js，跟手動調整共用同一份判定。
    const verdict = classifyPlacement(block, {
      task: tasks.get(Number(block.task_id)), events, planningDay, nowHM, dayOfWeek,
    });
    if (verdict?.kind === 'skip') { skipped.push({ task_id: block.task_id, reason: verdict.type }); continue; }
    if (verdict) {
      const { kind, ...rest } = verdict;
      conflicts.push({ task_id: block.task_id, block_id: block.id, ...rest, block });
      continue;
    }
    candidates.push({ id: block.id, task_id: block.task_id, date: block.date, start_time: block.start_time, end_time: block.end_time, planned_minutes: block.planned_minutes, task_title_snapshot: block.task_title_snapshot });
  }

  // 舊版若本身有 timed overlap，也不能因為它曾經存在就重新寫回 active snapshot。
  // 每一個撞到的 placement 都列出，讓 UI 明確告知無法恢復的原因。
  const collided = findSelfCollisions(candidates);
  const restorableBlocks = candidates.filter((block, i) => {
    if (!collided.has(i)) return true;
    conflicts.push({ task_id: block.task_id, block_id: block.id, type: 'schedule_collision', message: '這個版本內有重疊時段，無法原位恢復', block });
    return false;
  });
  // Restore 的 template 必須服從「現在」的 Lock；不回滾舊版當時 lock。
  const activeBlocks = state?.active_version_id == null ? [] : await db.all(
    'SELECT task_id,date,start_time,end_time,planned_minutes FROM scheduled_blocks WHERE user_id=? AND schedule_version_id=?',
    [userId, state.active_version_id]);
  const lockConflicts = checkLocks(restorableBlocks, activeBlocks, locks, liveTasks, { day: planningDay, time: nowHM });
  for (const c of lockConflicts) conflicts.push({ ...c, message: '因目前鎖定無法恢復原安排' });
  const violatedLocks = new Map(lockConflicts.map(c => [Number(c.lock_id), locks.find(l => Number(l.id) === Number(c.lock_id))]));

  // Lock conflict 不是把 Task 變成 unplaced。Restore 只放棄「舊位置」，
  // 並把現在 active 的受鎖 block 帶入新版本，讓 Task／時間／整日凍結語意成立。
  const belongsToLock = (block, lock) => lock.type === 'task'
    ? Number(block.task_id) === Number(lock.task_id)
    : lock.type === 'day'
      ? block.date === lock.date
      : block.date === lock.date && block.start_time && block.end_time
        && block.start_time < lock.end_time && lock.start_time < block.end_time;
  const activeLiveBlocks = activeBlocks.filter(block => {
    const task = tasks.get(Number(block.task_id));
    return task && !task.deleted && !task.completed && !task.cancelled && task.plan_id != null;
  });
  let lockedRestorable = restorableBlocks;
  for (const lock of violatedLocks.values()) {
    if (!lock) continue;
    lockedRestorable = lockedRestorable.filter(block => !belongsToLock(block, lock));
    lockedRestorable.push(...activeLiveBlocks.filter(block => belongsToLock(block, lock)));
  }
  // 多個 lock 可以覆蓋同一 block；寫入前維持一個 block 一份 placement。
  const seenPlacements = new Set();
  lockedRestorable = lockedRestorable.filter(block => {
    const key = [block.task_id, block.date, block.start_time || '', block.end_time || '', block.planned_minutes ?? ''].join('|');
    if (seenPlacements.has(key)) return false;
    seenPlacements.add(key);
    return true;
  });

  // §13 current-world overlay：舊版是「套在現在世界上的 placement template」。
  // source version 不知道、但目前 active schedule 有 placement 的 live Task，
  // restore 後必須**沿用現在的 placement**（而不是變 unplaced）。每一筆仍要通過
  // 現在的 deadline／past／fixed_event／collision 驗證；不合法就不 carry（維持
  // unplaced 或記為衝突），絕不 silent apply。Lock：current placement 本來就與
  // current lock 並存，且 apply 時 assertCandidateLocks 會在 transaction 內再驗一次。
  {
    const covered = new Set(lockedRestorable.map(b => Number(b.task_id)));
    for (const raw of activeLiveBlocks) {
      if (covered.has(Number(raw.task_id))) continue;
      const block = canonicalizeBlockTiming(raw);
      const verdict = classifyPlacement(block, { task: tasks.get(Number(block.task_id)), events, planningDay, nowHM, dayOfWeek });
      if (verdict) {
        if (verdict.kind !== 'skip') {
          const { kind, ...rest } = verdict;
          conflicts.push({ task_id: block.task_id, block_id: raw.id ?? null, ...rest, block, carried_current: true });
        }
        continue;   // 不合法 → 不 carry（保持 unplaced；skip 表示該 Task 已退出排程）
      }
      if (lockedRestorable.some(x => timedOverlap(x, block))) {
        conflicts.push({ task_id: block.task_id, type: 'schedule_collision', message: '與目前安排時段重疊，無法沿用', block, carried_current: true });
        continue;
      }
      lockedRestorable.push({ task_id: block.task_id, date: block.date, start_time: block.start_time, end_time: block.end_time, planned_minutes: block.planned_minutes });
      covered.add(Number(block.task_id));
    }
  }

  const scheduledIds = new Set(lockedRestorable.map(b => Number(b.task_id)));
  const conflictIds = new Set(conflicts.map(c => Number(c.task_id)));
  // template 中沒有、且目前 active schedule 也沒有 placement 的 live Task → unplaced。
  // 已完成／取消／刪除，或非 draft/active 計畫，都已退出 future schedule，不列入。
  const unplacedTaskIds = liveTasks.filter(t => t.plan_id != null && !t.deleted && !t.completed && !t.cancelled
    && ['draft', 'active'].includes(t.plan_status) && !scheduledIds.has(Number(t.id)))
    .map(t => Number(t.id));
  const status = lockedRestorable.length === 0
    ? (conflicts.length ? 'impossible' : 'nothing_to_restore')
    : (conflicts.length ? 'partial' : 'full');
  return {
    source_version_id: source.id,
    source_version: source,
    base_version_id: state?.active_version_id ?? null,
    planning_day: planningDay,
    status,
    restorable_blocks: lockedRestorable,
    conflicts,
    skipped,
    skipped_completed: skipped.filter(s => s.reason === 'completed').map(s => s.task_id),
    skipped_cancelled: skipped.filter(s => s.reason === 'cancelled').map(s => s.task_id),
    skipped_deleted: skipped.filter(s => s.reason === 'deleted').map(s => s.task_id),
    unplaced_task_ids: unplacedTaskIds,
    summary: {
      source_block_count: sourceBlocks.length,
      restorable_count: restorableBlocks.length,
      conflict_count: conflicts.length,
      skipped_count: skipped.length,
      unplaced_count: unplacedTaskIds.length,
      conflict_task_ids: [...conflictIds],
    },
  };
}

export async function getRestorePreview(userId, sourceVersionId) {
  return getRestorePreviewFrom(q, userId, sourceVersionId);
}

// `confirmPartial` 只允許使用者明確接受「衝突任務變 unplaced」時才建立 partial
// restore version。full 不需要二次確認；impossible/nothing 都不會寫任何資料。
export async function applyRestore(userId, sourceVersionId, { baseVersionId, confirmPartial = false } = {}) {
  if (!Number.isInteger(Number(sourceVersionId))) throw new ScheduleInputError('恢復版本不正確');
  return serializeWrite(() => withVersionNoRetry(() => q.tx(async tx => {
    const state = await tx.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
    const preview = await getRestorePreviewFrom(tx, userId, Number(sourceVersionId));
    if (!preview) throw new ScheduleVersionNotFoundError();
    if (Number(state?.active_version_id ?? -1) !== Number(baseVersionId ?? -1)) throw new ScheduleRestoreStaleError();
    // getRestorePreviewFrom 會讀現在的 state；上面的 stale 檢查與這裡必須一致。
    if (Number(preview.base_version_id ?? -1) !== Number(baseVersionId ?? -1)) throw new ScheduleRestoreStaleError();
    if (preview.status === 'nothing_to_restore' || preview.status === 'impossible') {
      return { applied: false, preview };
    }
    if (preview.status === 'partial' && !confirmPartial) throw new ScheduleRestoreConfirmationError();
    validateTimedBlockOverlaps(preview.restorable_blocks);
    // Preview 是 UX 防線；套用前仍需用 transaction 內此刻的 active + locks
    // 再檢查一次，避免 preview 與寫入間有任何繞過或競態。
    await assertCandidateLocks(tx, userId, state?.active_version_id ?? null, preview.restorable_blocks);
    const version = await createScheduleVersionInTx(tx, userId, {
      source: SOURCE.RESTORE,
      reason: `恢復版本 V${preview.source_version.version_no}`,
      effectiveFrom: preview.planning_day,
      parentVersionId: state?.active_version_id ?? null,
      restoredFromVersionId: preview.source_version.id,
      blocks: preview.restorable_blocks,
      expectedActiveVersionId: state?.active_version_id ?? null,
    });
    return { applied: true, version, preview };
  })));
}

/* ============================================================
   手動調整（2C-P6-A）
   ============================================================ */

// 使用者自己把某個 block 拖到別的日期／時段。
//
// 語意：這**不是**在編輯現在那一版，而是以現在的 active snapshot 為底，
// 換掉指定 block 的位置，產生一個全新的 source='manual' 版本。
// immutable snapshot 的不變式在這裡完全不打折。
//
// moves 以 block_id 指定，不是 task_id：一個任務可能被切成好幾個 block
// （timed 模式的 chunk），用 task_id 會把使用者沒碰的那幾塊一起弄掉。
//
// 刻意沒有 force / bypass 參數。手動調整不能繞過可行性——會撞固定行程、
// 超過硬性截止日、撞到別的 Plan、或違反鎖定的位置，就是不能放，
// 不是「使用者說了算」。要放得下就得先把擋路的東西改掉。
export class ScheduleManualConflictError extends Error {
  constructor(conflicts) {
    super('這個時間放不下，請看衝突原因');
    this.name = 'ScheduleManualConflictError';
    this.status = 409;
    this.conflicts = conflicts;
  }
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ScheduledBlock 的分鐘數不是 caller 可以自由指定的 metadata，而是 placement
// 本身的導出值。把這個規則放在 persistence 唯一寫入閘門，Wizard／Restore／
// Manual adjustment 都不會各自漂移；尤其 manual resize 不得沿用舊分鐘數。
export function normalizeBlockTiming(block) {
  const normalized = canonicalizeBlockTiming(block, { invalid: 'reject' });
  if (normalized) return normalized;
  if (timingProblem(block) === 'incomplete') throw new ScheduleInputError('請同時指定開始與結束時間');
  throw new ScheduleInputError('結束時間必須晚於開始時間');
}

// 單筆 move 的形狀檢查。時間要嘛兩個都給、要嘛兩個都不給（＝只排到某一天）。
function normalizeMove(move) {
  const blockId = Number(move?.block_id);
  if (!Number.isInteger(blockId)) throw new ScheduleInputError('缺少要調整的排程區塊');
  if (!YMD.test(move.date || '')) throw new ScheduleInputError('請指定有效的日期');
  const start = move.start_time || null;
  const end = move.end_time || null;
  if ((start == null) !== (end == null)) throw new ScheduleInputError('請同時指定開始與結束時間');
  if (start != null) {
    if (!canonicalizeBlockTiming({ start_time: start, end_time: end }, { invalid: 'reject' })) {
      throw new ScheduleInputError('結束時間必須晚於開始時間');
    }
  }
  return { block_id: blockId, date: move.date, start_time: start, end_time: end };
}

async function buildManualCandidate(db, userId, activeVersionId, moves, { planningDay, nowHM }) {
  const normalized = moves.map(normalizeMove);
  if (!normalized.length) throw new ScheduleInputError('沒有要調整的內容');
  const seen = new Set();
  for (const m of normalized) {
    if (seen.has(m.block_id)) throw new ScheduleInputError('同一個排程區塊不能重複調整');
    seen.add(m.block_id);
  }

  const [activeBlocks, liveTasks, events] = await Promise.all([
    db.all(`SELECT id, task_id, date, start_time, end_time, planned_minutes
              FROM scheduled_blocks WHERE schedule_version_id=? AND user_id=?
             ORDER BY date, COALESCE(start_time,''), id`, [activeVersionId, userId]),
    db.all('SELECT id, title, plan_id, deadline_date, deadline_time, deleted, completed, cancelled FROM tasks WHERE user_id=?', [userId]),
    db.all('SELECT date,start_time,end_time,recurring,title FROM fixed_events WHERE user_id=?', [userId]),
  ]);
  const tasks = new Map(liveTasks.map(t => [Number(t.id), t]));

  // ScheduleVersion 是 **future**-schedule snapshot（§7.1）。active version 會隨
  // 時間老化：三天前建立的 V10 裡有已經過去的 block。把整份原封不動抄進新版本，
  // 等於每調一次時間就把歷史重新宣告成「未來的安排」，而且 mirrorDueDates 取
  // 該 Task 最早的 block，會把還沒完成的任務的 due_date 又鏡射回過去那天。
  //
  // 所以 carry-forward 只帶 date >= planningDay 的 block —— 跟 applySchedule 的
  // replan carry-forward（b.date>=effFrom）同一條不變式，不能因為「manual 的
  // candidate 是整份 snapshot」就自己放寬。
  // Stored rows may predate the canonical write gate. Read them with the same
  // conservative canonicalizer as Lock baseline: malformed/half-timed means
  // date-only, never a fabricated duration and never a poisoned manual flow.
  const futureBlocks = activeBlocks.filter(b => b.date >= planningDay).map(canonicalizeBlockTiming);
  const byId = new Map(futureBlocks.map(b => [Number(b.id), b]));
  const anyId = new Map(activeBlocks.map(b => [Number(b.id), b]));
  for (const m of normalized) {
    if (byId.has(m.block_id)) continue;
    // 指名要動一個已經過去的 block：這不是「找不到」，是「不能改歷史」。
    // 兩者要講清楚，否則使用者只會看到一句莫名其妙的「找不到」。
    if (anyId.has(m.block_id)) {
      throw new ScheduleInputError(`這一段的時間已經過去，不能再調整：${m.block_id}`);
    }
    throw new ScheduleInputError(`這個排程區塊不在目前生效的排程裡：${m.block_id}`);
  }

  // candidate＝整份「目前的未來」snapshot，只有被調整的那幾個換位置。
  // 其他 Plan 的未來 block 原封不動留在裡面，所以跨 Plan 碰撞是結構上就擋掉的，
  // 不需要另外一條規則去記得檢查。
  const moveById = new Map(normalized.map(m => [m.block_id, m]));
  const candidate = futureBlocks.map(block => {
    const m = moveById.get(Number(block.id));
    return normalizeBlockTiming(m
      ? { ...block, date: m.date, start_time: m.start_time, end_time: m.end_time }
      : block);
  });

  // 只檢查被動到的那幾個。其餘 future block 是既有安排，不該因為使用者
  // 調了別的東西就被重新審一次、害整份排程都送不出去。
  const conflicts = [];
  for (const block of candidate) {
    if (!moveById.has(Number(block.id))) continue;
    const verdict = classifyPlacement(block, {
      task: tasks.get(Number(block.task_id)), events, planningDay, nowHM, dayOfWeek,
      messages: MANUAL_MESSAGES,
    });
    if (!verdict) continue;
    const { kind, ...rest } = verdict;
    // 已完成／已刪除的任務在 Restore 是「略過」，但手動調整是使用者指名要動它，
    // 靜靜略過等於按了沒反應，所以這裡一律當成衝突回報。
    const message = kind === 'skip'
      ? (rest.type === 'completed' ? '這個任務已完成，不需要再安排' : '這個任務已刪除')
      : rest.message;
    conflicts.push({ block_id: block.id, task_id: block.task_id, ...rest, message });
  }

  // 跟排程裡任何其他 block 撞在一起（含其他 Plan、以及本次其他 move）
  const collided = findSelfCollisions(candidate);
  for (const index of collided) {
    const block = candidate[index];
    if (!moveById.has(Number(block.id))) continue;
    const other = candidate.find((x, i) => i !== index && timedOverlap(x, block));
    conflicts.push({
      block_id: block.id, task_id: block.task_id, type: 'schedule_collision',
      message: other ? `與「${tasks.get(Number(other.task_id))?.title || '另一個安排'}」時段重疊` : '時段重疊',
    });
  }
  return { candidate, conflicts };
}

export async function applyManualAdjustment(userId, { baseVersionId, moves = [], dryRun = false } = {}) {
  const planningDay = todayTW();
  const nowHM = twNowHM();
  const run = async db => {
    const state = await db.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
    const activeId = state?.active_version_id ?? null;
    // 手動調整以「使用者現在看到的那一版」為底。底變了就不能寫，
    // 也絕對不能重試——重試等於把他沒看過的排程默默改掉。
    if (activeId == null) throw new ScheduleInputError('目前沒有生效的排程，無法手動調整');
    if (Number(baseVersionId ?? -1) !== Number(activeId)) throw new ScheduleRestoreStaleError();

    const { candidate, conflicts } = await buildManualCandidate(
      db, userId, activeId, moves, { planningDay, nowHM });
    // Lock 的檢查對象是整份 candidate，不是單一 block（鎖住的那一天不能有任何
    // 變動，即使變動的是別人的 block）。
    //
    // 基準刻意用「完整的 active」，跟 applySchedule / applyRestore 的
    // assertCandidateLocks 一模一樣，不因為 manual 就自己換一套 Lock 語意。
    // 副作用是：一個只排在過去的鎖定任務，會讓所有新版本都判成
    // LOCKED_TASK_UNPLACED，必須先解鎖。這是 P4 既有的 standing-requirement
    // 語意（replan 對其他 Plan 的過期鎖定任務也是同樣結果），不是本支新增的。
    const lockConflicts = checkLocks(
      candidate,
      await db.all('SELECT task_id,date,start_time,end_time,planned_minutes FROM scheduled_blocks WHERE user_id=? AND schedule_version_id=?', [userId, activeId]),
      await db.all('SELECT * FROM schedule_locks WHERE user_id=? AND released_at IS NULL', [userId]),
      await db.all('SELECT id,deleted,completed,cancelled FROM tasks WHERE user_id=?', [userId]),
      { day: planningDay, time: nowHM });
    const all = [...conflicts, ...lockConflicts.map(c => ({ ...c, message: '這個位置已鎖定，請先解除鎖定' }))];
    if (dryRun) return { ok: all.length === 0, conflicts: all, base_version_id: activeId, blocks: candidate };
    if (all.length) throw new ScheduleManualConflictError(all);

    validateTimedBlockOverlaps(candidate);
    const version = await createScheduleVersionInTx(db, userId, {
      source: SOURCE.MANUAL,
      reason: `手動調整 ${moves.length} 項`,
      effectiveFrom: planningDay,
      parentVersionId: activeId,
      blocks: candidate,
      expectedActiveVersionId: activeId,
    });
    return { ok: true, conflicts: [], ...version };
  };
  // dry run 不寫任何東西，就不必佔用寫入佇列，也不需要 version_no 重試。
  if (dryRun) return run(q);
  return serializeWrite(() => withVersionNoRetry(() => q.tx(run)));
}

/* ============================================================
   建立版本（atomic）
   ============================================================ */

// 一個版本的建立包含四件事，必須全有或全無：
//   ① version metadata
//   ② 全部 ScheduledBlocks
//   ③ active_version_id 切換
//   ④ Plan Task 的 due_date / due_time 鏡射
//
// 絕不能留下「version 沒 blocks」「blocks 寫一半」「active 指到半套版本」
// 「mirror 跟 active 不一致」任何一種狀態（§7.1）。
//
// blocks 參數：[{ task_id, date, start_time, end_time, planned_minutes }]
// snapshot 欄位由這裡自己查，不讓呼叫端傳——那是顯示留影，不能被偽造。
export async function createScheduleVersion(userId, {
  source, reason = '', effectiveFrom = null,
  parentVersionId = null, restoredFromVersionId = null,
  blocks = [], setActive = true, onlyIfNoActive = false,
}) {
  const effFrom = effectiveFrom || todayTW();
  return serializeWrite(() => withVersionNoRetry(() => q.tx(tx =>
    createScheduleVersionInTx(tx, userId, {
      source, reason, effectiveFrom: effFrom, parentVersionId, restoredFromVersionId,
      blocks, setActive, onlyIfNoActive,
    })
  )));
}

// Plan lifecycle 不能只改 plans.status：那會讓已停止的 Plan 仍留在 active
// ScheduleVersion。此處把狀態變更、其他 Plan 的 future blocks carry-forward、
// Lock feasibility、active pointer 與 due mirror 放進同一個 transaction。
// cleanupAction：'pause' | 'delete'。有帶就必須同時帶明確的 retainIncompleteTasks
// （boolean），這一整組動作——lifecycle、未完成 Task、新 ScheduleVersion、失效
// lock——都在同一個 transaction 裡，任何一步失敗整筆 rollback。
export async function transitionPlanLifecycle(userId, planId, {
  nextStatus, endReason = null, baseVersionId = undefined,
  cleanupAction = null, retainIncompleteTasks = undefined,
}) {
  return serializeWrite(() => withVersionNoRetry(() => q.tx(async tx => {
    const plan = await tx.get('SELECT * FROM plans WHERE id=? AND user_id=?', [planId, userId]);
    if (!plan) throw new ScheduleInputError('找不到這個計畫');
    // tombstone 之後就沒有任何後續 lifecycle。本輪刻意不提供 restore contract。
    if (plan.status === 'deleted') throw new ScheduleInputError('這個計畫已經刪除');
    // lifecycle 不是可任意覆寫的欄位。明確限制轉換，避免把「重新開始」
    // 誤用成 paused -> completed 等沒有產品語意的捷徑。
    // 'archived' 已從產品移除：任何進行中狀態都不得再轉成 archived（見 archive
    // route 的說明）。archived 這一列保留，只為了讓既有的 archived 舊資料仍能安全
    // 轉出（例如刪除），不是新的入口。
    const allowed = {
      draft: new Set(['active', 'ended', 'deleted']),
      active: new Set(['paused', 'completed', 'ended', 'deleted']),
      paused: new Set(['active', 'ended', 'deleted']),
      completed: new Set(['active', 'deleted']),
      ended: new Set(['active', 'deleted']),
      archived: new Set([plan.archived_from_status || 'active', 'deleted']),
    };
    if (!allowed[plan.status]?.has(nextStatus)) {
      throw new ScheduleInputError('這個計畫目前不能進行此狀態轉換');
    }
    // 「暫停」「刪除」必須明確表態要不要保留未完成任務；沒有 cleanupAction 的
    // 轉換（完成／結束／封存／恢復）維持原本語意，一律不動任何 Task。
    const disposition = cleanupAction
      ? planTaskDisposition({ action: cleanupAction, retain: retainIncompleteTasks })
      : null;
    if (nextStatus === 'completed') {
      const unresolved = await tx.all(
        `SELECT id,title,due_date FROM tasks
          WHERE user_id=? AND plan_id=? AND completed=0
            AND COALESCE(cancelled,0)=0 AND COALESCE(deleted,0)=0
          ORDER BY due_date,id`, [userId, plan.id]);
      if (unresolved.length) throw new PlanCompletionIncompleteError(unresolved);
    }
    const state = await tx.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
    const activeId = state?.active_version_id ?? null;
    if (baseVersionId !== undefined && Number(baseVersionId ?? -1) !== Number(activeId ?? -1)) {
      throw new ScheduleRestoreStaleError();
    }

    const at = new Date().toISOString();
    const archivedFrom = nextStatus === 'archived'
      ? (plan.status === 'archived' ? plan.archived_from_status : plan.status)
      : null;
    const restoring = plan.status === 'archived' && nextStatus !== 'archived';
    const deleting = nextStatus === 'deleted';
    // 刪除是 tombstone：不清掉「這個計畫曾經完成／結束／封存」的時間戳，
    // 那是歷史。其餘轉換維持原本「離開某個狀態就清掉它的時間戳」的語意。
    await tx.run(
      `UPDATE plans SET status=?, completed_at=?, paused_at=?, ended_at=?, end_reason=?,
                        archived_at=?, archived_from_status=?, deleted_at=?,
                        lifecycle_retained_tasks=?, updated_at=?
        WHERE id=? AND user_id=?`,
      [nextStatus,
        deleting ? plan.completed_at : (nextStatus === 'completed' ? (plan.completed_at || at) : null),
        deleting ? plan.paused_at : (nextStatus === 'paused' ? (plan.paused_at || at) : null),
        deleting ? plan.ended_at : (nextStatus === 'ended' ? (plan.ended_at || at) : null),
        deleting ? plan.end_reason : (nextStatus === 'ended' ? (endReason || null) : null),
        deleting ? plan.archived_at : (nextStatus === 'archived' ? (plan.archived_at || at) : null),
        deleting ? plan.archived_from_status : (nextStatus === 'archived' ? archivedFrom : null),
        deleting ? (plan.deleted_at || at) : null,
        disposition ? (retainIncompleteTasks ? 1 : 0) : plan.lifecycle_retained_tasks ?? null,
        at, plan.id, userId]);

    // ── Task 的處理 ───────────────────────────────────────────────────────
    // 一律只做 soft-delete，絕不 hard delete：歷史版本的 block、StudySession、
    // material_progress 都還指著這些 task。scope 決定影響範圍：
    //   ・暫停：scope='incomplete' —— 只碰未完成、未取消、未刪除的 Task
    //   ・刪除：scope='all'        —— 碰所有尚未刪除的 Task（含已完成、已取消）
    // 不論哪一種，都不改 plan_id（歷史仍看得出它屬於哪個計畫），也不 detach。
    let affectedTaskIds = [];
    if (disposition) {
      // scope 過濾片段：incomplete 需額外排除已完成／已取消；all 只排除已刪除。
      const scopeSql = disposition.scope === 'all'
        ? ''
        : ' AND completed=0 AND COALESCE(cancelled,0)=0';
      const targets = await tx.all(
        `SELECT id FROM tasks
          WHERE user_id=? AND plan_id=? AND COALESCE(deleted,0)=0${scopeSql}`, [userId, plan.id]);
      affectedTaskIds = targets.map(t => Number(t.id));
      if (disposition.mode === 'soft_delete') {
        await tx.run(
          `UPDATE tasks SET deleted=1
            WHERE user_id=? AND plan_id=? AND COALESCE(deleted,0)=0${scopeSql}`, [userId, plan.id]);
      }
      // mode==='none'（暫停＋保留）：Task 全留，只是整個 Plan 退出排程。
      //
      // 失效的 Task lock：主詞已經離開排程（被軟刪、或整個 Plan 退出），鎖著它
      // 沒有意義。soft release 並留下理由，讓使用者在鎖定列表看得到為什麼不見了。
      // day / time lock 不在此列——見 plan-cleanup.js。
      if (affectedTaskIds.length) {
        const reason = lockReleaseReason(cleanupAction);
        for (const taskId of affectedTaskIds) {
          await tx.run(
            `UPDATE schedule_locks SET released_at=?, release_reason=?
              WHERE user_id=? AND type='task' AND task_id=? AND released_at IS NULL`,
            [at, reason, userId, taskId]);
        }
      }
    }

    if (activeId == null) {
      return { plan: await tx.get('SELECT * FROM plans WHERE id=?', [plan.id]), version: null };
    }
    const effectiveFrom = todayTW();
    const candidate = (await tx.all(
      `SELECT b.task_id,b.date,b.start_time,b.end_time,b.planned_minutes
         FROM scheduled_blocks b
         JOIN tasks t ON t.id=b.task_id AND t.user_id=b.user_id
         JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
        WHERE b.user_id=? AND b.schedule_version_id=? AND b.date>=?
          AND t.plan_id<>? AND COALESCE(t.deleted,0)=0
          AND t.completed=0 AND COALESCE(t.cancelled,0)=0
          -- 白名單，不是黑名單。原本寫成 NOT IN ('paused',…) 時，任何**新增**的
          -- lifecycle 狀態（例如 'deleted'）都會被預設當成「仍在排程」而漏進來。
          AND p.status IN ('draft','active')
        ORDER BY b.date,COALESCE(b.start_time,''),b.id`,
      [userId, activeId, effectiveFrom, planId])).map(canonicalizeBlockTiming);
    validateTimedBlockOverlaps(candidate);
    await assertCandidateLocks(tx, userId, activeId, candidate);
    const version = await createScheduleVersionInTx(tx, userId, {
      source: SOURCE.LIFECYCLE,
      reason: `計畫「${plan.name}」${nextStatus === 'paused' ? '暫停' : nextStatus === 'deleted' ? '刪除' : nextStatus === 'ended' ? '結束' : nextStatus === 'completed' ? '完成' : nextStatus === 'archived' ? '封存' : restoring ? '恢復' : '重新開始'}`,
      effectiveFrom,
      parentVersionId: activeId,
      blocks: candidate,
      expectedActiveVersionId: activeId,
    });
    return { plan: await tx.get('SELECT * FROM plans WHERE id=?', [plan.id]), version };
  })));
}

// 取消不是刪除，也不是完成。取消 Plan Task 時，舊版本仍保留歷史安排，
// 但新的 active version 必須不再把它當成未來排程；重新開啟則只回到 unplaced，
// 不會偷偷復活舊 block。
export async function transitionTaskOutcome(userId, taskId, outcome) {
  return serializeWrite(() => withVersionNoRetry(() => q.tx(async tx => {
    const task = await tx.get('SELECT * FROM tasks WHERE id=? AND user_id=?', [taskId, userId]);
    if (!task || task.deleted) throw new ScheduleInputError('找不到可變更的任務');
    if (!['completed', 'cancelled', null].includes(outcome)) throw new ScheduleInputError('任務結果不正確');
    if (outcome === 'cancelled' && task.completed) throw new ScheduleInputError('已完成任務不能取消；請先重新開啟');
    const at = new Date().toISOString();
    await tx.run(
      `UPDATE tasks SET completed=?,completed_at=?,cancelled=?,cancelled_at=?,due_date=?,due_time=? WHERE id=? AND user_id=?`,
      [outcome === 'completed' ? 1 : 0, outcome === 'completed' ? at : null,
        outcome === 'cancelled' ? 1 : 0, outcome === 'cancelled' ? at : null,
        outcome === 'cancelled' && task.plan_id != null ? null : task.due_date,
        outcome === 'cancelled' && task.plan_id != null ? null : task.due_time, task.id, userId]);

    const state = await tx.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
    const activeId = state?.active_version_id ?? null;
    // 一般待辦不在 ScheduleVersion domain；Plan Task 的 reopen 不復活舊安排。
    if (outcome == null || task.plan_id == null || activeId == null) {
      return { task: await tx.get('SELECT * FROM tasks WHERE id=?', [task.id]), version: null };
    }
    const effectiveFrom = todayTW();
    const candidate = (await tx.all(
      `SELECT b.task_id,b.date,b.start_time,b.end_time,b.planned_minutes
         FROM scheduled_blocks b
         JOIN tasks t ON t.id=b.task_id AND t.user_id=b.user_id
         JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
        WHERE b.user_id=? AND b.schedule_version_id=? AND b.date>=?
          AND t.id<>? AND COALESCE(t.deleted,0)=0 AND t.completed=0
          AND COALESCE(t.cancelled,0)=0 AND p.status IN ('draft','active')
        ORDER BY b.date,COALESCE(b.start_time,''),b.id`,
      [userId, activeId, effectiveFrom, task.id])).map(canonicalizeBlockTiming);
    validateTimedBlockOverlaps(candidate);
    await assertCandidateLocks(tx, userId, activeId, candidate);
    const version = await createScheduleVersionInTx(tx, userId, {
      source: SOURCE.LIFECYCLE,
      reason: `任務「${task.title}」已${outcome === 'completed' ? '完成' : '取消'}`, effectiveFrom, parentVersionId: activeId,
      blocks: candidate, expectedActiveVersionId: activeId,
    });
    return { task: await tx.get('SELECT * FROM tasks WHERE id=?', [task.id]), version };
  })));
}

// 給 P2 的「任務身分異動＋新版排程」共用。呼叫端已經握有同一筆 transaction
// 時，不能再開巢狀交易；版本本體仍然只由這個檔案寫入。
async function createScheduleVersionInTx(tx, userId, {
  source, reason = '', effectiveFrom = null,
  parentVersionId = null, restoredFromVersionId = null,
  blocks = [], setActive = true, onlyIfNoActive = false, expectedActiveVersionId = undefined,
}) {
    const effFrom = effectiveFrom || todayTW();
    // 所有版本來源都先正規化 timing；不允許任何 reachable ScheduledBlock
    // 出現「timed 卻沒有分鐘數」或「date-only 卻殘留分鐘數」。
    const normalizedBlocks = blocks.map(normalizeBlockTiming);
    // bootstrap 的正確性不能依賴 transaction 外的預讀或同程序 writeQueue。
    // 多個 instance 同時進來時，只有看見 active_version_id 仍為 NULL 的那一筆
    // transaction 可以建立 V1；其他 caller 必須拿同一個既有 active version 回去。
    if (onlyIfNoActive) {
      const state = await tx.get(
        'SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
      if (state?.active_version_id != null) {
        return { created: false, existing_version_id: state.active_version_id };
      }
    }
    // ① 版本號：同一使用者底下遞增。併發時靠 UNIQUE(user_id, version_no) 擋，
    //    由 withVersionNoRetry 重試（只有這一種衝突可以重試）
    const row = await tx.get(
      'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM schedule_versions WHERE user_id=?', [userId]);
    const versionNo = Number(row.n);

    const v = await tx.run(
      `INSERT INTO schedule_versions
         (user_id, version_no, parent_version_id, restored_from_version_id,
          reason, source, effective_from, block_count)
       VALUES (?,?,?,?,?,?,?,?)`,
      [userId, versionNo, parentVersionId, restoredFromVersionId,
        reason, source, effFrom, normalizedBlocks.length]);
    const versionId = v.lastInsertRowid;

    // ② blocks。每一個都必須是這位使用者 draft／active 計畫底下有效、未完成的
    // Task；不得寫入 orphan、別人的任務、一般待辦、inactive Plan、已刪除或已完成
    // 任務。任何一筆不合法都使整個 transaction rollback，不能 silently skip 或留下
    // partial version。
    for (const b of normalizedBlocks) {
      const t = await tx.get(
        `SELECT t.id,t.title,t.plan_id,t.deleted,t.completed,t.cancelled,l.name AS subject,p.status AS plan_status
           FROM tasks t
           LEFT JOIN lists l ON l.id=t.list_id AND l.user_id=t.user_id
           LEFT JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
          WHERE t.id=? AND t.user_id=?`, [b.task_id, userId]);
      if (!t) throw new ScheduleInputError(`排程任務不存在或不屬於目前使用者：${b.task_id}`);
      if (t.plan_id == null) throw new ScheduleInputError(`排程任務必須屬於計畫：${b.task_id}`);
      if (!['draft', 'active'].includes(t.plan_status)) throw new ScheduleInputError(`排程任務所屬計畫目前未參與排程：${b.task_id}`);
      if (t.deleted) throw new ScheduleInputError(`排程任務已刪除：${b.task_id}`);
      if (t.completed) throw new ScheduleInputError(`排程任務已完成：${b.task_id}`);
      if (t.cancelled) throw new ScheduleInputError(`排程任務已取消：${b.task_id}`);
      await tx.run(
        `INSERT INTO scheduled_blocks
           (user_id, schedule_version_id, task_id, date, start_time, end_time,
            planned_minutes, task_title_snapshot, subject_name_snapshot)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [userId, versionId, b.task_id, b.date, b.start_time ?? null, b.end_time ?? null,
          b.planned_minutes ?? null, t?.title ?? null, t?.subject ?? null]);
    }

    // ③ active 切換
    if (setActive) {
      if (expectedActiveVersionId !== undefined) {
        // Restore 的 optimistic lock：transaction 開頭檢查只是早期失敗訊息；真正
        // 切 active 時還要以條件式 UPDATE 保證 base 沒變。stale 不能 retry。
        const swapped = await tx.run(
          `UPDATE user_schedule_state SET active_version_id=?, updated_at=CURRENT_TIMESTAMP
            WHERE user_id=? AND active_version_id IS ?`,
          [versionId, userId, expectedActiveVersionId]);
        if (swapped.changes !== 1) throw new ScheduleRestoreStaleError();
      } else {
        await tx.run(
          `INSERT INTO user_schedule_state (user_id, active_version_id, updated_at)
           VALUES (?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(user_id) DO UPDATE SET active_version_id=excluded.active_version_id,
                                              updated_at=CURRENT_TIMESTAMP`,
          [userId, versionId]);
      }
      // ④ 鏡射
      await mirrorDueDates(tx, userId, versionId);
    }

    return { version_id: versionId, version_no: versionNo, block_count: normalizedBlocks.length };
}

// 其他 Plan 的 carry-forward：ScheduleVersion 是 user-level 全域 snapshot，本次只替
// current Plan 換 block，其他 draft/active Plan 仍有效的 future placement（date>=effFrom）
// 必須原封不動帶進新版本。preview 與 apply **共用同一支 builder**（§Phase1-2），避免
// preview 把其他 Plan 的 block 誤判成 removed、也避免 preview 的 candidate 與 apply
// 實際建立的版本不一致。runner 可以是 tx 或 q（都提供 .all）。
export async function otherPlanCarryForwardBlocks(runner, userId, activeVersionId, planId, effFrom) {
  if (activeVersionId == null) return [];
  const rows = await runner.all(
    `SELECT b.task_id, b.date, b.start_time, b.end_time, b.planned_minutes
       FROM scheduled_blocks b
       JOIN tasks t ON t.id=b.task_id AND t.user_id=b.user_id
      WHERE b.schedule_version_id=? AND b.user_id=?
        AND t.plan_id IS NOT NULL AND t.plan_id<>?
        AND COALESCE(t.deleted,0)=0 AND t.completed=0 AND COALESCE(t.cancelled,0)=0
        AND b.date>=?
      ORDER BY b.date, COALESCE(b.start_time,''), b.id`,
    [activeVersionId, userId, planId, effFrom]);
  return rows.map(canonicalizeBlockTiming);
}

// Wizard 初次建立與 AI Replan 的正式套用入口。任務的身分／內容變動與
// ScheduleVersion、active pointer、due mirror 必須同生共死；尤其不能先把
// Task 改到新日期、卻在建立版本失敗時留下半套資料。
//
// task_creates 的 client_key 只在本次 request 內用來把 preview block 對到新任務，
// 不落庫。既有任務一律以 task_id 指向，所有操作都強制限在同一 plan_id。
export async function applySchedule(userId, {
  planId, source, reason = '', effectiveFrom = null,
  taskUpdates = [], taskCreates = [], taskDeleteIds = [], blocks = [],
  // ---- Rolling（段考滾動排程）的可選 defence-in-depth。全部預設關閉，
  //      既有 caller（Wizard／Replan）完全不受影響。 ----
  expectedBaseVersionId = undefined,   // §12 stale preview 防護：!== undefined 才檢查
  attachTaskIds = [],                   // §9 pending attachment：把 plan_id=NULL 的 Task 原子掛進本計畫
  freezeBlocks = null,                  // §3 freeze：這些既有 placement 必須原封不動出現在 candidate
  enforceDeadlines = false,             // §11 apply 期硬截止再驗一次
  // §Phase2 rolling strict mode：只有段考滾動 apply 開啟。開啟後：
  //   ・task_creates 只接受「有合法 material_content_item_id」的新任務，拒絕任意 task create
  //   ・一律以 CURRENT material 欄位建立（title/list_id/estimated_minutes/book_id），不信 client
  //   ・CURRENT estimated_minutes 缺或 <=0 → fail closed 整筆 rollback（不回退 client/block）
  //   ・有新增內容（attach 或 create）時，Plan 必須是 active
  //   ・拒絕重複 Material selection；驗證每個 attach/create 都實際出現在 candidate blocks
  //   既有 Wizard/Replan（rollingStrict=false）行為完全不變。
  rollingStrict = false,
  examSubject = null,
}) {
  if (!Number.isInteger(Number(planId))) throw new ScheduleInputError('缺少有效的計畫 id');
  if (![SOURCE.INITIAL, SOURCE.AI_REPLAN, SOURCE.MANUAL].includes(source)) {
    throw new ScheduleInputError('排程來源不正確');
  }
  return serializeWrite(() => withVersionNoRetry(() => q.tx(async tx => {
    const plan = await tx.get('SELECT id,status FROM plans WHERE id=? AND user_id=?', [planId, userId]);
    if (!plan) throw new ScheduleInputError('找不到這個計畫');
    if (!['draft', 'active'].includes(plan.status)) throw new ScheduleInputError('目前未執行的計畫不能重新排程');
    // §Phase2 blocker5：只要 request 含任何新增內容（attach / material create），CURRENT Plan
    // 必須是 active。draft/paused/completed/ended/deleted 一律拒絕新增；不含新增的 rolling 不受影響。
    if (rollingStrict && (attachTaskIds.length || taskCreates.length || examSubject) && plan.status !== 'active') {
      throw new ScheduleInputError('只有進行中的計畫可以加入內容', 'PLAN_NOT_ACTIVE_FOR_ATTACH');
    }

    // §12 STALE_SCHEDULE_PREVIEW：preview 帶的 base_version_id 必須等於此刻的 active，
    // 否則 preview 已過時，禁止 silent rebase。undefined = 非 rolling caller，不檢查。
    if (expectedBaseVersionId !== undefined) {
      const st = await tx.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
      if (Number(st?.active_version_id ?? -1) !== Number(expectedBaseVersionId ?? -1)) {
        throw new ScheduleStalePreviewError(st?.active_version_id ?? null);
      }
    }

    if (examSubject) {
      const snap = verifyExamSubjectToken(examSubject.token);
      const sid = Number(examSubject.subject_list_id);
      const date = String(examSubject.exam_date || '');
      if (!snap || Number(snap.user_id) !== Number(userId) || Number(snap.plan_id) !== Number(planId)
        || Number(snap.base_version_id ?? -1) !== Number(expectedBaseVersionId ?? -1)
        || Number(snap.subject_list_id) !== sid || snap.exam_date !== date
        || (snap.operation || 'add') !== (examSubject.operation || 'add')
        || (snap.previous_exam_date ?? null) !== (examSubject.previous_exam_date ?? null)) {
        throw new ScheduleInputError('新增科目的預覽已失效，請重新預覽', 'EXAM_SUBJECT_STALE');
      }
      const owned = await tx.get('SELECT id FROM lists WHERE id=? AND user_id=?', [sid, userId]);
      if (!owned) throw new ScheduleInputError('找不到科目', 'EXAM_SUBJECT_NOT_FOUND');
      const currentPlan = await tx.get('SELECT start_date,target_date FROM plans WHERE id=? AND user_id=?', [planId, userId]);
      if (!isValidDay(date) || (currentPlan.start_date && date < currentPlan.start_date) || (currentPlan.target_date && date > currentPlan.target_date)) {
        throw new ScheduleInputError('科目考試日不能晚於這次段考的結束日', 'INVALID_EXAM_DATE');
      }
      const current = await tx.get('SELECT id,exam_date FROM plan_exam_subjects WHERE user_id=? AND plan_id=? AND subject_list_id=?', [userId, planId, sid]);
      if ((examSubject.operation || 'add') === 'update') {
        if (!current || (current.exam_date ?? null) !== (examSubject.previous_exam_date ?? null)) throw new ScheduleInputError('科目考試日已變更，請重新預覽', 'EXAM_SUBJECT_STALE');
        await tx.run('UPDATE plan_exam_subjects SET exam_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?', [date, current.id, userId]);
        await tx.run(`UPDATE tasks SET deadline_date=?,updated_at=CURRENT_TIMESTAMP
          WHERE user_id=? AND plan_id=? AND list_id=? AND COALESCE(deleted,0)=0 AND completed=0 AND COALESCE(cancelled,0)=0
            AND (material_content_item_id IS NOT NULL OR EXISTS
              (SELECT 1 FROM plan_manual_scope s WHERE s.user_id=tasks.user_id AND s.plan_id=tasks.plan_id AND s.task_id=tasks.id AND s.removed_at IS NULL))`,
        [date, userId, planId, sid]);
      } else {
        if (current) throw new ScheduleInputError('這個科目已在段考計畫中', 'EXAM_SUBJECT_EXISTS');
        const order = await tx.get('SELECT COALESCE(MAX(order_index),-1)+1 n FROM plan_exam_subjects WHERE user_id=? AND plan_id=?', [userId, planId]);
        await tx.run('INSERT INTO plan_exam_subjects (user_id,plan_id,subject_list_id,exam_date,order_index) VALUES (?,?,?,?,?)', [userId, planId, sid, date, order.n]);
      }
    }

    // §9 pending attachment：把 plan_id=NULL 的既有 Task 原子掛進本計畫（在同一筆
    // transaction 內，任何後續步驟失敗都會一起 rollback，不留半掛 Task）。
    for (const rawId of attachTaskIds) {
      const tid = Number(rawId);
      const t = await tx.get('SELECT id,plan_id,deleted,completed,cancelled FROM tasks WHERE id=? AND user_id=?', [tid, userId]);
      if (!t) throw new ScheduleInputError(`找不到要掛入的任務：${rawId}`);
      if (t.deleted || t.completed || t.cancelled) throw new ScheduleInputError(`已結束的任務不能掛入計畫：${rawId}`);
      if (t.plan_id != null && Number(t.plan_id) !== Number(planId)) throw new ScheduleInputError(`任務已屬於其他計畫：${rawId}`);
      if (t.plan_id == null) await tx.run('UPDATE tasks SET plan_id=? WHERE id=? AND user_id=?', [planId, tid, userId]);
    }

    const assertLivePlanTask = async taskId => {
      const task = await tx.get(
        `SELECT id, plan_id, deleted, completed, cancelled FROM tasks WHERE id=? AND user_id=?`,
        [taskId, userId]);
      if (!task || Number(task.plan_id) !== Number(planId) || task.deleted || task.completed || task.cancelled) {
        throw new ScheduleInputError(`任務不屬於這個可排程的計畫：${taskId}`);
      }
      return task;
    };

    for (const u of taskUpdates) {
      await assertLivePlanTask(u.task_id);
      const fields = [];
      const args = [];
      for (const key of ['notes', 'deadline_date']) {
        if (key in u) { fields.push(`${key}=?`); args.push(u[key] || null); }
      }
      if (fields.length) {
        args.push(u.task_id, userId);
        await tx.run(`UPDATE tasks SET ${fields.join(',')} WHERE id=? AND user_id=?`, args);
      }
    }

    const created = new Map();
    const createdMaterialItemId = new Map();   // client_key → material_content_item_id（candidate 驗證用）
    const createdMaterialEstimate = new Map(); // client_key → CURRENT estimated_minutes（block 分鐘一致性驗證用）
    const seenContentItem = new Set();         // 同 request 內不得重複選同一 content item
    for (const c of taskCreates) {
      // §Phase2 blocker3：client_key trim 後非空、同 request 唯一；不以 Map overwrite 掩蓋 collision。
      const key = String(c.client_key ?? '').trim();
      if (!key) throw new ScheduleInputError('新任務缺少有效的 client_key', 'INVALID_CLIENT_KEY');
      if (created.has(key)) throw new ScheduleInputError(`client_key 重複：${key}`, 'DUPLICATE_CLIENT_KEY');

      // Task ↔ Material 只是「這個 Task 在做哪一份教材」的指向，不改變任何排程語意。
      let materialItem = null;
      if (c.material_content_item_id != null) {
        // §Phase2 blocker2 DiD：以 CURRENT material item 重讀所有欄位（存在、所有權、CURRENT title、
        // CURRENT estimated_minutes、book 與 CURRENT subject_list_id、CURRENT completion）。
        materialItem = await tx.get(
          `SELECT i.id, i.book_id, i.kind, i.title, i.estimated_minutes, b.subject_list_id,
                  COALESCE(p.completed,0) AS completed
             FROM material_content_items i
             LEFT JOIN material_books b ON b.id=i.book_id AND b.user_id=i.user_id
             LEFT JOIN material_progress p ON p.content_item_id=i.id AND p.user_id=i.user_id
            WHERE i.id=? AND i.user_id=?`, [c.material_content_item_id, userId]);
        if (!materialItem) throw new ScheduleInputError(`找不到教材項目：${c.material_content_item_id}`);
        if (Number(materialItem.completed) === 1) {
          throw new ScheduleInputError(`這份教材已完成，不需要再排程：${c.material_content_item_id}`);
        }
      } else if (rollingStrict) {
        // §Phase2 blocker1：rolling apply 只接受 Material selection 產生的新任務。
        throw new ScheduleInputError('段考滾動加入只接受 Material selection 產生的新任務', 'ROLLING_STRICT_TASK_CREATE');
      }

      // 決定寫入欄位。strict material：一律 CURRENT material 值，忽略 client 傳來的
      // title / list_id / estimated_minutes / material_book_id / deadline。
      let title, listId, estimated, bookId, deadlineDate, notes, priority, tags, subtasks, recurring, missPolicy;
      if (rollingStrict && materialItem) {
        title = String(materialItem.title || '').trim();
        listId = materialItem.subject_list_id ?? null;
        estimated = Number(materialItem.estimated_minutes) > 0 ? Number(materialItem.estimated_minutes) : null;
        bookId = materialItem.book_id ?? null;
        deadlineDate = null; notes = ''; priority = 0; tags = []; subtasks = []; recurring = null; missPolicy = 'keep';
        if (!title) throw new ScheduleInputError(`教材項目缺少名稱：${materialItem.id}`, 'MATERIAL_TITLE_MISSING');
        // §Phase2 blocker2：CURRENT estimated_minutes 缺或 <=0 → fail closed（不回退 client/block）。
        if (estimated == null) throw new ScheduleInputError(`教材項目缺少估計時間，無法排程：${materialItem.id}`, 'MATERIAL_ESTIMATE_MISSING');
        // §Phase2 blocker4：同 request 內同一 content item 只能出現一次。
        if (seenContentItem.has(Number(materialItem.id))) throw new ScheduleInputError(`同一份教材不可重複加入：${materialItem.id}`, 'DUPLICATE_MATERIAL_SELECTION');
        seenContentItem.add(Number(materialItem.id));
        // §Phase2 blocker4：CURRENT plan_material_items 已 selected=1 且 linked Task 仍存在，
        // 或該 Plan 已有未刪除的同 content item Material Task → already_selected，整筆拒絕。
        const dupSel = await tx.get(
          `SELECT 1 FROM plan_material_items pmi
            WHERE pmi.user_id=? AND pmi.plan_id=? AND pmi.content_item_id=? AND pmi.selected=1
              AND pmi.task_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=pmi.task_id AND t.user_id=? AND COALESCE(t.deleted,0)=0)`,
          [userId, planId, materialItem.id, userId]);
        const dupTask = await tx.get(
          `SELECT 1 FROM tasks WHERE user_id=? AND plan_id=? AND material_content_item_id=? AND COALESCE(deleted,0)=0`,
          [userId, planId, materialItem.id]);
        if (dupSel || dupTask) throw new ScheduleInputError(`這份教材已加入本計畫：${materialItem.id}`, 'ALREADY_SELECTED');
        // §Phase2 audit r3：驗證伺服器簽章的 material_snapshot_token，不採信 client 傳回的普通 JSON。
        // 步驟：①驗簽 ②綁定此次 user/plan/base_version/client_key/content item ③從 token 取出 preview
        // 當下的 CURRENT 值，與此刻 CURRENT material 比較。任一不符 → MATERIAL_STALE 整筆 rollback；
        // token 缺失／格式錯誤／簽章錯誤 → 明確錯誤並整筆 rollback。strict 一律 fail closed，無 unsigned fallback。
        const verified = verifyMaterialSnapshotToken(c.material_snapshot_token);
        if (!verified.ok) {
          const code = verified.reason === 'missing' ? 'MATERIAL_TOKEN_MISSING' : 'MATERIAL_TOKEN_INVALID';
          throw new ScheduleInputError(`教材簽章缺失或不正確：${materialItem.id}`, code);
        }
        const snap = verified.payload;
        // ② binding：token 必須綁在此次請求的 user／plan／base version／client_key／content item 上。
        const bound = Number(snap.user_id) === Number(userId)
          && Number(snap.plan_id) === Number(planId)
          && String(snap.client_key) === String(key)
          && Number(snap.content_item_id) === Number(materialItem.id)
          && Number(snap.base_version_id ?? -1) === Number(expectedBaseVersionId ?? -1);
        if (!bound) throw new ScheduleInputError(`教材簽章與此次請求不符，請重新預覽：${materialItem.id}`, 'MATERIAL_STALE');
        // ③ CURRENT 比較：token 內 preview 當下的值 vs 此刻 CURRENT material。
        const same = (snap.title ?? null) === (materialItem.title ?? null)
          && (snap.estimated_minutes ?? null) === (materialItem.estimated_minutes ?? null)
          && Number(snap.material_book_id ?? -1) === Number(materialItem.book_id ?? -1)
          && Number(snap.subject_list_id ?? -1) === Number(materialItem.subject_list_id ?? -1)
          && snap.kind === materialItem.kind;
        if (!same) throw new ScheduleInputError(`教材資料在你預覽之後已變更，請重新預覽：${materialItem.id}`, 'MATERIAL_STALE');
      } else {
        // 既有 Wizard / 非 strict：沿用原行為（信 client；material item 估時優先，否則回退 client/block）。
        if (!String(c.title || '').trim()) throw new ScheduleInputError('新任務資料不正確');
        title = String(c.title).trim();
        listId = c.list_id || null;
        estimated = (materialItem && Number(materialItem.estimated_minutes) > 0)
          ? Number(materialItem.estimated_minutes)
          : (c.estimated_minutes ?? (blocks.filter(b => b.client_key === key)
              .reduce((total, b) => total + (Number(b.planned_minutes) || 0), 0) || null));
        bookId = materialItem?.book_id ?? null;
        deadlineDate = c.deadline_date || null; notes = c.notes || ''; priority = c.priority || 0;
        tags = c.tags || []; subtasks = c.subtasks || []; recurring = c.recurring || null; missPolicy = c.miss_policy || 'keep';
      }
      const r = await tx.run(
        `INSERT INTO tasks (user_id,list_id,title,notes,priority,tags,subtasks,recurring,miss_policy,plan_id,deadline_date,estimated_minutes,material_content_item_id,material_book_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [userId, listId, title, notes, priority,
          JSON.stringify(tags), JSON.stringify(subtasks), recurring,
          missPolicy, planId, deadlineDate,
          estimated, materialItem?.id ?? null, bookId]);
      created.set(key, r.lastInsertRowid);
      createdMaterialItemId.set(key, materialItem?.id ?? null);
      if (rollingStrict && materialItem) createdMaterialEstimate.set(key, Number(estimated));
      // §Phase2：原子寫入 Material selection（plan_material_items），preview 不預寫。
      // 一計畫一 content_item 一列：既有列（含先前取消選取的）改回 selected=1 並指向新 Task；
      // 沒有才 INSERT。這是「選取」，與 material_progress（完成度）完全分離。
      if (materialItem) {
        const upd = await tx.run(
          `UPDATE plan_material_items SET selected=1,task_id=?,removed_at=NULL,updated_at=CURRENT_TIMESTAMP
            WHERE user_id=? AND plan_id=? AND content_item_id=?`,
          [r.lastInsertRowid, userId, planId, materialItem.id]);
        if (!upd.changes) {
          await tx.run(
            `INSERT INTO plan_material_items (user_id,plan_id,content_item_id,selected,task_id)
             VALUES (?,?,?,1,?)`,
            [userId, planId, materialItem.id, r.lastInsertRowid]);
        }
      }
    }

    for (const taskId of taskDeleteIds) {
      await assertLivePlanTask(taskId);
      await tx.run('UPDATE tasks SET deleted=1 WHERE id=? AND user_id=?', [taskId, userId]);
    }

    // §Phase2 audit blocker2：strict rolling 模式下每個 block 必須「恰好一種 identity」。
    //   ・existing Task：有合法 task_id、且不得同時帶 client_key
    //   ・新建 Material Task：帶已宣告的 client_key、task_id 為 null／缺省
    //   ・同時有 task_id 與 client_key → 拒絕（不得用 ?? 讓 task_id 掩蓋未知 key）
    //   ・未知 client_key／空白 client_key／兩者都沒有 → 拒絕
    const resolveStrict = b => {
      const hasTid = b.task_id != null;
      const hasKeyField = b.client_key != null;
      const rawKey = hasKeyField ? String(b.client_key).trim() : '';
      if (hasTid && hasKeyField) throw new ScheduleInputError('排程區塊不得同時帶 task_id 與 client_key', 'BLOCK_AMBIGUOUS_IDENTITY');
      if (hasTid) return { ...b, task_id: Number(b.task_id) };
      if (!hasKeyField) throw new ScheduleInputError('排程區塊缺少 identity（task_id 或 client_key）', 'BLOCK_MISSING_IDENTITY');
      if (!rawKey) throw new ScheduleInputError('排程區塊的 client_key 不得為空白', 'BLOCK_BLANK_CLIENT_KEY');
      const id = created.get(rawKey);
      if (id == null) throw new ScheduleInputError('排程區塊引用未知 client_key', 'BLOCK_UNKNOWN_IDENTITY');
      return { ...b, task_id: id, client_key: rawKey };
    };
    const resolveLenient = b => {
      // 既有 Wizard/Replan：維持原行為（task_id 優先，其次 client_key）。
      const key = b.client_key != null ? String(b.client_key).trim() : null;
      const taskId = b.task_id ?? (key ? created.get(key) : undefined);
      if (taskId == null) throw new ScheduleInputError('排程區塊找不到對應任務（未知或缺少 client_key）', 'BLOCK_UNKNOWN_IDENTITY');
      return { ...b, task_id: taskId };
    };
    const resolvedBlocks = blocks.map(b => (rollingStrict ? resolveStrict(b) : resolveLenient(b)));

    // §Phase2 blocker6：新增內容必須實際出現在正式 candidate。strict 模式下：
    //   ・每個 attach_task_id 至少有一個 candidate block
    //   ・每個 task_create（client_key）至少有一個 candidate block（不接受宣告卻沒排入）
    // 不能只把 Task 掛進 Plan 卻不排入本次版本；排不下要停在 preview 的 GAP/INFEASIBLE。
    if (rollingStrict) {
      const blockTaskIds = new Set(resolvedBlocks.map(b => Number(b.task_id)));
      for (const rawId of attachTaskIds) {
        if (!blockTaskIds.has(Number(rawId))) throw new ScheduleInputError(`加入的任務未排入本次版本：${rawId}`, 'ATTACH_NOT_IN_CANDIDATE');
      }
      for (const [key, id] of created) {
        if (!blockTaskIds.has(Number(id))) throw new ScheduleInputError(`新增內容未排入本次版本：${key}`, 'CREATE_NOT_IN_CANDIDATE');
      }
      // §Phase2 audit blocker3（forge-proof）：每個 Material Task 的候選 block 分鐘總和必須等於
      // CURRENT estimated_minutes。preview 是照當下估時排滿的；若估時在 apply 前改變（即使 client
      // 偽造 snapshot 使其與 CURRENT 一致），舊 blocks 的分鐘總和就對不上 CURRENT → MATERIAL_STALE。
      // 這一步不信任 client snapshot，直接拿 DB 的 CURRENT 估時對帳。
      // preview 的 candidate block 分鐘可能只以 start/end 表示（planned_minutes 為 null），
      // 因此優先取明確的 planned_minutes，否則由 end_time-start_time 推導。
      const minutesOf = b => {
        const pm = Number(b.planned_minutes);
        if (Number.isFinite(pm) && pm > 0) return pm;
        if (b.start_time && b.end_time) {
          const t = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
          return Math.max(0, t(b.end_time) - t(b.start_time));
        }
        return 0;
      };
      for (const [key, id] of created) {
        if (!createdMaterialEstimate.has(key)) continue;   // 只驗 Material Task
        const scheduled = resolvedBlocks
          .filter(b => Number(b.task_id) === Number(id))
          .reduce((total, b) => total + minutesOf(b), 0);
        if (scheduled !== Number(createdMaterialEstimate.get(key))) {
          throw new ScheduleInputError(`教材排定分鐘與 CURRENT 估時不一致，請重新預覽：${key}`, 'MATERIAL_STALE');
        }
      }
    }
    const active = await tx.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
    const effFrom = effectiveFrom || todayTW();
    // ScheduleVersion 是 user-level 全域 snapshot，不是單一 Plan 的 snapshot。
    // 本次只替 current Plan 換 block；其他 Plan 仍有效的 future placement 必須從
    // active version 原封不動帶進 candidate，不然 mirror 會把它們誤判成 unplaced。
    // preview 走同一支 builder（§Phase1-2），確保 preview candidate === apply 版本。
    const carryForwardBlocks = await otherPlanCarryForwardBlocks(tx, userId, active?.active_version_id ?? null, planId, effFrom);
    const candidateBlocks = [...carryForwardBlocks, ...resolvedBlocks];
    // 即使 caller 繞過 preview，也不得把有重疊的全域 snapshot 寫進資料庫。
    // 這一步仍在 transaction 內，失敗時前面的 Task 異動會一併 rollback。
    validateTimedBlockOverlaps(candidateBlocks);
    await assertCandidateLocks(tx, userId, active?.active_version_id ?? null, candidateBlocks);

    // §3 freeze defence-in-depth：每一個被凍結的既有 placement，必須逐欄相同地
    // 出現在 candidate 裡。少了、被搬了、被換日了，都代表 optimizer（或前端）
    // 動到不該動的今天／明天安排——整筆拒絕。
    if (Array.isArray(freezeBlocks) && freezeBlocks.length) {
      const violations = [];
      for (const fb of freezeBlocks) {
        if (!candidateBlocks.some(cb => samePlacement(cb, fb))) {
          violations.push({ task_id: Number(fb.task_id), date: fb.date, start_time: fb.start_time || null, end_time: fb.end_time || null });
        }
      }
      if (violations.length) throw new ScheduleFreezeViolationError(violations);
    }

    // §11 / §Phase1-Fix effective upper bound defence-in-depth：用「此刻的 Task 與此刻所屬
    // Plan 的 target_date」再驗每一個 candidate block（含其他 Plan 的 carry-forward），不信前端
    // 傳的 item.end 或已算好的上限。有效上限＝Task deadline 與 Plan target_date 取較早者；
    // School Assignment 同日 deadline_time 仍獨立檢查。任何越界 block 一律整筆拒絕、不建版本。
    if (enforceDeadlines) {
      const ids = [...new Set(candidateBlocks.map(b => Number(b.task_id)))];
      if (ids.length) {
        const rows = await tx.all(
          `SELECT t.id, t.deadline_date, t.deadline_time, p.target_date AS plan_target_date
             FROM tasks t LEFT JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
            WHERE t.user_id=? AND t.id IN (${ids.map(() => '?').join(',')})`,
          [userId, ...ids]);
        const byId = new Map(rows.map(t => [Number(t.id), t]));
        const violations = [];
        for (const b of candidateBlocks) {
          const v = effectiveDeadlineViolation(b, byId.get(Number(b.task_id)));
          if (v) violations.push(v);
        }
        if (violations.length) throw new ScheduleDeadlineViolationError(violations);
      }
    }
    const version = await createScheduleVersionInTx(tx, userId, {
      source, reason, effectiveFrom: effFrom, parentVersionId: active?.active_version_id ?? null,
      blocks: candidateBlocks,
    });
    return { ...version, created: [...created.entries()].map(([client_key, id]) => ({ client_key, id })) };
  })));
}

/* ============================================================
   段考計畫的原子建立（server-authoritative）
   ============================================================ */

// 段考錯誤：scope／排程不合格時 fail closed，不建立任何 Plan。
export class ExamPlanError extends Error {
  constructor(message, code = undefined, status = 400, extra = {}) {
    super(message);
    this.name = 'ExamPlanError';
    this.status = status;
    if (code) this.code = code;
    Object.assign(this, extra);
  }
}

// 從 CURRENT 世界建立段考 scope：科目／教材／手動範圍 → scheduler items ＋驗證 ＋指紋。
//
// runner 可為 q（route 預覽階段）或 tx（apply 交易內重讀，防 TOCTOU）。**兩處共用
// 同一支**：確保 preview 依據的 scope 與 apply 實際落庫、實際排程的 scope 完全一致，
// 這正是「candidate 精確對應 CURRENT 選取」的覆蓋證明來源——client 完全不送 blocks。
//
// 硬規則（scheduled = daily／timed 時 fail closed，不靜默略過）：
//   ・科目：擁有權、不重複、考試日 canonical 且落在 [start,end]
//   ・教材項目：CURRENT 重讀擁有權、所屬書的科目必須在本次考試科目內、未完成、
//     （排程時）必須有 CURRENT 估計時間
//   ・手動範圍：label 非空、（有指定科目時）科目必須在考試科目內；排程時必須有科目
//     與估計時間，缺一律 fail closed（不像舊前端那樣 `if (!est) continue` 靜默丟掉）
//   ・同一科的範圍名稱不可重複（排程時），否則 block↔task 對不回去
export async function buildExamScope(runner, userId, {
  endDate, startDate = null, level = 'progress',
  subjects = [], materialIds = [], manual = [],
}) {
  const scheduled = level === 'daily' || level === 'timed';
  if (!isValidDay(endDate)) throw new ExamPlanError('請設定段考結束日期', 'INVALID_END_DATE');
  if (startDate != null && startDate !== '' && !isValidDay(startDate)) throw new ExamPlanError('開始日期不正確', 'INVALID_START_DATE');
  if (startDate && endDate < startDate) throw new ExamPlanError('結束日期不能早於開始日期', 'END_BEFORE_START');
  if (!Array.isArray(subjects) || !subjects.length) throw new ExamPlanError('請至少加入一個考試科目', 'NO_SUBJECT');

  // ① 科目
  const seen = new Set();
  const examBySubject = new Map();
  const orderedSubjects = [];
  for (const s of subjects) {
    const sid = Number(s.subject_list_id);
    if (!Number.isInteger(sid)) throw new ExamPlanError('找不到其中一個科目', 'SUBJECT_NOT_FOUND');
    if (seen.has(sid)) throw new ExamPlanError('同一個科目不能重複加入', 'DUPLICATE_SUBJECT');
    seen.add(sid);
    const l = await runner.get('SELECT id FROM lists WHERE id=? AND user_id=?', [sid, userId]);
    if (!l) throw new ExamPlanError('找不到其中一個科目', 'SUBJECT_NOT_FOUND');
    const exam = (s.exam_date == null || s.exam_date === '') ? endDate : s.exam_date;
    if (!isValidDay(exam)) throw new ExamPlanError('某一科的考試日期不正確', 'INVALID_EXAM_DATE');
    if (startDate && exam < startDate) throw new ExamPlanError('單科考試日不能早於開始日期', 'EXAM_BEFORE_START');
    if (exam > endDate) throw new ExamPlanError('單科考試日不能晚於段考結束日', 'EXAM_AFTER_END');
    examBySubject.set(sid, exam);
    orderedSubjects.push({ subject_list_id: sid, exam_date: exam });
  }

  const scopeItems = [];        // { kind, subjectId, title, minutes, contentItemId, bookId, deadline, label }
  const subjectsWithScope = new Set();
  const sigParts = [];
  const uniqTitle = new Set();
  const requireUniqueTitle = title => {
    if (uniqTitle.has(title)) throw new ExamPlanError(`同一科出現重複的範圍名稱，無法區分：${title}`, 'DUPLICATE_SCOPE_TITLE');
    uniqTitle.add(title);
  };

  // ② 教材項目（CURRENT 重讀）
  const matIds = [...new Set((materialIds || []).map(Number).filter(Number.isInteger))];
  for (const cid of matIds) {
    const it = await runner.get(
      `SELECT i.id, i.title, i.estimated_minutes, i.book_id, b.subject_list_id,
              b.title AS book_title, COALESCE(ch.title, n.title) AS chapter_title,
              COALESCE(p.completed,0) AS completed
         FROM material_content_items i
         JOIN material_books b ON b.id=i.book_id AND b.user_id=i.user_id
         JOIN material_nodes n ON n.id=i.node_id AND n.user_id=i.user_id
         LEFT JOIN material_nodes ch ON ch.id=n.parent_id AND ch.user_id=i.user_id
         LEFT JOIN material_progress p ON p.content_item_id=i.id AND p.user_id=i.user_id
        WHERE i.id=? AND i.user_id=?`, [cid, userId]);
    if (!it) throw new ExamPlanError('教材範圍中有不存在或不屬於你的內容', 'MATERIAL_NOT_FOUND');
    const sid = Number(it.subject_list_id);
    if (!examBySubject.has(sid)) throw new ExamPlanError('教材範圍的科目不在本次考試科目內', 'MATERIAL_SUBJECT_NOT_IN_EXAM');
    if (Number(it.completed) === 1) throw new ExamPlanError('已完成的教材不需要再排程', 'MATERIAL_COMPLETED');
    const title = `${it.book_title ? it.book_title + '｜' : ''}${it.chapter_title ? it.chapter_title + '｜' : ''}${it.title}`;
    const est = Number(it.estimated_minutes) > 0 ? Number(it.estimated_minutes) : null;
    if (scheduled && est == null) throw new ExamPlanError(`教材項目缺少估計時間，無法排入每天安排：${title}`, 'MATERIAL_ESTIMATE_MISSING', 422);
    if (scheduled) requireUniqueTitle(`${sid}\u0000${title}`);
    scopeItems.push({ kind: 'material', subjectId: sid, title, minutes: est ?? 30, contentItemId: cid, bookId: it.book_id ?? null, deadline: examBySubject.get(sid), label: null });
    subjectsWithScope.add(sid);
    sigParts.push(`m:${cid}:${est ?? ''}:${sid}:${title}`);
  }

  // ③ 手動範圍
  const manualEntries = [];
  for (const m of (manual || [])) {
    const label = String(m.label || '').trim();
    if (!label) throw new ExamPlanError('手動範圍必須有名稱', 'MANUAL_LABEL_MISSING');
    const sid = (m.subject_list_id == null || m.subject_list_id === '') ? null : Number(m.subject_list_id);
    if (sid != null && !examBySubject.has(sid)) throw new ExamPlanError('手動範圍的科目不在本次考試科目內', 'MANUAL_SUBJECT_NOT_IN_EXAM');
    const est = Number.isInteger(m.estimated_minutes) && m.estimated_minutes > 0 ? m.estimated_minutes : null;
    if (scheduled) {
      // fail closed：daily／timed 下缺科目或缺估時的手動範圍**不得靜默略過**，
      // 否則老師指定的範圍會憑空消失、使用者卻以為排進去了。
      if (sid == null) throw new ExamPlanError(`手動範圍需要指定科目才能排入每天安排：${label}`, 'MANUAL_SUBJECT_REQUIRED', 422);
      if (est == null) throw new ExamPlanError(`手動範圍缺少預估時間，無法排入每天安排：${label}`, 'MANUAL_ESTIMATE_MISSING', 422);
      requireUniqueTitle(`${sid}\u0000${label}`);
      scopeItems.push({ kind: 'manual', subjectId: sid, title: label, minutes: est, contentItemId: null, bookId: null, deadline: examBySubject.get(sid), label });
      sigParts.push(`x:${sid}:${est}:${label}`);
    }
    manualEntries.push({ subject_list_id: sid, label, estimated_minutes: est });
    if (sid != null) subjectsWithScope.add(sid);
  }

  const missingSubjectIds = orderedSubjects
    .map(s => Number(s.subject_list_id))
    .filter(sid => !subjectsWithScope.has(sid));
  // 保留既有 API 語意：daily／timed 完全沒有任何範圍時，先回總空錯誤；
  // 有部分科目已選、部分漏選時，才回逐科缺漏。
  if (scheduled && subjectsWithScope.size === 0) {
    throw new ExamPlanError('這個安排方式需要至少一項可排入的範圍', 'EXAM_SCOPE_EMPTY', 422);
  }
  if (missingSubjectIds.length) {
    throw new ExamPlanError('每個考試科目都必須至少加入一項教材或老師指定範圍',
      'SUBJECT_SCOPE_MISSING', 422, { subject_ids: missingSubjectIds });
  }

  const sig = sigParts.slice().sort().join('|');
  return { orderedSubjects, examBySubject, scopeItems, manualEntries, materialIds: matIds, sig };
}

// 段考計畫的**單一交易**建立：Plan＋各科考試日＋教材選取＋手動 scope＋（daily／timed）
// 每科 Task（deadline＝該科 CURRENT 考試日）＋ ScheduleVersion＋blocks，全部同生共死。
//
// 這支取代舊的「tx1 建 Plan、tx2 applySchedule、失敗補償刪除」——補償刪除不是原子性，
// 任一步失敗都可能留下半成品。這裡一切都在一筆 q.tx 裡，任何 throw 直接整筆 rollback，
// 對外零可見殘留（沒有 Plan、沒有 Task、沒有 version）。
//
// server-authoritative：blocks 由伺服器用 CURRENT scope 自己排（runPreview 在交易外唯讀
// 算好後傳入），client 不送 task_creates／blocks；deadline 一律以 CURRENT 該科考試日覆寫，
// 不信 client；scope 在交易內重讀並以指紋比對 preview 當時（TOCTOU／覆蓋證明）。
export async function createExamPlanAtomic(userId, {
  name, description = '', startDate = null, endDate,
  level = 'progress', subjects = [], materialIds = [], manual = [],
  computedBlocks = [], scopeSig = null, previewToken = null,
}) {
  const scheduled = level === 'daily' || level === 'timed';
  const at = new Date().toISOString();
  const creationKey = typeof previewToken === 'string'
    ? createHash('sha256').update(previewToken).digest('hex') : null;
  return serializeWrite(() => withVersionNoRetry(() => q.tx(async tx => {
    // 同一份已簽章 preview 是同一次建立意圖。回應遺失或 client 重送時回到原 Plan，
    // 不得再建一份；失敗交易會連同 commit marker 一起 rollback，仍可安全重試。
    if (creationKey) {
      const committed = await tx.get(
        'SELECT plan_id FROM exam_plan_commits WHERE user_id=? AND creation_key=?',
        [userId, creationKey]);
      if (committed?.plan_id != null) return { planId: Number(committed.plan_id), replayed: true };
    }
    // ① 交易內重讀 CURRENT scope（TOCTOU）。
    const scope = await buildExamScope(tx, userId, { endDate, startDate, level, subjects, materialIds, manual });
    const signed = verifyExamPlanPreview(previewToken);
    const state = await tx.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
    const requestShape = {
      user_id: Number(userId), level, start_date: startDate || null, end_date: endDate,
      subjects: scope.orderedSubjects,
      material_ids: scope.materialIds,
      manual_scope: scope.manualEntries,
      scope_sig: scope.sig,
      base_version_id: state?.active_version_id ?? null,
      blocks: computedBlocks,
    };
    if (!signed || JSON.stringify(signed) !== JSON.stringify(requestShape)) {
      throw new ExamPlanError('段考範圍或安排已更新，請重新預覽', 'EXAM_PREVIEW_STALE', 409);
    }
    // 覆蓋證明／防 stale：CURRENT scope 指紋必須等於 preview 當時。
    if (scheduled && scopeSig != null && scope.sig !== scopeSig) {
      throw new ScheduleStalePreviewError(null);
    }
    if (scheduled && !scope.scopeItems.length) {
      throw new ExamPlanError('這個安排方式需要至少一項可排入的範圍', 'EXAM_SCOPE_EMPTY', 422);
    }

    // ② Plan。daily／timed 需要 active 才能掛 Task／排程；progress 也建 active。
    const r = await tx.run(
      `INSERT INTO plans (user_id,name,description,primary_list_id,start_date,target_date,status,source,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [userId, String(name).trim(), description || '', scope.orderedSubjects[0]?.subject_list_id ?? null,
        startDate || null, endDate, 'active', 'manual', at, at]);
    const planId = Number(r.lastInsertRowid);

    // ③ 各科考試日
    let oi = 0;
    for (const s of scope.orderedSubjects) {
      await tx.run(
        `INSERT INTO plan_exam_subjects (user_id,plan_id,subject_list_id,exam_date,order_index)
         VALUES (?,?,?,?,?)`, [userId, planId, s.subject_list_id, s.exam_date, oi++]);
    }

    // ④ Task（僅 daily／timed）＋教材選取＋手動 scope。deadline 一律用 CURRENT 該科考試日。
    const taskIdByKey = new Map();          // `${subjectId}\u0000${title}` → task_id
    const taskDeadline = new Map();         // task_id → deadline（考試日）
    const materialTaskByCid = new Map();    // content_item_id → task_id
    const manualTaskByKey = new Map();      // `${subjectId}\u0000${label}` → task_id
    if (scheduled) {
      for (const si of scope.scopeItems) {
        const tr = await tx.run(
          `INSERT INTO tasks (user_id,list_id,title,notes,priority,tags,subtasks,recurring,miss_policy,plan_id,deadline_date,estimated_minutes,material_content_item_id,material_book_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [userId, si.subjectId, si.title, '', 0,
            JSON.stringify(['讀書計劃']), JSON.stringify([]), null, 'keep',
            planId, si.deadline, si.minutes, si.contentItemId, si.bookId]);
        const tid = Number(tr.lastInsertRowid);
        taskIdByKey.set(`${si.subjectId}\u0000${si.title}`, tid);
        taskDeadline.set(tid, si.deadline);
        if (si.kind === 'material') materialTaskByCid.set(Number(si.contentItemId), tid);
        else manualTaskByKey.set(`${si.subjectId}\u0000${si.label}`, tid);
      }
    }

    // 教材選取（plan_material_items）：selected=1，daily／timed 綁 task_id。
    for (const cid of scope.materialIds) {
      await tx.run(
        `INSERT INTO plan_material_items (user_id,plan_id,content_item_id,selected,task_id,updated_at)
         VALUES (?,?,?,1,?,CURRENT_TIMESTAMP)
         ON CONFLICT(plan_id,content_item_id) DO UPDATE SET selected=1, removed_at=NULL, task_id=excluded.task_id, updated_at=CURRENT_TIMESTAMP`,
        [userId, planId, cid, materialTaskByCid.get(Number(cid)) ?? null]);
    }
    // 手動 scope（plan_manual_scope）：first-class 範圍；progress 無 task，daily／timed 綁 task_id。
    oi = 0;
    for (const m of scope.manualEntries) {
      const tid = (scheduled && m.subject_list_id != null)
        ? (manualTaskByKey.get(`${Number(m.subject_list_id)}\u0000${m.label}`) ?? null) : null;
      await tx.run(
        `INSERT INTO plan_manual_scope (user_id,plan_id,subject_list_id,label,estimated_minutes,task_id,order_index)
         VALUES (?,?,?,?,?,?,?)`,
        [userId, planId, m.subject_list_id ?? null, m.label, m.estimated_minutes ?? null, tid, oi++]);
    }

    // progress 模式不是「只記截止日」：每一科都要形成一段可閱讀、可再編輯的
    // 起訖進度目標。教材項目放進 scope_json；老師指定範圍仍由
    // plan_manual_scope 保存，兩者都在同一筆建立交易內，不會留下半套資料。
    if (level === 'progress') {
      const rows = await tx.all('SELECT id,name FROM lists WHERE user_id=?', [userId]);
      const segments = buildExamProgressSegments(scope, startDate || todayTW(),
        new Map(rows.map(row => [Number(row.id), row.name])));
      for (const segment of segments) {
        await tx.run(
          `INSERT INTO plan_progress_segments
             (user_id,plan_id,start_date,end_date,subject_list_id,title,scope_json,kind,order_index)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [userId, planId, segment.start_date, segment.end_date, segment.subject_list_id,
            segment.title, JSON.stringify(segment.scope), 'study', segment.order_index]);
      }
    }

    // ⑤ 排程（daily／timed）：把伺服器算好的 blocks 對回 Task，逐項驗覆蓋與 deadline。
    if (scheduled) {
      const resolved = [];
      const coveredTasks = new Set();
      const scheduledMinutes = new Map();
      for (const b of computedBlocks) {
        if (b._pinned) continue;                       // 其他 Plan 的 pin，由 carry-forward 帶
        const key = `${b.subject_id}\u0000${b.title}`;
        const tid = taskIdByKey.get(key);
        if (tid == null) {
          // block 對不到任何 CURRENT scope task ⇒ preview 依據的 scope 已與 CURRENT 不一致。
          throw new ScheduleStalePreviewError(null);
        }
        // deadline 硬上限：一律以 CURRENT 該科考試日再驗，不信 client 算好的日期。
        if (b.date > taskDeadline.get(tid)) {
          throw new ScheduleDeadlineViolationError([{ task_id: tid, date: b.date, deadline_date: taskDeadline.get(tid) }]);
        }
        coveredTasks.add(tid);
        const mins = (b.start_time && b.end_time)
          ? (Number(b.end_time.slice(0, 2)) * 60 + Number(b.end_time.slice(3, 5))) - (Number(b.start_time.slice(0, 2)) * 60 + Number(b.start_time.slice(3, 5)))
          : 0;
        scheduledMinutes.set(tid, (scheduledMinutes.get(tid) || 0) + mins);
        resolved.push({ task_id: tid, date: b.date, start_time: b.start_time || null, end_time: b.end_time || null });
      }
      // 覆蓋證明：每一個 scope task 都必須至少排入一格；沒有 → 任務會遺失 → fail closed。
      for (const [key, tid] of taskIdByKey) {
        if (!coveredTasks.has(tid)) throw new ExamPlanError('有內容排不進去，無法建立每天安排', 'EXAM_SCHEDULE_GAP', 422, { uncovered: key });
      }
      // timed：每個 Task 排定分鐘總和必須等於 CURRENT 估時（forge-proof，不信 client）。
      if (level === 'timed') {
        for (const [key, tid] of taskIdByKey) {
          const want = scope.scopeItems.find(si => `${si.subjectId}\u0000${si.title}` === key)?.minutes ?? 0;
          if ((scheduledMinutes.get(tid) || 0) !== Number(want)) throw new ScheduleStalePreviewError(null);
        }
      }

      // 其他 Plan 的未來 block 原封不動 carry-forward（ScheduleVersion 是 user-level 全域 snapshot）。
      const effFrom = todayTW();
      const active = state;
      const carry = await otherPlanCarryForwardBlocks(tx, userId, active?.active_version_id ?? null, planId, effFrom);
      const candidate = [...carry, ...resolved];
      validateTimedBlockOverlaps(candidate);
      await assertCandidateLocks(tx, userId, active?.active_version_id ?? null, candidate);
      await createScheduleVersionInTx(tx, userId, {
        source: SOURCE.INITIAL, reason: `段考「${String(name).trim()}」建立`, effectiveFrom: effFrom,
        parentVersionId: active?.active_version_id ?? null, blocks: candidate,
      });
    }

    await tx.run(
      'INSERT INTO exam_plan_commits (user_id,creation_key,plan_id,created_at) VALUES (?,?,?,?)',
      [userId, creationKey, planId, at]);

    return { planId };
  })));
}

// 只有「重試一次就會好、而且語意完全不變」的衝突可以重試：
//
//   ① version_no 唯一鍵衝突 —— 號碼被別人先用走了，換個號碼寫進去就好，
//      candidate 的內容一模一樣（契約 §7.2，最多 3 次）
//   ② SQLITE_BUSY / database is locked —— 本機 SQLite 一次只允許一個寫入交易。
//      這是基礎設施層的暫時性鎖，不是語意衝突。（遠端 Turso 由伺服器端序列化，
//      實測本機檔案模式才會出現，但 dev 與測試都跑本機，必須擋住。）
//
// ⚠️ 2C-4 §38 的 base_version_id stale 長得也像併發衝突，但**絕對不能** retry：
// 那表示使用者看到的排程已經不是現在的排程，重試等於把他沒看過的變更靜默套用
// 下去，必須直接 409（見 §7.2.1）。
//
// 所以這支只認上面兩種，其他例外一律原樣往上拋。
// P4 實作 stale protection 時請另外寫，不要把 stale 併進這個 catch。
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 建立版本在**同一個程序內**序列化。
//
// 實測發現：本機 SQLite（dev 與測試都是）一次只允許一個寫入交易，
// 同時開兩個 client.transaction('write') 會直接 SQLITE_BUSY，而且因為每個
// 交易都握著鎖不放，光靠重試會一起卡死。遠端 Turso 由伺服器端序列化，
// 不會有這個現象——但不能因為 production 沒事就讓 dev 與測試是壞的。
//
// 這條佇列只解決「同一個 Node 程序內的併發」。跨程序／多實例仍然靠
// UNIQUE(user_id, version_no) ＋ 上面的 bounded retry 擋，兩層都要有。
let writeQueue = Promise.resolve();
function serializeWrite(fn) {
  const run = writeQueue.then(fn, fn);
  // 佇列本身不能被前一筆的失敗中斷，所以吞掉結果只留順序
  writeQueue = run.then(() => {}, () => {});
  return run;
}

async function withVersionNoRetry(fn) {
  let collisions = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (isVersionNoCollision(e)) {
        if (++collisions >= VERSION_NO_RETRIES) throw e;   // 契約 §7.2：最多 3 次
        continue;
      }
      if (isBusy(e)) { await sleep(15 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw new Error('建立排程版本失敗：重試次數用盡');
}

function isVersionNoCollision(e) {
  const m = String(e?.message || '');
  return /UNIQUE constraint failed: schedule_versions\.user_id, schedule_versions\.version_no/i.test(m)
    || /idx_sv_user_no/i.test(m);
}

function isBusy(e) {
  return /SQLITE_BUSY|database is locked/i.test(String(e?.message || '') + String(e?.code || ''));
}

/* ============================================================
   due_date / due_time 鏡射
   ============================================================ */

// active version 切換成功後，把排定位置鏡射回 Task（§4.3）。
//
// 有 block → due_date/due_time = block 的位置
// Plan Task 在這一版沒有 block → due_date/due_time = NULL，這是正式的 unplaced，
//   不得保留舊的 due_date（那會讓畫面顯示一個其實已經不存在的安排）
// 非 Plan Task（plan_id IS NULL）→ 完全不受影響
//
// 已完成的任務也不動：它們不屬於「未來排程」，due_date 是它當初做的那天，
// 是歷史紀錄。把它清成 NULL 會讓行事曆上的完成紀錄整批消失。
const MIRROR_WHERE = `user_id=? AND plan_id IS NOT NULL AND COALESCE(deleted,0)=0 AND completed=0 AND COALESCE(cancelled,0)=0`;

async function mirrorDueDates(tx, userId, versionId) {
  await tx.run(
    `UPDATE tasks SET
       due_date = (SELECT b.date FROM scheduled_blocks b
                    WHERE b.schedule_version_id=? AND b.task_id=tasks.id
                    ORDER BY b.date, COALESCE(b.start_time,''), b.id LIMIT 1),
       due_time = (SELECT b.start_time FROM scheduled_blocks b
                    WHERE b.schedule_version_id=? AND b.task_id=tasks.id
                    ORDER BY b.date, COALESCE(b.start_time,''), b.id LIMIT 1)
     WHERE ${MIRROR_WHERE}`,
    [versionId, versionId, userId]);
}

/* ============================================================
   Bootstrap（2A → 2C cutover，§8）
   ============================================================ */

// 第一次進入 2C persistence 時，把既有的排定日期收成 V1。
//
// 只搬「未完成、屬於某個計畫、而且 due_date 在 planning day 當天或之後」的任務：
//   ・沒有 due_date → 不建 block，成為 unplaced（不是消失）
//   ・due_date 在過去 → 不建 block。snapshot 不涵蓋過去，不能捏造歷史
//   ・非 Plan Task → 完全不參與
//
// 已經有 active version 就直接回傳，不會再建一個 V1。
export async function bootstrapScheduleIfNeeded(userId, planningDay = todayTW()) {
  const existing = await getActiveVersionId(userId);
  if (existing != null) return { created: false, version_id: existing };

  const rows = await q.all(
    `SELECT t.id,t.due_date,t.due_time FROM tasks t
      JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
      WHERE t.user_id=? AND t.plan_id IS NOT NULL AND COALESCE(t.deleted,0)=0
        AND t.completed=0 AND COALESCE(t.cancelled,0)=0 AND t.due_date IS NOT NULL AND t.due_date >= ?
        AND p.status IN ('draft','active')
      ORDER BY t.due_date, COALESCE(t.due_time,''), t.id`,
    [userId, planningDay]);

  // legacy Task 只有 due_time，沒有可證實的 duration；不能杜撰 60 分鐘工作量。
  // 收成 date-only block，讓它仍是正式 placement、卻不假裝有 timed window。
  const blocks = rows.map(t => ({ task_id: t.id, date: t.due_date }));

  const r = await createScheduleVersion(userId, {
    source: SOURCE.BOOTSTRAP,
    reason: BOOTSTRAP_REASON,
    effectiveFrom: planningDay,
    parentVersionId: null,
    blocks,
    onlyIfNoActive: true,
  });
  if (r.existing_version_id != null) return { created: false, version_id: r.existing_version_id };
  return { created: true, ...r };
}
