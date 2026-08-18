// 2C-P4：純 Lock feasibility。這個檔案不查 DB，讓 restore / replan / manual 共用。
import { canonicalizeBlockTiming } from './timing.js';
const live = (task, tasks) => { const t = tasks instanceof Map ? tasks.get(Number(task)) : tasks.find(x => Number(x.id) === Number(task)); return t && !t.deleted && !t.completed; };
const nowParts = now => ({ day: now.day, time: now.time });
export function effectiveLocks(locks, tasks, now) {
  const { day, time } = nowParts(now);
  return locks.filter(l => {
    if (l.released_at) return false;
    if (l.type === 'task') return !!live(l.task_id, tasks);
    if (l.type === 'day') return l.date >= day;
    return l.date > day || (l.date === day && l.end_time > time);
  });
}
export function blockSignature(taskId, blocks, tasks = null) {
  return blocks.filter(b => Number(b.task_id) === Number(taskId) && (!tasks || live(b.task_id, tasks)))
    .map(canonicalizeBlockTiming)
    .map(b => [b.date, b.start_time || null, b.end_time || null, b.planned_minutes ?? null])
    .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// 比較的是「這段時間裡排了什麼」，不是資料列長什麼樣子。
// 一定要先投影成 placement 再排序：呼叫端傳進來的 row 可能多帶 id 之類的欄位，
// 順序也可能不同，直接 JSON 比整列會把「其實沒變」誤判成違反鎖定。
const placement = raw => {
  const b = canonicalizeBlockTiming(raw);
  return [b.date, b.start_time || null, b.end_time || null, b.planned_minutes ?? null, Number(b.task_id)];
};
const slice = (blocks, lock, tasks) => blocks.filter(b => live(b.task_id, tasks) && (lock.type === 'day'
  ? b.date === lock.date
  : b.date === lock.date && b.start_time && b.end_time && b.start_time < lock.end_time && lock.start_time < b.end_time))
  .map(placement).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function checkLocks(candidate, active, locks, tasks, now) {
  const out = [];
  for (const l of effectiveLocks(locks, tasks, now)) {
    if (l.type === 'task') {
      const before = blockSignature(l.task_id, active, tasks), after = blockSignature(l.task_id, candidate, tasks);
      if (!after.length) out.push({ type: 'LOCKED_TASK_UNPLACED', severity: 'hard', lock_id: l.id, task_id: l.task_id });
      else if (!same(before, after)) out.push({ type: 'LOCKED_TASK_MOVED', severity: 'hard', lock_id: l.id, task_id: l.task_id });
    } else if (!same(slice(active,l,tasks), slice(candidate,l,tasks))) out.push({ type: l.type === 'day' ? 'LOCKED_DAY_CHANGED' : 'LOCKED_SLICE_CHANGED', severity: 'hard', lock_id: l.id });
  }
  return out;
}
