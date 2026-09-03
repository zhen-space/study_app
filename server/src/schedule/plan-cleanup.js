// Plan 暫停／刪除時，底下的 Task 要怎麼處理。
//
// 這裡是純函式：不查 DB、不寫 DB。理由是各種語意分歧點很細（「暫停但清掉未完成
// 任務」跟「刪除整個計畫」做的事完全不同），混在 transaction 裡面會變成沒人看得
// 懂、也沒辦法單獨測的一坨 if。
//
// 硬性契約：
//   ・任何情況都不 hard delete。Task 只走 soft-delete（deleted=1）；StudySession、
//     material_progress、歷史 ScheduleVersion／ScheduledBlock 一律不動。
//   ・**暫停**保留「是否保留未完成任務」選擇（retain_incomplete_tasks，必填 boolean）。
//   ・**刪除**沒有選擇：計畫與其中**所有** Task（含已完成、已取消）一律 soft-delete。
//     不 detach 成 standalone、不留下任何一般待辦。想保留進度但不再繼續，正確操作
//     是「結束計畫」，不是刪除。

export const RETAIN_FIELD = 'retain_incomplete_tasks';
export const RETAIN_REQUIRED_CODE = 'retain_choice_required';
export const RETAIN_REQUIRED_MESSAGE = '請明確選擇是否保留未完成任務';

// body.retain_incomplete_tasks → { ok, value } 或 { ok:false, code, message }
//
// 只接受真正的 boolean。'true' / 1 / 'false' / 0 全部拒絕：這是一個會決定
// 「任務被留下還是被刪掉」的開關，型別寬鬆一點都不值得。**只有暫停用得到它**。
export function parseRetainChoice(body) {
  const raw = (body ?? {})[RETAIN_FIELD];
  if (typeof raw !== 'boolean') {
    return { ok: false, code: RETAIN_REQUIRED_CODE, message: RETAIN_REQUIRED_MESSAGE };
  }
  return { ok: true, value: raw };
}

export const PLAN_CLEANUP_ACTIONS = ['pause', 'delete'];

// 回傳 { mode, scope }。
//   mode  ： 'none' | 'soft_delete'   —— 要不要把 scope 內的 Task 標成 deleted=1
//   scope ： 'incomplete' | 'all'     —— 影響哪些 Task（也決定要釋放哪些 Task lock）
//
//   暫停＋保留   → { none, incomplete }        Task 全留，只是整個 Plan 退出排程
//   暫停＋不保留 → { soft_delete, incomplete } 未完成 Task 軟刪；已完成／已取消保留
//   刪除         → { soft_delete, all }        所有 Task 一律軟刪（含已完成、已取消）
//
// 刪除**沒有 retain 參數**：產品規格已定案為「計畫與其中所有任務都從 App 移除」。
// 舊的「刪除＋保留 → detach 成 standalone」行為已整個移除，不得復活。
export function planTaskDisposition({ action, retain }) {
  if (action === 'delete') return { mode: 'soft_delete', scope: 'all' };
  if (action === 'pause') {
    if (typeof retain !== 'boolean') throw new Error('retain 必須是 boolean');
    return retain ? { mode: 'none', scope: 'incomplete' } : { mode: 'soft_delete', scope: 'incomplete' };
  }
  throw new Error(`未知的 Plan cleanup 動作：${action}`);
}

// 失效 lock 的釋放理由。Task lock 的主詞正在離開排程（被軟刪，或整個 Plan 退出），
// 鎖著一個不會再被排的任務沒有意義，所以 soft release 並留下理由，讓使用者在鎖定
// 列表看得到「為什麼不見了」。
//
// 反過來說 day / time lock **不釋放**：它們限制的是整體排程，不屬於任何 Plan
// （見 schedule_locks 的 schema 註解）。暫停一個 Plan 如果動到被鎖的那一天，
// 應該是明確擋下來讓使用者自己決定，而不是由系統偷偷解鎖繞過去。
export const LOCK_RELEASE_REASON = { pause: 'plan_paused', delete: 'plan_deleted' };
export function lockReleaseReason(action) {
  const reason = LOCK_RELEASE_REASON[action];
  if (!reason) throw new Error(`未知的 Plan cleanup 動作：${action}`);
  return reason;
}
