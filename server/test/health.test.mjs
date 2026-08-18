import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScheduleHealth } from '../src/schedule/health.js';
test('A2 health 以 normalized status 與 reasons 回報正式排程風險', () => {
  const r = classifyScheduleHealth({ pending: 3, overdue: 1, unplaced: 2, locked: 1 });
  assert.equal(r.status, 'needs_replan');
  assert.deepEqual(r.reasons.map(x => x.type), ['overdue', 'unplaced', 'active_locks']);
  assert.equal(classifyScheduleHealth({ collision: true }).status, 'blocked');
});
