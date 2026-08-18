// A2：Plan health 的純分類。原因由後端組裝，前端只 render。
export function classifyScheduleHealth({ pending = 0, overdue = 0, unplaced = 0, lateTarget = 0, locked = 0, collision = false } = {}) {
  const reasons = [];
  if (overdue) reasons.push({ type: 'overdue', count: overdue, message: `有 ${overdue} 項已逾期` });
  if (unplaced) reasons.push({ type: 'unplaced', count: unplaced, message: `有 ${unplaced} 項尚未安排` });
  if (lateTarget) reasons.push({ type: 'past_target', count: lateTarget, message: `有 ${lateTarget} 項排在目標日之後` });
  if (locked) reasons.push({ type: 'active_locks', count: locked, message: `目前有 ${locked} 個有效鎖定會限制重排` });
  if (collision) reasons.push({ type: 'schedule_collision', count: 1, message: '目前排程有時段衝突' });
  const status = collision ? 'blocked' : (overdue || unplaced || lateTarget) ? 'needs_replan' : locked ? 'warning' : 'healthy';
  return { status, pending, reasons };
}
