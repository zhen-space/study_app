// C：structured constraint contract。這裡是唯一的 allowlist；不在清單內的條件
// 絕不偷偷丟進 scheduler，也不會假裝已生效。
const SUPPORTED = new Set([
  'subject_order', 'exclude_weekdays', 'exclude_dates', 'date_window', 'deadline',
  'preferred_time_ranges', 'min_session_minutes', 'max_session_minutes', 'max_per_day',
  'spread', 'sequential_within_subject', 'one_per_day', 'availability_override',
]);
const KNOWN_UNSUPPORTED = new Set([
  'strict_dependency',
]);
const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const range = value => value && typeof value === 'object' && time(value.start_time) && time(value.end_time)
  && value.start_time < value.end_time;
export function normalizeConstraints(input = {}) {
  const supported = {}, unsupported = [];
  for (const [key, value] of Object.entries(input || {})) {
    if (SUPPORTED.has(key)) {
      let accepted = false;
      if (key === 'subject_order' && Array.isArray(value)) { supported[key] = value; accepted = true; }
      if (key === 'exclude_weekdays' && Array.isArray(value)) { supported[key] = value.filter(x => Number.isInteger(x) && x >= 0 && x <= 6); accepted = true; }
      if (key === 'exclude_dates' && Array.isArray(value)) { supported[key] = value.filter(x => /^\d{4}-\d\d-\d\d$/.test(x)); accepted = true; }
      if (key === 'date_window' && value && typeof value === 'object'
        && /^\d{4}-\d\d-\d\d$/.test(value.start_date || '') && /^\d{4}-\d\d-\d\d$/.test(value.end_date || '')
        && value.start_date <= value.end_date) {
        supported[key] = { start_date: value.start_date, end_date: value.end_date }; accepted = true;
      }
      if (key === 'deadline' && /^\d{4}-\d\d-\d\d$/.test(value || '')) { supported[key] = value; accepted = true; }
      if (key === 'preferred_time_ranges' && Array.isArray(value) && value.length > 0
        && value.every(range)) { supported[key] = value.map(x => ({ start_time:x.start_time, end_time:x.end_time })); accepted = true; }
      if (key === 'min_session_minutes' && Number.isInteger(value) && value >= 30 && value <= 240) {
        supported[key] = value; accepted = true;
      }
      if (key === 'max_session_minutes' && Number.isInteger(value) && value >= 30 && value <= 240) {
        supported[key] = value; accepted = true;
      }
      if (key === 'max_per_day' && Number.isInteger(value) && value >= 1 && value <= 20) {
        supported[key] = value; accepted = true;
      }
      if (['spread', 'sequential_within_subject', 'one_per_day'].includes(key) && typeof value === 'boolean') {
        supported[key] = value; accepted = true;
      }
      // availability_override 是本次 Plan 排程用的一次性白名單，必須指明日期；
      // 不取代可重用的 Routine domain，也不會偷偷寫入使用者作息。
      if (key === 'availability_override' && Array.isArray(value) && value.length > 0 && value.every(x =>
        x && /^\d{4}-\d\d-\d\d$/.test(x.date || '') && range(x))) {
        supported[key] = value.map(x => ({ date:x.date, start_time:x.start_time, end_time:x.end_time })); accepted = true;
      }
      if (!accepted) unsupported.push({ key, value, reason: '排程條件格式不正確' });
    } else {
      unsupported.push({ key, value, reason: KNOWN_UNSUPPORTED.has(key) ? '目前排程器尚未安全支援此條件' : '未知的排程條件' });
    }
  }
  if (supported.min_session_minutes && supported.max_session_minutes
    && supported.min_session_minutes > supported.max_session_minutes) {
    unsupported.push({ key: 'min_session_minutes', value: supported.min_session_minutes, reason: '最短單次時間不可大於最長單次時間' });
    delete supported.min_session_minutes;
  }
  return { supported, unsupported };
}
export const constraintContract = { supported: [...SUPPORTED], unsupported: [...KNOWN_UNSUPPORTED] };
