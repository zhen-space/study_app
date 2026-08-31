// deadline_time 的排程截止規則。
//
// 這是 **generic Task 行為**，不是學校作業專屬的第二套排程器——任何 Task
// 只要填了 deadline_time，同一天的 timed block 就必須在那之前結束。
// 這裡直接匯入正式的 classifyPlacement，不重寫一份判定邏輯：
// 自己寫一份的話，就算排程器完全忽略 deadline_time，測試照樣會綠。
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlacement } from '../src/schedule/feasibility.js';

const ctx = { events: [], planningDay: '2026-09-01', nowHM: '08:00', dayOfWeek: 4 };
const task = (o = {}) => ({
  id: 1, plan_id: 7, plan_status: 'active',
  deleted: 0, completed: 0, cancelled: 0,
  deadline_date: '2026-09-10', deadline_time: null, ...o,
});
const block = (o = {}) => ({ date: '2026-09-05', start_time: '09:00', end_time: '10:00', ...o });

test('期限之前的日期一律允許', () => {
  assert.equal(classifyPlacement(block({ date: '2026-09-05' }), { ...ctx, task: task() }), null);
  assert.equal(classifyPlacement(block({ date: '2026-09-09', end_time: '23:00' }),
    { ...ctx, task: task({ deadline_time: '09:00' }) }), null,
  '期限前一天不受 deadline_time 限制');
});

test('期限之後的日期一律拒絕', () => {
  const out = classifyPlacement(block({ date: '2026-09-11' }), { ...ctx, task: task() });
  assert.equal(out.kind, 'conflict');
  assert.equal(out.type, 'deadline');
});

test('deadline_time 為 NULL：期限當天整天都可以排（維持原本行為）', () => {
  for (const end of ['09:00', '18:00', '23:59']) {
    assert.equal(
      classifyPlacement(block({ date: '2026-09-10', end_time: end }), { ...ctx, task: task() }),
      null, end);
  }
});

test('期限當天：block 必須在 deadline_time 以前結束', () => {
  const t = task({ deadline_time: '12:00' });
  // 早於或剛好等於期限 → 允許
  for (const end of ['10:00', '11:59', '12:00']) {
    assert.equal(classifyPlacement(block({ date: '2026-09-10', start_time: '09:00', end_time: end }),
      { ...ctx, task: t }), null, end);
  }
  // 超過 → 衝突，而且回報 deadline_time 讓呼叫端說得出原因
  const out = classifyPlacement(block({ date: '2026-09-10', start_time: '11:00', end_time: '12:01' }),
    { ...ctx, task: t });
  assert.equal(out.kind, 'conflict');
  assert.equal(out.type, 'deadline');
  assert.equal(out.deadline_time, '12:00');
});

test('date-only 的 block 不受 deadline_time 影響', () => {
  // 沒有 end_time 就沒有「幾點結束」可比，不能因此拒絕
  assert.equal(classifyPlacement({ date: '2026-09-10', start_time: null, end_time: null },
    { ...ctx, task: task({ deadline_time: '09:00' }) }), null);
});

test('沒有 deadline_date 時，deadline_time 不會單獨生效', () => {
  assert.equal(classifyPlacement(block({ date: '2026-12-31', end_time: '23:00' }),
    { ...ctx, task: task({ deadline_date: null, deadline_time: '01:00' }) }), null);
});

test('既有的其他判定不受影響（regression）', () => {
  assert.equal(classifyPlacement(block(), { ...ctx, task: task({ deleted: 1 }) }).type, 'deleted');
  assert.equal(classifyPlacement(block(), { ...ctx, task: task({ completed: 1 }) }).type, 'completed');
  assert.equal(classifyPlacement(block(), { ...ctx, task: task({ cancelled: 1 }) }).type, 'cancelled');
  // plan_id 為 NULL 的 Task 不進排程——學校作業預設就是這個狀態
  assert.equal(classifyPlacement(block(), { ...ctx, task: task({ plan_id: null }) }).type, 'task_constraint');
  // 過去的時段
  assert.equal(classifyPlacement(block({ date: '2026-08-31' }), { ...ctx, task: task() }).type, 'past');
});
