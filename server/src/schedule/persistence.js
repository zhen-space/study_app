import { q } from '../db/init.js';
import { todayTW } from '../util/date.js';

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
  blocks = [], setActive = true,
}) {
  const effFrom = effectiveFrom || todayTW();
  return serializeWrite(() => withVersionNoRetry(() => q.tx(async tx => {
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

    // ② blocks。snapshot 由這裡查 tasks / lists 填入
    for (const b of blocks) {
      const t = await tx.get(
        `SELECT t.title, l.name AS subject
           FROM tasks t LEFT JOIN lists l ON l.id = t.list_id
          WHERE t.id=? AND t.user_id=?`, [b.task_id, userId]);
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
      await tx.run(
        `INSERT INTO user_schedule_state (user_id, active_version_id, updated_at)
         VALUES (?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET active_version_id=excluded.active_version_id,
                                            updated_at=CURRENT_TIMESTAMP`,
        [userId, versionId]);
      // ④ 鏡射
      await mirrorDueDates(tx, userId, versionId);
    }

    return { version_id: versionId, version_no: versionNo, block_count: blocks.length };
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
  });
  return { created: true, ...r };
}
