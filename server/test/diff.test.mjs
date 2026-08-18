import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateScheduleDiff } from '../src/schedule/diff.js';

const b = (task_id, date, start_time = null, end_time = null, planned_minutes = null, title = `任務${task_id}`) =>
  ({ task_id, date, start_time, end_time, planned_minutes, task_title_snapshot: title, subject_name_snapshot: '數學' });

test('P5 diff：task_id 與 canonical block set 正確分類四種變更', () => {
  const before = [
    b(1, '2099-01-01', '19:00', '20:00', 60), // unchanged
    b(2, '2099-01-01', '19:00', '20:00', 60), // moved
    b(3, '2099-01-01'),                         // removed
    b(5, '2099-01-01'), b(5, '2099-01-02'),     // multi-block moved (partial disappearance)
  ];
  const after = [
    b(1, '2099-01-01', '19:00', '20:00', 60),
    b(2, '2099-01-02', '20:00', '21:30', 90),
    b(4, '2099-01-03'),
    b(5, '2099-01-01'),
  ];
  const diff = calculateScheduleDiff(before, after, { comparisonFrom: '2099-01-01', baseVersionId: 10, candidateVersionId: 11 });
  assert.deepEqual(diff.summary, { unchanged: 1, moved: 2, added: 1, removed: 1, changed: 0 });
  // 排序鍵是 canonical first placement；同日 date-only（NULL time）排在計時安排前。
  assert.deepEqual(diff.items.map(x => [x.task_id, x.type]), [[3, 'removed'], [5, 'moved'], [1, 'unchanged'], [2, 'moved'], [4, 'added']]);
  assert.deepEqual(diff.items.find(x => x.task_id === 2).change_flags, { date_changed: true, time_changed: true, duration_changed: true });
  assert.equal(diff.items.find(x => x.task_id === 5).type, 'moved', '部分 block 消失不可拆成 removed + added');
});

test('P5 diff：effective_from 排除 base 的歷史，且 include_unchanged 可減少回傳', () => {
  const before = [b(1, '2099-01-01'), b(2, '2099-01-03')];
  const after = [b(2, '2099-01-03')];
  const diff = calculateScheduleDiff(before, after, { comparisonFrom: '2099-01-03', includeUnchanged: false });
  assert.deepEqual(diff.summary, { unchanged: 1, moved: 0, added: 0, removed: 0, changed: 0 });
  assert.deepEqual(diff.items, [], '歷史 block 不得被誤判為 removed，unchanged 可不傳');
});

test('P5 diff：初始版本只回建立摘要，不展開每個 block', () => {
  const diff = calculateScheduleDiff([], [b(1, '2099-01-01'), b(2, '2099-01-01')], {
    comparisonFrom: '2099-01-01', candidateVersionId: 1, isInitial: true,
  });
  assert.equal(diff.is_initial, true);
  assert.equal(diff.base_version_id, null);
  assert.equal(diff.summary.added, 2);
  assert.deepEqual(diff.items, []);
});
