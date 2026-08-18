// A2：Plan health 的純分類。原因由後端組裝，前端只 render。
export function classifyScheduleHealth({ pending = 0, overdue = 0, unplaced = 0, lateTarget = 0, locked = 0, collision = false, deadlineViolation = 0, capacityGap = 0 } = {}) {
  const reasons = [];
  if (overdue) reasons.push({ type: 'overdue', count: overdue, message: `有 ${overdue} 項已逾期` });
  if (unplaced) reasons.push({ type: 'unplaced', count: unplaced, message: `有 ${unplaced} 項尚未安排` });
  if (lateTarget) reasons.push({ type: 'past_target', count: lateTarget, message: `有 ${lateTarget} 項排在目標日之後` });
  if (deadlineViolation) reasons.push({ type: 'deadline_violation', count: deadlineViolation, message: `有 ${deadlineViolation} 項超過任務截止日` });
  if (capacityGap > 0) reasons.push({ type: 'capacity_gap', minutes: capacityGap, message: `目前安排還缺 ${Math.ceil(capacityGap / 60 * 10) / 10} 小時` });
  if (locked) reasons.push({ type: 'active_locks', count: locked, message: `目前有 ${locked} 個有效鎖定會限制重排` });
  if (collision) reasons.push({ type: 'schedule_collision', count: 1, message: '目前排程有時段衝突' });
  const status = collision ? 'blocked' : (overdue || unplaced || lateTarget || deadlineViolation || capacityGap > 0) ? 'needs_replan' : locked ? 'warning' : 'healthy';
  return { status, pending, capacity_gap_minutes: capacityGap, reasons };
}
