import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feasibilityGap } from '../src/schedule/feasibility-gap.js';

test('A1 feasibility gap：回傳缺口與兩種不解除 hard constraint 的救援方案', () => {
  const r = feasibilityGap({ timed: true,
    items: [{ minutes: 300 }], blocks: [{ start_time: '19:00', end_time: '20:00' }],
    days: [{ slots: [[1140, 1200]] }, { slots: [[1140, 1200]] }], failed: ['未排項目'], hardConstraints: ['schedule_locks'],
  });
  assert.equal(r.feasible, false);
  assert.equal(r.gap_minutes, 180);
  assert.deepEqual(r.recommendations, [{ type: 'extend_days', min_days: 3 }, { type: 'add_daily_time', minutes_per_day: 90 }]);
  assert.deepEqual(r.hard_constraints, ['schedule_locks']);
});
