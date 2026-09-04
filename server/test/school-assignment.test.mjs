// 學校作業的判定邏輯（純函式，不開伺服器）。
//
// 負向行為是重點：不得出現第二套 lifecycle、不得把期限寫進 due_date、
// 逾期一律現算、previous_friday 不得落在同一天。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_KINDS, SCHOOL_ASSIGNMENT_TYPES, REMINDER_KINDS, REMINDER_DAYS_BEFORE, DEFAULT_REMINDER_TIME,
  previousFriday, resolveReminder, isOverdue, effectiveDeadlineTime,
  validateSchoolAssignment, validateReminder, groupSchoolAssignments, assignmentStats,
} from '../src/school/assignment.js';

const sa = (o = {}) => ({
  id: 1, task_kind: 'school_assignment', title: '作業', list_id: 3,
  school_assignment_type: 'homework', deadline_date: '2026-09-10', deadline_time: null,
  completed: 0, cancelled: 0, deleted: 0, ...o,
});
const now = (date, time) => ({ date, time });

/* ---------- enum ---------- */

test('task_kind 只有兩種，而且不含 material', () => {
  assert.deepEqual(TASK_KINDS, ['standard', 'school_assignment']);
  // 教材身分是 material_content_item_id 的事，不可以擠進 task_kind
  assert.equal(TASK_KINDS.includes('material'), false);
  assert.equal(TASK_KINDS.includes('manual'), false);
});

test('作業類型只有四種', () => {
  assert.deepEqual(SCHOOL_ASSIGNMENT_TYPES, ['homework', 'report', 'exam', 'other']);
});

test('提醒方式只有五種，提前天數只有 1/2/3/7', () => {
  assert.deepEqual(REMINDER_KINDS, ['none', 'same_day', 'days_before', 'previous_friday', 'custom']);
  assert.deepEqual(REMINDER_DAYS_BEFORE, [1, 2, 3, 7]);
});

/* ---------- previous Friday ---------- */

test('previous_friday：星期五交，提醒落在上一週的星期五', () => {
  // 2026-09-11 是星期五
  assert.equal(previousFriday('2026-09-11'), '2026-09-04');
});

test('previous_friday：各個星期都落在嚴格早於期限的最近星期五', () => {
  const cases = {
    '2026-09-12': '2026-09-11', // 六
    '2026-09-13': '2026-09-11', // 日
    '2026-09-14': '2026-09-11', // 一
    '2026-09-15': '2026-09-11', // 二
    '2026-09-16': '2026-09-11', // 三
    '2026-09-17': '2026-09-11', // 四
    '2026-09-18': '2026-09-11', // 五 → 上一週
  };
  for (const [deadline, expected] of Object.entries(cases)) {
    const got = previousFriday(deadline);
    assert.equal(got, expected, `${deadline} → ${got}`);
    assert.ok(got < deadline, `${deadline} 的提醒必須嚴格早於期限`);
  }
});

/* ---------- reminder resolver ---------- */

test('none 與未設定都不產生提醒', () => {
  assert.equal(resolveReminder(sa({ reminder_kind: 'none' })), null);
  assert.equal(resolveReminder(sa()), null);
});

test('same_day / days_before / custom 的日期', () => {
  assert.equal(resolveReminder(sa({ reminder_kind: 'same_day' })).date, '2026-09-10');
  for (const n of REMINDER_DAYS_BEFORE) {
    const out = resolveReminder(sa({ reminder_kind: 'days_before', reminder_days_before: n }));
    assert.ok(out.date < '2026-09-10');
  }
  assert.equal(resolveReminder(sa({ reminder_kind: 'days_before', reminder_days_before: 3 })).date, '2026-09-07');
  assert.equal(resolveReminder(sa({ reminder_kind: 'custom', reminder_custom_date: '2026-09-01' })).date, '2026-09-01');
});

test('不被允許的提前天數解析不出提醒', () => {
  for (const n of [0, 4, 5, 6, 8, 30, -1]) {
    assert.equal(resolveReminder(sa({ reminder_kind: 'days_before', reminder_days_before: n })), null, String(n));
  }
});

test('提醒時間與日期完全分離：override 優先，其次使用者預設', () => {
  assert.equal(resolveReminder(sa({ reminder_kind: 'same_day' }), { defaultTime: '07:30' }).time, '07:30');
  assert.equal(resolveReminder(sa({ reminder_kind: 'same_day', reminder_time_override: '21:00' }),
    { defaultTime: '07:30' }).time, '21:00');
  // 沒帶預設就用系統預設 18:00
  assert.equal(resolveReminder(sa({ reminder_kind: 'same_day' })).time, DEFAULT_REMINDER_TIME);
  assert.equal(DEFAULT_REMINDER_TIME, '18:00');
});

test('換了提醒方式，日期規則就換一套；時間不受影響', () => {
  const base = { reminder_time_override: '08:00' };
  const a = resolveReminder(sa({ ...base, reminder_kind: 'same_day' }));
  const b = resolveReminder(sa({ ...base, reminder_kind: 'days_before', reminder_days_before: 7 }));
  assert.notEqual(a.date, b.date);
  assert.equal(a.time, b.time);
});

/* ---------- 逾期 ---------- */

test('只有日期時，當天結束以前都不算逾期', () => {
  const t = sa({ deadline_date: '2026-09-10' });
  assert.equal(effectiveDeadlineTime(t), '23:59');
  assert.equal(isOverdue(t, now('2026-09-10', '00:00')), false);
  assert.equal(isOverdue(t, now('2026-09-10', '23:59')), false);
  assert.equal(isOverdue(t, now('2026-09-11', '00:00')), true);
});

test('有時間時，過了那個時刻才算逾期', () => {
  const t = sa({ deadline_date: '2026-09-10', deadline_time: '12:00' });
  assert.equal(isOverdue(t, now('2026-09-10', '11:59')), false);
  assert.equal(isOverdue(t, now('2026-09-10', '12:00')), false, '剛好到點還不算遲交');
  assert.equal(isOverdue(t, now('2026-09-10', '12:01')), true);
});

test('已完成／已取消／已刪除都不算逾期', () => {
  const past = now('2026-12-01', '09:00');
  assert.equal(isOverdue(sa({ completed: 1 }), past), false);
  assert.equal(isOverdue(sa({ cancelled: 1 }), past), false);
  assert.equal(isOverdue(sa({ deleted: 1 }), past), false);
  assert.equal(isOverdue(sa(), past), true, '未結案的才算逾期');
});

/* ---------- 驗證 ---------- */

test('學校作業必填欄位', () => {
  assert.equal(validateSchoolAssignment(sa()), null);
  assert.match(validateSchoolAssignment(sa({ title: '  ' })), /作業名稱/);
  assert.match(validateSchoolAssignment(sa({ list_id: null })), /科目/);
  assert.match(validateSchoolAssignment(sa({ school_assignment_type: 'quiz' })), /類型/);
  assert.match(validateSchoolAssignment(sa({ school_assignment_type: undefined })), /類型/);
  assert.match(validateSchoolAssignment(sa({ deadline_date: null })), /繳交日期/);
  assert.match(validateSchoolAssignment(sa({ deadline_time: '25:00' })), /繳交時間/);
});

test('v1 的學校作業不支援重複', () => {
  assert.match(validateSchoolAssignment(sa({ recurring: 'weekly' })), /重複/);
});

test('提醒欄位驗證（generic，一般任務也適用）', () => {
  assert.equal(validateReminder({}), null);
  assert.match(validateReminder({ reminder_kind: 'someday' }), /提醒方式/);
  assert.match(validateReminder({ reminder_kind: 'days_before', reminder_days_before: 5 }), /1、2、3 或 7/);
  assert.match(validateReminder({ reminder_kind: 'custom' }), /自訂提醒日期/);
  assert.equal(validateReminder({ reminder_kind: 'custom', reminder_custom_date: '2026-09-01' }), null);
  assert.match(validateReminder({ reminder_kind: 'same_day', reminder_time_override: '9:00' }), /提醒時間/);
});

/* ---------- Today 分組 ---------- */

test('三個分組全部現算，且只看學校作業', () => {
  const tasks = [
    sa({ id: 1, deadline_date: '2026-09-10' }),                   // 今天
    sa({ id: 2, deadline_date: '2026-09-13' }),                   // 一週內
    sa({ id: 3, deadline_date: '2026-09-17' }),                   // 剛好第 7 天
    sa({ id: 4, deadline_date: '2026-09-18' }),                   // 超過一週
    sa({ id: 5, deadline_date: '2026-09-01' }),                   // 逾期
    sa({ id: 6, deadline_date: '2026-09-01', completed: 1 }),     // 逾期但已完成
    { id: 7, task_kind: 'standard', deadline_date: '2026-09-10', completed: 0, cancelled: 0, deleted: 0 },
  ];
  const g = groupSchoolAssignments(tasks, now('2026-09-10', '09:00'));
  assert.deepEqual(g.due_today.map(t => t.id), [1]);
  assert.deepEqual(g.upcoming.map(t => t.id), [2, 3]);
  assert.deepEqual(g.overdue.map(t => t.id), [5]);
});

test('今天要交、但時間已過：同時出現在今天與逾期', () => {
  const t = sa({ id: 1, deadline_date: '2026-09-10', deadline_time: '08:00' });
  const g = groupSchoolAssignments([t], now('2026-09-10', '14:00'));
  assert.deepEqual(g.due_today.map(x => x.id), [1], '今天該交的不能從今天清單消失');
  assert.deepEqual(g.overdue.map(x => x.id), [1]);
});

/* ---------- 統計 ---------- */

test('統計是 derived query，含四種類型 breakdown', () => {
  const tasks = [
    sa({ id: 1, school_assignment_type: 'homework', completed: 1 }),
    sa({ id: 2, school_assignment_type: 'report' }),
    sa({ id: 3, school_assignment_type: 'exam', deadline_date: '2026-09-01' }),
    sa({ id: 4, school_assignment_type: 'other', cancelled: 1 }),
    { id: 5, task_kind: 'standard', completed: 1 },
  ];
  const s = assignmentStats(tasks, now('2026-09-10', '09:00'));
  assert.equal(s.total, 4);
  assert.equal(s.completed, 1);
  assert.equal(s.cancelled, 1);
  assert.equal(s.overdue, 1);
  assert.deepEqual(s.by_type, { homework: 1, report: 1, exam: 1, other: 1 });
});
