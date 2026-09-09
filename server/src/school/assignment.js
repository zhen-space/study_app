// 學校作業。
//
// 這裡最重要的一句話：**School Assignment 不是第二套 lifecycle。**
// 它就是 Task 的一種 kind，completed / cancelled / deleted / reopen 全部沿用
// 既有的 Task lifecycle 與既有的 Task API。沒有 school_assignments 表，
// 沒有專屬的完成／取消端點，也沒有 stored overdue 欄位——逾期一律現算。
//
// 另外兩件容易寫錯的事：
//   ・task_kind 與 Material linkage 是**正交**的兩件事。是不是綁教材看
//     material_content_item_id，不看 task_kind。四種組合都合法，所以
//     task_kind 絕不可以做成 manual / material / school_assignment 三選一。
//   ・繳交期限存 deadline_date / deadline_time，**不是** due_date / due_time。
//     後者是排程結果的鏡射（ScheduledBlock mirror），由排程器決定；
//     把學校的期限寫進去會讓「我打算什麼時候做」跟「學校什麼時候要」變成同一個
//     欄位，兩邊都會壞。
//
// 這個檔案不碰資料庫，全部是純函式。

import { addDays, dayOfWeek } from '../util/date.js';

export const TASK_KINDS = ['standard', 'school_assignment'];
export const DEFAULT_TASK_KIND = 'standard';

export const SCHOOL_ASSIGNMENT_TYPES = ['homework', 'report', 'exam', 'other'];

export const REMINDER_KINDS = ['none', 'same_day', 'days_before', 'previous_friday', 'custom'];
// 只開放這四個間隔。開放任意數字等於多一個要驗的自由度，而產品上沒有人需要
// 「提前 5 天」——真的要指定日子有 custom。
export const REMINDER_DAYS_BEFORE = [1, 2, 3, 7];

// 使用者沒設定時的提醒時間。晚上六點：放學後、還來得及動手。
export const DEFAULT_REMINDER_TIME = '18:00';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isDate = v => typeof v === 'string' && DATE_RE.test(v);
export const isTime = v => typeof v === 'string' && TIME_RE.test(v);

/* ---------- previous Friday ---------- */

// deadline_date 之前**最近的一個星期五**，而且必須嚴格早於 deadline_date。
//
// 星期五交的作業，提醒要落在「上一週的星期五」，不是當天早上——
// 當天才提醒就失去提前準備的意義，這條是產品定義，不是曆法四捨五入。
export function previousFriday(deadlineDate) {
  if (!isDate(deadlineDate)) return null;
  const FRIDAY = 5;
  const back = (dayOfWeek(deadlineDate) - FRIDAY + 7) % 7;
  return addDays(deadlineDate, -(back === 0 ? 7 : back));
}

/* ---------- generic Task Reminder Resolver ---------- */

// 算出「哪一天、幾點」要提醒。刻意做成 generic Task 行為而不是 School Assignment
// 專用：任何有 deadline_date 的 Task 都能用同一組欄位。
//
// 日期與時間完全分離——kind 只決定日期，時間一律走
// reminder_time_override ?? 使用者預設。這樣「提前三天」跟「幾點提醒」
// 可以各自調整，不會互相牽動。
//
// 回傳 { kind, date, time }，不需要提醒時回 null。
export function resolveReminder(task, { defaultTime = DEFAULT_REMINDER_TIME } = {}) {
  const kind = task?.reminder_kind;
  if (!kind || kind === 'none' || !REMINDER_KINDS.includes(kind)) return null;

  const deadline = task?.deadline_date;
  let date = null;
  if (kind === 'same_day') date = isDate(deadline) ? deadline : null;
  else if (kind === 'days_before') {
    const n = Number(task?.reminder_days_before);
    date = isDate(deadline) && REMINDER_DAYS_BEFORE.includes(n) ? addDays(deadline, -n) : null;
  } else if (kind === 'previous_friday') date = previousFriday(deadline);
  else if (kind === 'custom') date = isDate(task?.reminder_custom_date) ? task.reminder_custom_date : null;

  if (!date) return null;
  const override = task?.reminder_time_override;
  const time = isTime(override) ? override : (isTime(defaultTime) ? defaultTime : DEFAULT_REMINDER_TIME);
  return { kind, date, time };
}

/* ---------- deadline ---------- */

// 沒有指定時間就是「那一天結束以前」。這是整個逾期判定的關鍵：
// 只填日期的作業，在當天 23:59 之前都不算遲交。
export const EOD = '23:59';
export const effectiveDeadlineTime = task => (isTime(task?.deadline_time) ? task.deadline_time : EOD);

// 逾期一律現算，不存欄位。存下來就會有「資料庫說沒逾期、畫面說逾期」的第二個真相。
// now 用台灣時間的 { date, time }（整個 App 的「今天」都是台灣時間）。
export function isOverdue(task, now) {
  if (!task || !isDate(task.deadline_date)) return false;
  if (task.completed || task.cancelled || task.deleted) return false;
  if (now.date > task.deadline_date) return true;
  if (now.date < task.deadline_date) return false;
  return now.time > effectiveDeadlineTime(task);
}

/* ---------- 驗證 ---------- */

export const isSchoolAssignment = task => task?.task_kind === 'school_assignment';

// School Assignment 的欄位檢查。只看形狀，不看資料庫；
// 清單擁有權與存在性由 route 查（那需要 DB）。
// 回傳錯誤訊息字串，沒問題回 null。
export function validateSchoolAssignment(input) {
  const v = input || {};
  if (!String(v.title || '').trim()) return '請輸入作業名稱';
  if (v.list_id == null || v.list_id === '') return '請選擇科目';
  if (!SCHOOL_ASSIGNMENT_TYPES.includes(v.school_assignment_type)) return '作業類型不正確';
  if (!isDate(v.deadline_date)) return '請填寫繳交日期';
  if (v.deadline_time != null && v.deadline_time !== '' && !isTime(v.deadline_time)) return '繳交時間格式不正確';
  // v1 不支援重複的學校作業。每次作業是不同的一份東西，用重複規則複製出來的
  // 那些列會共用同一個期限語意，之後要各自改期限就沒有辦法。
  if (v.recurring) return '學校作業目前不支援重複';
  return validateReminder(v);
}

// 提醒欄位的檢查。generic：一般 Task 也能用同一組欄位。
export function validateReminder(input) {
  const v = input || {};
  const kind = v.reminder_kind;
  if (kind == null || kind === '') return null;
  if (!REMINDER_KINDS.includes(kind)) return '提醒方式不正確';
  if (kind === 'days_before' && !REMINDER_DAYS_BEFORE.includes(Number(v.reminder_days_before))) {
    return '提前提醒只能選 1、2、3 或 7 天';
  }
  if (kind === 'custom' && !isDate(v.reminder_custom_date)) return '請選擇自訂提醒日期';
  if (v.reminder_time_override != null && v.reminder_time_override !== ''
    && !isTime(v.reminder_time_override)) return '提醒時間格式不正確';
  // same_day / previous_friday / none 都只靠 deadline_date，沒有額外欄位要驗
  return null;
}

/* ---------- Today 的分組 ---------- */

// Today 不另外存狀態，三個分組全部從 Task 現算。
//
// 分組之間**可以重疊**：今天中午 12:00 要交、現在下午兩點，那筆同時是
// 「今天要交」也是「已逾期」。這是刻意的——把它從「今天要交」拿掉，
// 使用者就看不到今天原本該交的東西了。
export function groupSchoolAssignments(tasks, now, { upcomingDays = 7 } = {}) {
  const pending = (tasks || []).filter(t =>
    isSchoolAssignment(t) && !t.completed && !t.cancelled && !t.deleted && isDate(t.deadline_date));
  const horizon = addDays(now.date, upcomingDays);
  const byDeadline = (a, b) =>
    a.deadline_date.localeCompare(b.deadline_date)
    || effectiveDeadlineTime(a).localeCompare(effectiveDeadlineTime(b))
    || a.id - b.id;
  return {
    due_today: pending.filter(t => t.deadline_date === now.date).sort(byDeadline),
    upcoming: pending.filter(t => t.deadline_date > now.date && t.deadline_date <= horizon).sort(byDeadline),
    overdue: pending.filter(t => isOverdue(t, now)).sort(byDeadline),
  };
}

/* ---------- 統計 ---------- */

// 只做 derived query，不建第二套 stats persistence。
export function assignmentStats(tasks, now) {
  const all = (tasks || []).filter(t => isSchoolAssignment(t) && !t.deleted);
  const by_type = Object.fromEntries(SCHOOL_ASSIGNMENT_TYPES.map(k => [k, 0]));
  for (const t of all) {
    if (SCHOOL_ASSIGNMENT_TYPES.includes(t.school_assignment_type)) by_type[t.school_assignment_type] += 1;
  }
  return {
    total: all.length,
    completed: all.filter(t => t.completed).length,
    cancelled: all.filter(t => t.cancelled).length,
    overdue: all.filter(t => isOverdue(t, now)).length,
    by_type,
  };
}
