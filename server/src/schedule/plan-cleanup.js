// Plan 暫停／刪除時，未完成 Task 要怎麼處理。
//
// 這裡是純函式：不查 DB、不寫 DB。理由是這四種組合的語意分歧點很細
// （「刪掉計畫但留著任務」跟「暫停計畫但不留任務」做的事完全不同），
// 混在 transaction 裡面會變成沒人看得懂、也沒辦法單獨測的一坨 if。
//
// 硬性契約：
//   ・retain_incomplete_tasks 一律必須明確給 true / false。沒給、給字串、
//     給 0/1 都要拒絕——「預設保留」這種善意猜測會讓使用者以為任務還在，
//     或以為任務已經清掉，兩種誤解都會造成資料上的意外。
//   ・任何情況都不 hard delete。未完成 Task 只走既有的 soft-delete（deleted=1）。
//   ・已完成 Task、StudySession、material_progress、歷史 ScheduleVersion
//     一律不動。這個檔案不產生任何會碰到它們的指令。

export const RETAIN_FIELD = 'retain_incomplete_tasks';
export const RETAIN_REQUIRED_CODE = 'retain_choice_required';
export const RETAIN_REQUIRED_MESSAGE = '請明確選擇是否保留未完成任務';

// body.retain_incomplete_tasks → { ok, value } 或 { ok:false, code, message }
//
// 只接受真正的 boolean。'true' / 1 / 'false' / 0 全部拒絕：這是一個會決定
// 「任務被留下還是被刪掉」的開關，型別寬鬆一點都不值得。
export function parseRetainChoice(body) {
  const raw = (body ?? {})[RETAIN_FIELD];
  if (typeof raw !== 'boolean') {
    return { ok: false, code: RETAIN_REQUIRED_CODE, message: RETAIN_REQUIRED_MESSAGE };
  }
  return { ok: true, value: raw };
}

export const PLAN_CLEANUP_ACTIONS = ['pause', 'delete'];

// 四種組合各自要對「未完成 Task」做什麼。
//
//   暫停＋保留 → 什麼都不動。Task 還在原 Plan 底下，只是整個 Plan 退出排程。
//   暫停＋不保留 → soft-delete。恢復 Plan 時不會自己活過來（deleted 仍是 1）。
//   刪除＋保留 → 轉成 standalone：plan_id=NULL，並清掉 Plan 排程鏡射的
//                due_date/due_time，否則舊安排會被當成使用者自己訂的期限。
//   刪除＋不保留 → soft-delete，plan_id 保留（歷史仍看得出它屬於哪個計畫）。
//
// 四種組合都會移除未來 ScheduledBlocks——那不是這裡做的，是呼叫端重建
// ScheduleVersion 時把整個 Plan 的 block 排除掉的結果。
export function planTaskDisposition({ action, retain }) {
  if (!PLAN_CLEANUP_ACTIONS.includes(action)) throw new Error(`未知的 Plan cleanup 動作：${action}`);
  if (typeof retain !== 'boolean') throw new Error('retain 必須是 boolean');
  if (!retain) return { detach: false, softDelete: true, clearScheduleMirror: false };
  if (action === 'delete') return { detach: true, softDelete: false, clearScheduleMirror: true };
  return { detach: false, softDelete: false, clearScheduleMirror: false };
}

// 失效 lock 的釋放理由。Task lock 的主詞正在離開排程（被刪、被拆成 standalone、
// 或整個 Plan 退出），鎖著一個不會再被排的任務沒有意義，所以 soft release
// 並留下理由，讓使用者在鎖定列表看得到「為什麼不見了」。
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
