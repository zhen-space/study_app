// ScheduledBlock 的時間只有兩種 canonical shape：
//   timed     = start_time + end_time + 由 window 導出的 planned_minutes
//   date-only = 三者皆為 null
//
// 這是純函式，讓 write gate、stored-row repair 與 Lock baseline 共用；不能讓
// candidate 與資料庫舊 row 用不同 representation 比較而製造假衝突。
const HM = /^\d\d:\d\d$/;
const minutes = hm => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const validHm = hm => HM.test(hm) && minutes(hm) >= 0 && minutes(hm) < 24 * 60
  && Number(hm.slice(3, 5)) < 60;

export const timingProblem = block => {
  const start = block.start_time || null;
  const end = block.end_time || null;
  if (start == null && end == null) return null;
  if (start == null || end == null) return 'incomplete';
  if (!validHm(start) || !validHm(end) || start >= end) return 'invalid_window';
  return null;
};

// invalid='demote' 是讀取歷史 row 的保守相容策略：沒有可信 duration 就絕不捏造
// timed block。invalid='reject' 供所有新 write 使用，讓 caller 能回 400。
export function canonicalizeBlockTiming(block, { invalid = 'demote' } = {}) {
  const start = block.start_time || null;
  const end = block.end_time || null;
  const problem = timingProblem({ start_time: start, end_time: end });
  if (problem) {
    if (invalid === 'reject') return null;
    return { ...block, start_time: null, end_time: null, planned_minutes: null };
  }
  if (start == null) return { ...block, start_time: null, end_time: null, planned_minutes: null };
  return { ...block, start_time: start, end_time: end, planned_minutes: minutes(end) - minutes(start) };
}

export const canonicalTimingMinutes = minutes;
