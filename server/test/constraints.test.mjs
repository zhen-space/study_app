import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConstraints } from '../src/schedule/constraints.js';

test('C constraint contract：只讓已支援欄位進 scheduler，未支援不可 silently ignore', () => {
  const r = normalizeConstraints({
    subject_order: [2, 1], exclude_weekdays: [1, 3, 9], exclude_dates: ['2026-08-20', 'bad'],
    min_session_minutes: 90, strict_dependency: [{ before: 'A', after: 'B' }],
  });
  assert.deepEqual(r.supported, { subject_order: [2, 1], exclude_weekdays: [1, 3], exclude_dates: ['2026-08-20'], min_session_minutes: 90 });
  assert.deepEqual(r.unsupported.map(x => x.key), ['strict_dependency']);
});

test('C constraint contract：所有已支援條件都會正規化，互斥的 session 長度不可假裝生效', () => {
  const r = normalizeConstraints({
    deadline: '2099-01-20', preferred_time_ranges: [{ start_time: '19:00', end_time: '21:00' }],
    min_session_minutes: 120, max_session_minutes: 90, max_per_day: 2,
    spread: false, sequential_within_subject: true, one_per_day: true,
    availability_override: [{ date: '2099-01-12', start_time: '18:00', end_time: '20:00' }],
  });
  assert.equal(r.supported.deadline, '2099-01-20');
  assert.deepEqual(r.supported.preferred_time_ranges, [{ start_time: '19:00', end_time: '21:00' }]);
  assert.equal(r.supported.max_session_minutes, 90);
  assert.equal(r.supported.one_per_day, true);
  assert.equal(r.supported.min_session_minutes, undefined);
  assert.equal(r.unsupported.some(x => x.key === 'min_session_minutes'), true);
});
