// 學校作業的前端純函式。
//
// 這裡刻意只做兩件事：把 backend 已定案的 School Assignment contract 用在畫面上，
// 以及即時（現算）判斷逾期與 Today 分組——後端不會即時推播，這些必須在前端算。
//
// 硬性界線：
//   ・這裡**不重做** previous_friday／提醒日期的推算。哪一天提醒是 backend
//     resolver 的事（server/src/school/assignment.js），前端只負責讓使用者選
//     reminder_kind 等欄位、把它們原樣送回去。前端不得成為第二份 weekday 演算法。
//   ・逾期與分組直接對照 backend 的 isOverdue / groupSchoolAssignments 語意，
//     欄位比較用字串（YYYY-MM-DD、HH:MM 皆可字典序比較），不另存 overdue 欄位。
//   ・「現在」一律用台灣時間（Asia/Taipei）——與後端 todayTW、設定頁的排程時區
//     一致，不跟著裝置時區跑。

export const SCHOOL_ASSIGNMENT_TYPES = ['homework', 'report', 'exam', 'other'];
export const TYPE_LABEL = { homework: '作業', report: '報告', exam: '考試', other: '其他' };

export const REMINDER_DAYS_BEFORE = [1, 2, 3, 7];
export const DEFAULT_REMINDER_TIME = '18:00';

// 提醒方式的選項與顯示文字。日期的實際推算全在 backend；這裡只是選單。
export const REMINDER_OPTIONS = [
  { value: 'none', label: '不提醒' },
  { value: 'same_day', label: '當天' },
  { value: 'days_before:1', label: '前 1 天' },
  { value: 'days_before:2', label: '前 2 天' },
  { value: 'days_before:3', label: '前 3 天' },
  { value: 'days_before:7', label: '前 1 週' },
  { value: 'previous_friday', label: '前一個週五' },
  { value: 'custom', label: '自訂日期' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isDate = v => typeof v === 'string' && DATE_RE.test(v);
export const isTime = v => typeof v === 'string' && TIME_RE.test(v);

export const isSchoolAssignment = t => t?.task_kind === 'school_assignment';

// 台灣時間的 { date, time }。整個 App 的「今天」都是台灣時間，逾期判定必須一致，
// 不能用裝置本地時間，否則出國或改系統時區會讓逾期忽然對不上。
export function nowTW() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = k => parts.find(p => p.type === k)?.value || '';
  let hour = g('hour');
  if (hour === '24') hour = '00';   // 某些環境午夜會給 24
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${hour}:${g('minute')}` };
}

// 沒指定時間＝那一天結束以前（23:59）。只用於逾期比較，不拿來當顯示值。
export const EOD = '23:59';
export const effectiveDeadlineTime = task => (isTime(task?.deadline_time) ? task.deadline_time : EOD);

// 逾期一律現算，對照 backend isOverdue。completed / cancelled / deleted 不算逾期。
export function isOverdue(task, now = nowTW()) {
  if (!task || !isDate(task.deadline_date)) return false;
  if (task.completed || task.cancelled || task.deleted) return false;
  if (now.date > task.deadline_date) return true;
  if (now.date < task.deadline_date) return false;
  return now.time > effectiveDeadlineTime(task);
}

const addDaysStr = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Today 的三個分組，對照 backend groupSchoolAssignments。分組之間**可以重疊**：
// 今天中午要交、現在下午，那筆同時在「今天要交」與「已逾期」——刻意的，不去重。
export function groupSchoolAssignments(tasks, now = nowTW(), { upcomingDays = 7 } = {}) {
  const pending = (tasks || []).filter(t =>
    isSchoolAssignment(t) && !t.completed && !t.cancelled && !t.deleted && isDate(t.deadline_date));
  const horizon = addDaysStr(now.date, upcomingDays);
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

/* ---------- 顯示 ---------- */

// 考試講「考試時間」，其餘講「繳交期限」——語意都是「學校什麼時候要」，不是
// 「我打算什麼時候做」。
export const deadlineLabelText = task => (task?.school_assignment_type === 'exam' ? '考試時間' : '繳交期限');

const WDH = '日一二三四五六';
// 繳交期限的顯示：一律顯示日期；有指定時間才顯示時間。deadline_time 為 null 時
// **不顯示假的 23:59**，只顯示日期。
export function formatDeadline(task) {
  const d = task?.deadline_date;
  if (!isDate(d)) return '';
  const wd = WDH[new Date(d + 'T00:00:00').getDay()];
  const base = `${+d.slice(5, 7)}/${+d.slice(8)}（週${wd}）`;
  return isTime(task.deadline_time) ? `${base} ${task.deadline_time}` : base;
}

// 把使用者在提醒選單選的值拆回 backend 欄位。custom 需要另外帶日期。
export function reminderSelectionToFields(value, { customDate = null, timeOverride = null } = {}) {
  const clean = t => (isTime(t) ? t : null);
  if (!value || value === 'none') return { reminder_kind: 'none', reminder_days_before: null, reminder_custom_date: null, reminder_time_override: null };
  if (value === 'same_day') return { reminder_kind: 'same_day', reminder_days_before: null, reminder_custom_date: null, reminder_time_override: clean(timeOverride) };
  if (value === 'previous_friday') return { reminder_kind: 'previous_friday', reminder_days_before: null, reminder_custom_date: null, reminder_time_override: clean(timeOverride) };
  if (value === 'custom') return { reminder_kind: 'custom', reminder_days_before: null, reminder_custom_date: isDate(customDate) ? customDate : null, reminder_time_override: clean(timeOverride) };
  if (value.startsWith('days_before:')) {
    const n = Number(value.split(':')[1]);
    return { reminder_kind: 'days_before', reminder_days_before: REMINDER_DAYS_BEFORE.includes(n) ? n : null, reminder_custom_date: null, reminder_time_override: clean(timeOverride) };
  }
  return { reminder_kind: 'none', reminder_days_before: null, reminder_custom_date: null, reminder_time_override: null };
}

// 從 task 欄位反推提醒選單目前該選哪一個 option value（編輯時回填）。
export function reminderFieldsToSelection(task) {
  const k = task?.reminder_kind;
  if (!k || k === 'none') return 'none';
  if (k === 'days_before') return `days_before:${Number(task.reminder_days_before)}`;
  if (k === 'same_day' || k === 'previous_friday' || k === 'custom') return k;
  return 'none';
}
