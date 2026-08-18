// C：structured constraint contract。這裡是唯一的 allowlist；不在清單內的條件
// 絕不偷偷丟進 scheduler，也不會假裝已生效。
const SUPPORTED = new Set(['subject_order', 'exclude_weekdays', 'exclude_dates']);
const KNOWN_UNSUPPORTED = new Set([
  'preferred_time_ranges', 'min_session_minutes', 'max_session_minutes', 'max_per_day',
  'deadline', 'date_window', 'spread', 'sequential_within_subject', 'one_per_day',
  'availability_override', 'strict_dependency',
]);
export function normalizeConstraints(input = {}) {
  const supported = {}, unsupported = [];
  for (const [key, value] of Object.entries(input || {})) {
    if (SUPPORTED.has(key)) {
      if (key === 'subject_order' && Array.isArray(value)) supported[key] = value;
      if (key === 'exclude_weekdays' && Array.isArray(value)) supported[key] = value.filter(x => Number.isInteger(x) && x >= 0 && x <= 6);
      if (key === 'exclude_dates' && Array.isArray(value)) supported[key] = value.filter(x => /^\d{4}-\d\d-\d\d$/.test(x));
    } else {
      unsupported.push({ key, value, reason: KNOWN_UNSUPPORTED.has(key) ? '目前排程器尚未安全支援此條件' : '未知的排程條件' });
    }
  }
  return { supported, unsupported };
}
export const constraintContract = { supported: [...SUPPORTED], unsupported: [...KNOWN_UNSUPPORTED] };
