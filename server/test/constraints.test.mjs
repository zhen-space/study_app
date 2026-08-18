import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConstraints } from '../src/schedule/constraints.js';

test('C constraint contract：只讓已支援欄位進 scheduler，未支援不可 silently ignore', () => {
  const r = normalizeConstraints({
    subject_order: [2, 1], exclude_weekdays: [1, 3, 9], exclude_dates: ['2026-08-20', 'bad'],
    min_session_minutes: 90, strict_dependency: [{ before: 'A', after: 'B' }],
  });
  assert.deepEqual(r.supported, { subject_order: [2, 1], exclude_weekdays: [1, 3], exclude_dates: ['2026-08-20'] });
  assert.deepEqual(r.unsupported.map(x => x.key), ['min_session_minutes', 'strict_dependency']);
});
