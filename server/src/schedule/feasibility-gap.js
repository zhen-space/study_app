// A1：排不下時的 deterministic gap 說明。純計算、不寫資料、不讓 AI 猜。
export function feasibilityGap({ timed, items, blocks, days, failed, hardConstraints = [] }) {
  if (!timed) return {
    feasible: failed.length === 0, gap_minutes: null, gap_hours: null,
    reason: failed.length ? 'date_capacity_or_rule' : null,
    hard_constraints: hardConstraints,
    recommendations: [],
  };
  const requested = items.reduce((n, x) => n + Math.max(0, Number(x.minutes) || 0), 0);
  const capacity = days.reduce((n, day) => n + day.slots.reduce((m, [a, b]) => m + b - a, 0), 0);
  const minutesOf = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const scheduled = blocks.reduce((n, b) => n + (b.start_time && b.end_time
    ? Math.max(0, minutesOf(b.end_time) - minutesOf(b.start_time)) : 0), 0);
  const gap = Math.max(0, requested - capacity);
  const remainingDays = Math.max(1, days.length);
  const dailyCapacity = Math.max(1, Math.floor(capacity / remainingDays));
  const recommendations = [];
  if (gap > 0) {
    recommendations.push({ type: 'extend_days', min_days: Math.ceil(gap / dailyCapacity) });
    recommendations.push({ type: 'add_daily_time', minutes_per_day: Math.ceil(gap / remainingDays) });
  }
  return {
    feasible: failed.length === 0,
    requested_minutes: requested, scheduled_minutes: scheduled, capacity_minutes: capacity,
    gap_minutes: gap, gap_hours: Math.ceil(gap / 60 * 10) / 10,
    reason: failed.length ? (gap > 0 ? 'insufficient_time' : 'date_capacity_or_rule') : null,
    hard_constraints: hardConstraints,
    recommendations,
  };
}
