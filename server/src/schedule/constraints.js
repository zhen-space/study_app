// C：structured constraint contract。這裡是唯一的 allowlist；不在清單內的條件
// 絕不偷偷丟進 scheduler，也不會假裝已生效。
const SUPPORTED = new Set(['subject_order', 'exclude_weekdays', 'exclude_dates', 'date_window', 'max_session_minutes', 'max_per_day']);
const KNOWN_UNSUPPORTED = new Set([
  'preferred_time_ranges', 'min_session_minutes',
  'deadline', 'spread', 'sequential_within_subject', 'one_per_day',
  'availability_override', 'strict_dependency',
]);
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
      if (key === 'max_session_minutes' && Number.isInteger(value) && value >= 30 && value <= 240) {
        supported[key] = value; accepted = true;
      }
      if (key === 'max_per_day' && Number.isInteger(value) && value >= 1 && value <= 20) {
        supported[key] = value; accepted = true;
      }
      if (!accepted) unsupported.push({ key, value, reason: '排程條件格式不正確' });
    } else {
      unsupported.push({ key, value, reason: KNOWN_UNSUPPORTED.has(key) ? '目前排程器尚未安全支援此條件' : '未知的排程條件' });
    }
  }
  return { supported, unsupported };
}
export const constraintContract = { supported: [...SUPPORTED], unsupported: [...KNOWN_UNSUPPORTED] };
