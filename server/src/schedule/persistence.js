import { q } from '../db/init.js';
import { dayOfWeek, todayTW } from '../util/date.js';
import { checkLocks } from './locks.js';
import { calculateScheduleDiff } from './diff.js';
import { classifyPlacement, findSelfCollisions, timedOverlap } from './feasibility.js';
import { canonicalizeBlockTiming, timingProblem } from './timing.js';

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
  constructor(message) {
    super(message);
    this.name = 'ScheduleInputError';
    this.status = 400;
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
    `SELECT t.id, t.title, t.plan_id, t.list_id, t.deadline_date
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
    db.all(`SELECT t.id,t.title,t.plan_id,t.deadline_date,t.deleted,t.completed,t.cancelled,
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

  const scheduledIds = new Set(lockedRestorable.map(b => Number(b.task_id)));
  const conflictIds = new Set(conflicts.map(c => Number(c.task_id)));
  // Restore 不 overlay active：template 中沒有的新任務，以及無法恢復的有效任務，
  // 都會是新版本的 unplaced。已完成／取消／刪除，或非 draft/active 計畫，
  // 都已退出 future schedule，不列入。
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
    db.all('SELECT id, title, plan_id, deadline_date, deleted, completed, cancelled FROM tasks WHERE user_id=?', [userId]),
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
export async function transitionPlanLifecycle(userId, planId, {
  nextStatus, endReason = null, baseVersionId = undefined,
}) {
  return serializeWrite(() => withVersionNoRetry(() => q.tx(async tx => {
    const plan = await tx.get('SELECT * FROM plans WHERE id=? AND user_id=?', [planId, userId]);
    if (!plan) throw new ScheduleInputError('找不到這個計畫');
    // lifecycle 不是可任意覆寫的欄位。明確限制轉換，避免把「重新開始」
    // 誤用成 paused -> completed 等沒有產品語意的捷徑。
    const allowed = {
      draft: new Set(['active', 'ended', 'archived']),
      active: new Set(['paused', 'completed', 'ended', 'archived']),
      paused: new Set(['active', 'ended', 'archived']),
      completed: new Set(['active', 'archived']),
      ended: new Set(['active', 'archived']),
      archived: new Set([plan.archived_from_status || 'active']),
    };
    if (!allowed[plan.status]?.has(nextStatus)) {
      throw new ScheduleInputError('這個計畫目前不能進行此狀態轉換');
    }
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
    await tx.run(
      `UPDATE plans SET status=?, completed_at=?, paused_at=?, ended_at=?, end_reason=?,
                        archived_at=?, archived_from_status=?, updated_at=?
        WHERE id=? AND user_id=?`,
      [nextStatus,
        nextStatus === 'completed' ? (plan.completed_at || at) : null,
        nextStatus === 'paused' ? (plan.paused_at || at) : null,
        nextStatus === 'ended' ? (plan.ended_at || at) : null,
        nextStatus === 'ended' ? (endReason || null) : null,
        nextStatus === 'archived' ? (plan.archived_at || at) : null,
        nextStatus === 'archived' ? archivedFrom : null,
        at, plan.id, userId]);

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
          AND p.status NOT IN ('paused','completed','ended','archived')
        ORDER BY b.date,COALESCE(b.start_time,''),b.id`,
      [userId, activeId, effectiveFrom, planId])).map(canonicalizeBlockTiming);
    validateTimedBlockOverlaps(candidate);
    await assertCandidateLocks(tx, userId, activeId, candidate);
    const version = await createScheduleVersionInTx(tx, userId, {
      source: SOURCE.LIFECYCLE,
      reason: `計畫「${plan.name}」${nextStatus === 'paused' ? '暫停' : nextStatus === 'ended' ? '結束' : nextStatus === 'completed' ? '完成' : nextStatus === 'archived' ? '封存' : restoring ? '恢復' : '重新開始'}`,
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

    // ② blocks。每一個都必須是這位使用者有效、未完成的 Plan Task；不得寫入
    // orphan、別人的任務、一般待辦、已刪除或已完成任務。任何一筆不合法都使
    // 整個 transaction rollback，不能 silently skip 或留下 partial version。
    for (const b of normalizedBlocks) {
      const t = await tx.get(
        `SELECT t.id, t.title, t.plan_id, t.deleted, t.completed, t.cancelled, l.name AS subject
           FROM tasks t LEFT JOIN lists l ON l.id = t.list_id
          WHERE t.id=? AND t.user_id=?`, [b.task_id, userId]);
      if (!t) throw new ScheduleInputError(`排程任務不存在或不屬於目前使用者：${b.task_id}`);
      if (t.plan_id == null) throw new ScheduleInputError(`排程任務必須屬於計畫：${b.task_id}`);
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

// Wizard 初次建立與 AI Replan 的正式套用入口。任務的身分／內容變動與
// ScheduleVersion、active pointer、due mirror 必須同生共死；尤其不能先把
// Task 改到新日期、卻在建立版本失敗時留下半套資料。
//
// task_creates 的 client_key 只在本次 request 內用來把 preview block 對到新任務，
// 不落庫。既有任務一律以 task_id 指向，所有操作都強制限在同一 plan_id。
export async function applySchedule(userId, {
  planId, source, reason = '', effectiveFrom = null,
  taskUpdates = [], taskCreates = [], taskDeleteIds = [], blocks = [],
}) {
  if (!Number.isInteger(Number(planId))) throw new ScheduleInputError('缺少有效的計畫 id');
  if (![SOURCE.INITIAL, SOURCE.AI_REPLAN, SOURCE.MANUAL].includes(source)) {
    throw new ScheduleInputError('排程來源不正確');
  }
  return serializeWrite(() => withVersionNoRetry(() => q.tx(async tx => {
    const plan = await tx.get('SELECT id,status FROM plans WHERE id=? AND user_id=?', [planId, userId]);
    if (!plan) throw new ScheduleInputError('找不到這個計畫');
    if (!['draft', 'active'].includes(plan.status)) throw new ScheduleInputError('目前未執行的計畫不能重新排程');

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
    for (const c of taskCreates) {
      if (!c.client_key || created.has(c.client_key) || !String(c.title || '').trim()) {
        throw new ScheduleInputError('新任務資料不正確');
      }
      const r = await tx.run(
        `INSERT INTO tasks (user_id,list_id,title,notes,priority,tags,subtasks,recurring,miss_policy,plan_id,deadline_date,estimated_minutes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [userId, c.list_id || null, String(c.title).trim(), c.notes || '', c.priority || 0,
          JSON.stringify(c.tags || []), JSON.stringify(c.subtasks || []), c.recurring || null,
          c.miss_policy || 'keep', planId, c.deadline_date || null,
          c.estimated_minutes ?? (blocks.filter(b => b.client_key === c.client_key)
            .reduce((total, b) => total + (Number(b.planned_minutes) || 0), 0) || null)]);
      created.set(c.client_key, r.lastInsertRowid);
    }

    for (const taskId of taskDeleteIds) {
      await assertLivePlanTask(taskId);
      await tx.run('UPDATE tasks SET deleted=1 WHERE id=? AND user_id=?', [taskId, userId]);
    }

    const resolvedBlocks = blocks.map(b => {
      const taskId = b.task_id ?? created.get(b.client_key);
      if (taskId == null) throw new ScheduleInputError('排程區塊找不到對應任務');
      return { ...b, task_id: taskId };
    });
    const active = await tx.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
    const effFrom = effectiveFrom || todayTW();
    // ScheduleVersion 是 user-level 全域 snapshot，不是單一 Plan 的 snapshot。
    // 本次只替 current Plan 換 block；其他 Plan 仍有效的 future placement 必須從
    // active version 原封不動帶進 candidate，不然 mirror 會把它們誤判成 unplaced。
    const carryForwardBlocks = active?.active_version_id == null
      ? []
      : (await tx.all(
        `SELECT b.task_id, b.date, b.start_time, b.end_time, b.planned_minutes
           FROM scheduled_blocks b
           JOIN tasks t ON t.id=b.task_id AND t.user_id=b.user_id
          WHERE b.schedule_version_id=? AND b.user_id=?
            AND t.plan_id IS NOT NULL AND t.plan_id<>?
            AND COALESCE(t.deleted,0)=0 AND t.completed=0 AND COALESCE(t.cancelled,0)=0
            AND b.date>=?
          ORDER BY b.date, COALESCE(b.start_time,''), b.id`,
        [active.active_version_id, userId, planId, effFrom])).map(canonicalizeBlockTiming);
    const candidateBlocks = [...carryForwardBlocks, ...resolvedBlocks];
    // 即使 caller 繞過 preview，也不得把有重疊的全域 snapshot 寫進資料庫。
    // 這一步仍在 transaction 內，失敗時前面的 Task 異動會一併 rollback。
    validateTimedBlockOverlaps(candidateBlocks);
    await assertCandidateLocks(tx, userId, active?.active_version_id ?? null, candidateBlocks);
    const version = await createScheduleVersionInTx(tx, userId, {
      source, reason, effectiveFrom: effFrom, parentVersionId: active?.active_version_id ?? null,
      blocks: candidateBlocks,
    });
    return { ...version, created: [...created.entries()].map(([client_key, id]) => ({ client_key, id })) };
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
    `SELECT id, due_date, due_time FROM tasks
      WHERE user_id=? AND plan_id IS NOT NULL AND COALESCE(deleted,0)=0
        AND completed=0 AND COALESCE(cancelled,0)=0 AND due_date IS NOT NULL AND due_date >= ?
      ORDER BY due_date, COALESCE(due_time,''), id`,
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
