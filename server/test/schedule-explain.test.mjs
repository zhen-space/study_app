// 「為什麼這樣排」。
//
// 這個功能的重點不是 AI，是**沒有 AI 也完整可用**。所以測試幾乎全部在測
// 確定性的那一層：事實對不對、沒有金鑰時會不會壞、AI 是不是真的只讀不寫。
//
// 合約：
//   ① facts / sentences 完全確定性，來自 active ScheduleVersion、Lock、
//      已確認的排程條件。
//   ② 沒有 ANTHROPIC_API_KEY 時仍回 200，narrative 為 null，
//      並說得出原因（no_api_key）。
//   ③ AI 只讀不寫：呼叫這支端點不得改動任何 block、Material completion
//      或 Plan selection。
//   ④ 沒有排程時不會炸，也不會浪費一次 AI 呼叫。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day } from './helpers.mjs';
import { explainSchedule, explainSentences } from '../src/schedule/explain.js';

/* ---------- 純函式：事實怎麼算出來的 ---------- */

const lists = [{ id: 1, name: '數學' }, { id: 2, name: '物理' }];
const tasks = [
  { id: 11, list_id: 1, plan_id: 5, completed: 0, cancelled: 0, deleted: 0 },
  { id: 12, list_id: 1, plan_id: 5, completed: 0, cancelled: 0, deleted: 0 },
  { id: 13, list_id: 2, plan_id: 5, completed: 0, cancelled: 0, deleted: 0 },
  { id: 14, list_id: 2, plan_id: 5, completed: 0, cancelled: 0, deleted: 0 },  // 沒有 block → unplaced
];
const blocks = [
  { id: 1, task_id: 11, date: '2026-09-01', start_time: '08:00', end_time: '09:00', planned_minutes: 60 },
  { id: 2, task_id: 12, date: '2026-09-01', start_time: '09:10', end_time: '10:10', planned_minutes: 60 },
  { id: 3, task_id: 13, date: '2026-09-03', start_time: '19:00', end_time: '19:30', planned_minutes: 30 },
];

test('事實全部從傳進來的資料算，不做任何推測', () => {
  const f = explainSchedule({ blocks, tasks, lists, locks: [], constraints: {}, today: '2026-09-01' });
  assert.deepEqual(f.range, { start: '2026-09-01', end: '2026-09-03' });
  assert.equal(f.total_blocks, 3);
  assert.equal(f.total_minutes, 150);
  assert.equal(f.days_used, 2, '只算真的有排東西的天數，不是日期區間長度');
  assert.equal(f.avg_minutes_per_day, 75);
  assert.deepEqual(f.busiest_day, { date: '2026-09-01', minutes: 120, count: 2 });
  assert.deepEqual(f.time_window, { earliest: '08:00', latest: '19:30' });
  assert.equal(f.timed, true);
  assert.deepEqual(f.subjects, [
    { subject: '數學', count: 2, minutes: 120 },
    { subject: '物理', count: 1, minutes: 30 },
  ]);
  assert.equal(f.unplaced_count, 1, '有計畫、未完成、卻沒有 block 的算尚未安排');
});

test('已完成／已取消／已刪除的不算成尚未安排', () => {
  const f = explainSchedule({
    blocks: [],
    tasks: [
      { id: 21, plan_id: 5, completed: 1, cancelled: 0, deleted: 0 },
      { id: 22, plan_id: 5, completed: 0, cancelled: 1, deleted: 0 },
      { id: 23, plan_id: 5, completed: 0, cancelled: 0, deleted: 1 },
      { id: 24, plan_id: null, completed: 0, cancelled: 0, deleted: 0 },  // 不屬於任何計畫
      { id: 25, plan_id: 5, completed: 0, cancelled: 0, deleted: 0 },
    ],
    lists, locks: [], constraints: {},
  });
  assert.equal(f.unplaced_count, 1);
});

test('只列已解除以外的鎖定，而且只列使用者真的設過的條件', () => {
  const f = explainSchedule({
    blocks, tasks, lists,
    locks: [
      { id: 1, type: 'day', date: '2026-09-02', released_at: null },
      { id: 2, type: 'task', task_id: 11, released_at: '2026-09-01T00:00:00Z' },   // 已解除
    ],
    constraints: { max_per_day: 3, exclude_weekdays: [], subject_order: null, spread: false },
  });
  assert.equal(f.locks.length, 1);
  assert.equal(f.locks[0].type, 'day');
  const keys = f.applied_constraints.map(c => c.key);
  assert.ok(keys.includes('max_per_day'));
  assert.ok(keys.includes('spread'), 'false 是使用者真的選過的值，要保留');
  assert.ok(!keys.includes('exclude_weekdays'), '空陣列＝沒設，不該假裝生效');
  assert.ok(!keys.includes('subject_order'), 'null＝沒設');
});

test('只排每天做什麼、沒綁時間時要說得出來，不能謊稱有時段', () => {
  const untimed = blocks.map(b => ({ ...b, start_time: null, end_time: null }));
  const f = explainSchedule({ blocks: untimed, tasks, lists, locks: [], constraints: {} });
  assert.equal(f.timed, false);
  assert.equal(f.time_window, null);
  assert.ok(explainSentences(f).some(x => x.includes('沒有綁定幾點')));
});

test('沒有排程時給得出話，而且不會炸', () => {
  const f = explainSchedule({ blocks: [], tasks: [], lists: [], locks: [], constraints: {} });
  assert.equal(f.total_blocks, 0);
  assert.equal(f.range, null);
  assert.equal(f.busiest_day, null);
  const s = explainSentences(f);
  assert.ok(s.length > 0);
  assert.ok(s[0].includes('沒有已排定'));
});

test('說明句子只講事實裡有的數字', () => {
  const f = explainSchedule({ blocks, tasks, lists, locks: [], constraints: {} });
  const text = explainSentences(f).join('');
  assert.ok(text.includes('3 個時段'));
  assert.ok(text.includes('75 分鐘'));
  assert.ok(text.includes('數學 120 分鐘'));
  assert.ok(text.includes('還有 1 項沒排進來'));
});

/* ---------- 端點：沒有金鑰時的行為 ---------- */

test('沒有 ANTHROPIC_API_KEY 時仍回 200，並說得出為什麼沒有 AI 說明', async () => {
  // 測試用伺服器不帶金鑰——這正是 production 還沒設好時的情況
  const { base, H, stop } = await startServer();
  try {
    const r = await fetch(base + '/schedule/explain', { headers: H });
    assert.equal(r.status, 200, 'AI 不可用不能讓整支端點掛掉');
    const j = await r.json();
    assert.equal(j.narrative, null);
    assert.equal(j.ai.available, false);
    assert.ok(['no_api_key', 'nothing_to_explain'].includes(j.ai.reason), `未預期的原因：${j.ai.reason}`);
    assert.ok(Array.isArray(j.sentences) && j.sentences.length > 0, '確定性的說明一定要有');
    assert.ok(j.facts, '事實摘要一定要有');
  } finally { stop(); }
});

test('解釋排程不會改動任何資料（AI 只讀不寫）', async () => {
  const { base, H, stop } = await startServer();
  try {
    const snapshot = async () => JSON.stringify({
      tasks: await (await fetch(base + '/tasks', { headers: H })).json(),
      active: await (await fetch(base + '/schedule/active', { headers: H })).json(),
    });
    const before = await snapshot();
    await fetch(base + '/schedule/explain', { headers: H });
    assert.equal(await snapshot(), before, '解釋排程是唯讀的');
  } finally { stop(); }
});
