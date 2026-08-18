import { q } from '../db/init.js';
import { dayOfWeek, todayTW } from '../util/date.js';
import { checkLocks } from './locks.js';
import { calculateScheduleDiff } from './diff.js';

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
  return q.all(
    `SELECT id, task_id, date, start_time, end_time, planned_minutes,
            task_title_snapshot, subject_name_snapshot
       FROM scheduled_blocks
      WHERE schedule_version_id=? AND user_id=?
      ORDER BY date, COALESCE(start_time,''), id`,
    [versionId, userId]);
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
      WHERE t.user_id=? AND t.plan_id IS NOT NULL
        AND COALESCE(t.deleted,0)=0 AND t.completed=0
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
    getBlocks(userId, version.id),
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

function fixedEventApplies(event, date) {
  return event.recurring === 'weekly'
    ? dayOfWeek(event.date) === dayOfWeek(date) && event.date <= date
    : event.date === date;
}

function timedOverlap(a, b) {
  return a.date === b.date && a.start_time && a.end_time && b.start_time && b.end_time
    && a.start_time < b.end_time && b.start_time < a.end_time;
}

const lockNow = () => ({ day: todayTW(), time: twNowHM() });
async function assertCandidateLocks(tx, userId, activeVersionId, candidate) {
  if (activeVersionId == null) return;
  const [locks, tasks, active] = await Promise.all([
    tx.all('SELECT * FROM schedule_locks WHERE user_id=? AND released_at IS NULL', [userId]),
    tx.all('SELECT id,deleted,completed FROM tasks WHERE user_id=?', [userId]),
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
    db.all(`SELECT id, title, plan_id, deadline_date, deleted, completed
              FROM tasks WHERE user_id=?`, [userId]),
    db.all('SELECT date,start_time,end_time,recurring,title FROM fixed_events WHERE user_id=?', [userId]),
    db.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]),
    db.all('SELECT * FROM schedule_locks WHERE user_id=? AND released_at IS NULL', [userId]),
  ]);
  const tasks = new Map(liveTasks.map(t => [Number(t.id), t]));
  const candidates = [];
  const conflicts = [];
  const skipped = [];

  for (const block of sourceBlocks) {
    const task = tasks.get(Number(block.task_id));
    if (!task || task.deleted) { skipped.push({ task_id: block.task_id, reason: 'deleted' }); continue; }
    if (task.completed) { skipped.push({ task_id: block.task_id, reason: 'completed' }); continue; }
    if (task.plan_id == null) { conflicts.push({ task_id: block.task_id, block_id: block.id, type: 'task_constraint', message: '任務已不屬於計畫，無法恢復', block }); continue; }
    const isPast = block.date < planningDay
      || (block.date === planningDay && block.end_time && block.end_time <= nowHM);
    if (isPast) { conflicts.push({ task_id: block.task_id, block_id: block.id, type: 'past', message: '原安排時間已過去，無法恢復', block }); continue; }
    if (task.deadline_date && block.date > task.deadline_date) {
      conflicts.push({ task_id: block.task_id, block_id: block.id, type: 'deadline', message: '目前期限早於原安排日期，無法恢復', block, deadline_date: task.deadline_date });
      continue;
    }
    const fixed = events.find(event => fixedEventApplies(event, block.date) && timedOverlap(block, event));
    if (fixed) { conflicts.push({ task_id: block.task_id, block_id: block.id, type: 'fixed_event', message: `與固定行程「${fixed.title}」衝突`, block, event_title: fixed.title }); continue; }
    candidates.push({ id: block.id, task_id: block.task_id, date: block.date, start_time: block.start_time, end_time: block.end_time, planned_minutes: block.planned_minutes, task_title_snapshot: block.task_title_snapshot });
  }

  // 舊版若本身有 timed overlap，也不能因為它曾經存在就重新寫回 active snapshot。
  // 每一個撞到的 placement 都列出，讓 UI 明確告知無法恢復的原因。
  const collided = new Set();
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    if (timedOverlap(candidates[i], candidates[j])) { collided.add(i); collided.add(j); }
  }
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
    return task && !task.deleted && !task.completed && task.plan_id != null;
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
  // 都會是新版本的 unplaced。completed/deleted 已退出 future schedule，不列入。
  const unplacedTaskIds = liveTasks.filter(t => t.plan_id != null && !t.deleted && !t.completed && !scheduledIds.has(Number(t.id)))
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

// 給 P2 的「任務身分異動＋新版排程」共用。呼叫端已經握有同一筆 transaction
// 時，不能再開巢狀交易；版本本體仍然只由這個檔案寫入。
async function createScheduleVersionInTx(tx, userId, {
  source, reason = '', effectiveFrom = null,
  parentVersionId = null, restoredFromVersionId = null,
  blocks = [], setActive = true, onlyIfNoActive = false, expectedActiveVersionId = undefined,
}) {
    const effFrom = effectiveFrom || todayTW();
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
        reason, source, effFrom, blocks.length]);
    const versionId = v.lastInsertRowid;

    // ② blocks。每一個都必須是這位使用者有效、未完成的 Plan Task；不得寫入
    // orphan、別人的任務、一般待辦、已刪除或已完成任務。任何一筆不合法都使
    // 整個 transaction rollback，不能 silently skip 或留下 partial version。
    for (const b of blocks) {
      const t = await tx.get(
        `SELECT t.id, t.title, t.plan_id, t.deleted, t.completed, l.name AS subject
           FROM tasks t LEFT JOIN lists l ON l.id = t.list_id
          WHERE t.id=? AND t.user_id=?`, [b.task_id, userId]);
      if (!t) throw new ScheduleInputError(`排程任務不存在或不屬於目前使用者：${b.task_id}`);
      if (t.plan_id == null) throw new ScheduleInputError(`排程任務必須屬於計畫：${b.task_id}`);
      if (t.deleted) throw new ScheduleInputError(`排程任務已刪除：${b.task_id}`);
      if (t.completed) throw new ScheduleInputError(`排程任務已完成：${b.task_id}`);
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

    return { version_id: versionId, version_no: versionNo, block_count: blocks.length };
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
    const plan = await tx.get('SELECT id FROM plans WHERE id=? AND user_id=?', [planId, userId]);
    if (!plan) throw new ScheduleInputError('找不到這個計畫');

    const assertLivePlanTask = async taskId => {
      const task = await tx.get(
        `SELECT id, plan_id, deleted, completed FROM tasks WHERE id=? AND user_id=?`,
        [taskId, userId]);
      if (!task || Number(task.plan_id) !== Number(planId) || task.deleted || task.completed) {
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
        `INSERT INTO tasks (user_id,list_id,title,notes,priority,tags,subtasks,recurring,miss_policy,plan_id,deadline_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [userId, c.list_id || null, String(c.title).trim(), c.notes || '', c.priority || 0,
          JSON.stringify(c.tags || []), JSON.stringify(c.subtasks || []), c.recurring || null,
          c.miss_policy || 'keep', planId, c.deadline_date || null]);
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
      : await tx.all(
        `SELECT b.task_id, b.date, b.start_time, b.end_time, b.planned_minutes
           FROM scheduled_blocks b
           JOIN tasks t ON t.id=b.task_id AND t.user_id=b.user_id
          WHERE b.schedule_version_id=? AND b.user_id=?
            AND t.plan_id IS NOT NULL AND t.plan_id<>?
            AND COALESCE(t.deleted,0)=0 AND t.completed=0
            AND b.date>=?
          ORDER BY b.date, COALESCE(b.start_time,''), b.id`,
        [active.active_version_id, userId, planId, effFrom]);
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
const MIRROR_WHERE = `user_id=? AND plan_id IS NOT NULL AND COALESCE(deleted,0)=0 AND completed=0`;

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
        AND completed=0 AND due_date IS NOT NULL AND due_date >= ?
      ORDER BY due_date, COALESCE(due_time,''), id`,
    [userId, planningDay]);

  const blocks = rows.map(t => ({
    task_id: t.id,
    date: t.due_date,
    start_time: t.due_time ?? null,
    end_time: null,
    planned_minutes: null,
  }));

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
