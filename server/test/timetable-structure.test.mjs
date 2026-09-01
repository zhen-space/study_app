// 課表匯入 v2 結構層。
//
// 這些是 deterministic fixture 測試：輸入是 OCR 出來的格子（含欄列索引），
// 不是圖片。要釘住的是「程式怎麼決定星期幾」，而那必須與模型無關。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWeekday, looksLikeTimeLabel, detectTimeAxis, courseColumns,
  mapWeekdays, shiftMapping, buildItems, buildPreview, validateStructure,
  FIRST_SCHOOL_DAY, CONFIDENCE_THRESHOLD,
} from '../src/timetable/structure.js';

// 造一張表：cols 是每一欄的標題（null = 沒有標題），rows 是每一列每一欄的文字
const grid = (headers, rows, opts = {}) => {
  const cells = [];
  headers.forEach((text, col) => cells.push({ row: 0, col, text: text ?? '' }));
  rows.forEach((cols, r) => cols.forEach((text, col) => {
    if (text === undefined) return;
    const spec = typeof text === 'object' && text !== null ? text : { text };
    cells.push({ row: r + 1, col, ...spec });
  }));
  return { header_row: 0, cells, ...opts };
};

const TIMES = ['08:10-09:00', '09:10-10:00', '10:10-11:00', '11:10-12:00'];
// 左側時間軸 + 五個課程欄
const monFri = (headers = ['', '星期一', '星期二', '星期三', '星期四', '星期五']) =>
  grid(headers, TIMES.map((t, i) => [t, `國文${i}`, `英文${i}`, `數學${i}`, `理化${i}`, `歷史${i}`]));

/* ---------- 星期文字 ---------- */

test('星期文字判讀涵蓋中英與常見寫法', () => {
  for (const [text, dow] of [['星期一', 1], ['週一', 1], ['一', 1], ['Mon', 1], ['MONDAY', 1],
    ['星期六', 6], ['週日', 0], ['星期天', 0], ['Sun', 0], ['Fri', 5]]) {
    assert.equal(parseWeekday(text), dow, text);
  }
  for (const text of ['', '數學', '第1節', '08:10', null]) {
    assert.equal(parseWeekday(text), null, String(text));
  }
});

/* ---------- 時間軸 ---------- */

test('時間軸靠內容認出來，不是靠「它在第一欄」', () => {
  assert.equal(looksLikeTimeLabel('08:10-09:00'), true);
  assert.equal(looksLikeTimeLabel('第1節'), true);
  assert.equal(looksLikeTimeLabel('數學'), false);
  assert.equal(detectTimeAxis(monFri()), 0);
});

test('沒有時間軸的表：不得誤把課程欄當時間軸', () => {
  const g = grid(['星期一', '星期二'], [['國文', '英文'], ['數學', '理化']]);
  assert.equal(detectTimeAxis(g), null);
  assert.deepEqual(courseColumns(g), [0, 1]);
});

test('時間軸欄永遠不算課程欄', () => {
  assert.deepEqual(courseColumns(monFri()), [1, 2, 3, 4, 5]);
});

/* ---------- 核心 regression：第一個課程欄 ---------- */

test('沒有星期標題時，第一個有效課程欄是星期一——絕不可以變成星期二', () => {
  const g = grid(['', '', '', '', '', ''],
    TIMES.map((t, i) => [t, `國文${i}`, `英文${i}`, `數學${i}`, `理化${i}`, `歷史${i}`]));
  const m = mapWeekdays(g);
  assert.equal(m.source, 'positional');
  assert.ok(m.warnings.includes('missing_weekday_header'));
  const first = courseColumns(g)[0];
  assert.equal(m.mapping[first], FIRST_SCHOOL_DAY);
  assert.equal(m.mapping[first], 1, '第一個課程欄必須是星期一');
  assert.notEqual(m.mapping[first], 2, '不得退化成星期二');
  assert.deepEqual(Object.values(m.mapping), [1, 2, 3, 4, 5]);
});

test('有時間軸且沒有星期標題時，星期一仍然不會被時間軸吃掉', () => {
  const g = grid(['時間', '', '', '', '', ''],
    TIMES.map((t, i) => [t, `國文${i}`, `英文${i}`, `數學${i}`, `理化${i}`, `歷史${i}`]));
  const m = mapWeekdays(g);
  assert.equal(detectTimeAxis(g), 0);
  assert.equal(m.mapping[1], 1);
  assert.equal(Object.keys(m.mapping).length, 5);
});

test('星期標題被裁掉一部分：仍以欄序補完，不整週位移', () => {
  const g = grid(['', '星期一', '', '', '', ''],
    TIMES.map((t, i) => [t, `A${i}`, `B${i}`, `C${i}`, `D${i}`, `E${i}`]));
  const m = mapWeekdays(g);
  assert.ok(m.warnings.includes('partial_weekday_header'));
  assert.deepEqual(Object.values(m.mapping), [1, 2, 3, 4, 5]);
});

/* ---------- 週結構 ---------- */

test('五、六、七欄分別對到 Mon-Fri / Mon-Sat / Mon-Sun', () => {
  const mk = n => grid(new Array(n + 1).fill(''),
    TIMES.map((t, i) => [t, ...new Array(n).fill(`科${i}`)]));
  assert.equal(mapWeekdays(mk(5)).week_structure, 'mon_fri');
  assert.deepEqual(Object.values(mapWeekdays(mk(5)).mapping), [1, 2, 3, 4, 5]);
  assert.equal(mapWeekdays(mk(6)).week_structure, 'mon_sat');
  assert.deepEqual(Object.values(mapWeekdays(mk(6)).mapping), [1, 2, 3, 4, 5, 6]);
  assert.equal(mapWeekdays(mk(7)).week_structure, 'mon_sun');
  assert.deepEqual(Object.values(mapWeekdays(mk(7)).mapping), [1, 2, 3, 4, 5, 6, 0]);
});

test('欄數不是 5/6/7 時標記警告，不硬套週結構', () => {
  const g = grid(['', '', '', ''], [['08:10-09:00', 'A', 'B', 'C']]);
  const m = mapWeekdays(g);
  assert.ok(m.warnings.includes('unexpected_column_count'));
});

/* ---------- 標題可信時才採用標題 ---------- */

test('標題完整且與欄序一致 → 高信心，可直接匯入', () => {
  const m = mapWeekdays(monFri());
  assert.equal(m.source, 'header');
  assert.ok(m.confidence >= CONFIDENCE_THRESHOLD);
  assert.deepEqual(Object.values(m.mapping), [1, 2, 3, 4, 5]);
});

test('標題確實從星期二開始時採信標題，但降信心並標記', () => {
  const m = mapWeekdays(monFri(['', '星期二', '星期三', '星期四', '星期五', '星期六']));
  assert.equal(m.source, 'header');
  assert.deepEqual(Object.values(m.mapping), [2, 3, 4, 5, 6]);
  assert.ok(m.warnings.includes('header_position_mismatch'));
  assert.ok(m.confidence < CONFIDENCE_THRESHOLD, '與欄序不一致時必須要求確認');
});

test('標題重複或亂序 → 不採信，退回欄序並要求確認', () => {
  const m = mapWeekdays(monFri(['', '星期一', '星期一', '星期三', '星期四', '星期五']));
  assert.ok(m.warnings.includes('weekday_header_inconsistent'));
  assert.equal(m.source, 'positional');
  assert.ok(m.confidence < CONFIDENCE_THRESHOLD);
});

/* ---------- 整週位移修正 ---------- */

test('整週往後一天：一次改完整張對應表', () => {
  const m = mapWeekdays(monFri());
  const shifted = shiftMapping(m.mapping, 1);
  assert.deepEqual(Object.values(shifted), [2, 3, 4, 5, 6]);
});

test('整週往前一天，以及跨週界的環繞', () => {
  const m = mapWeekdays(monFri(['', '星期二', '星期三', '星期四', '星期五', '星期六']));
  assert.deepEqual(Object.values(shiftMapping(m.mapping, -1)), [1, 2, 3, 4, 5]);
  // 星期一往前一天是星期日
  assert.deepEqual(Object.values(shiftMapping({ 1: 1 }, -1)), [0]);
  // 星期日往後一天是星期一
  assert.deepEqual(Object.values(shiftMapping({ 1: 0 }, 1)), [1]);
});

/* ---------- 課程項目 ---------- */

test('空堂不會產生項目', () => {
  const g = grid(['', '星期一', '星期二'], [
    ['08:10-09:00', '國文', ''],
    ['09:10-10:00', '', '英文'],
  ]);
  const items = buildItems(g, mapWeekdays(g).mapping);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.title).sort(), ['國文', '英文']);
});

test('同一科跨多節：相鄰同名合併成一段，不拆成互相接續的兩筆', () => {
  const g = grid(['', '星期一'], [
    ['08:10-09:00', '數學'],
    ['09:10-10:00', '數學'],
    ['10:10-11:00', '英文'],
  ]);
  const items = buildItems(g, mapWeekdays(g).mapping);
  assert.equal(items.length, 2);
  const math = items.find(i => i.title === '數學');
  assert.equal(math.start_time, '08:10');
  assert.equal(math.end_time, '10:00', '合併後的結束時間取最後一節');
});

test('隔著空堂的同名課是兩段，不可以被合併', () => {
  const g = grid(['', '星期一'], [
    ['08:10-09:00', '數學'],
    ['09:10-10:00', ''],
    ['10:10-11:00', '數學'],
  ]);
  const items = buildItems(g, mapWeekdays(g).mapping);
  assert.equal(items.length, 2);
});

test('merged cell（row_span）展開成一段，不重複輸出', () => {
  const g = grid(['', '星期一'], [
    ['08:10-09:00', { text: '社團', row_span: 2 }],
    ['09:10-10:00', undefined],
    ['10:10-11:00', '數學'],
  ]);
  const items = buildItems(g, mapWeekdays(g).mapping);
  const club = items.find(i => i.title === '社團');
  assert.equal(items.filter(i => i.title === '社團').length, 1);
  assert.equal(club.start_time, '08:10');
  assert.equal(club.end_time, '10:00');
});

test('讀不出時間就留 null，不憑空推估', () => {
  const g = grid(['', '星期一'], [['第一節', '數學']]);
  const items = buildItems(g, mapWeekdays(g).mapping);
  assert.equal(items[0].start_time, null);
});

/* ---------- 驗證與 preview ---------- */

test('preview：高信心時可直接匯入', () => {
  const p = buildPreview(monFri());
  assert.equal(p.mode, 'preview_only');
  assert.equal(p.can_persist, true);
  assert.equal(p.requires_mapping_confirmation, false);
  assert.equal(p.time_axis_column, 0);
  assert.deepEqual(p.course_columns, [1, 2, 3, 4, 5]);
  assert.equal(p.items.length, 20);
});

test('preview：沒有星期標題 → 低信心，必須先確認才准匯入', () => {
  const g = grid(['', '', '', '', '', ''],
    TIMES.map((t, i) => [t, `A${i}`, `B${i}`, `C${i}`, `D${i}`, `E${i}`]));
  const p = buildPreview(g);
  assert.equal(p.requires_mapping_confirmation, true);
  assert.ok(p.mapping_confidence < CONFIDENCE_THRESHOLD);
  assert.ok(p.warnings.includes('missing_weekday_header'));
});

test('preview：空表不可匯入', () => {
  const p = buildPreview(grid(['', ''], []));
  assert.equal(p.can_persist, false);
  assert.ok(p.errors.length > 0);
});

test('驗證會擋下時間軸被當成星期欄', () => {
  const g = monFri();
  // 直接偽造一個把時間軸算進課程欄的對應
  const bad = { mapping: { 0: 1, 1: 2 }, warnings: [] };
  const v = validateStructure(g, bad, buildItems(g, bad.mapping));
  assert.equal(v.ok, false);
});

test('驗證會擋下重複的星期對應', () => {
  const g = monFri();
  const bad = { mapping: { 1: 1, 2: 1, 3: 3, 4: 4, 5: 5 }, warnings: [] };
  const v = validateStructure(g, bad, buildItems(g, bad.mapping));
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes('duplicate_weekday_mapping'));
});

/* ---------- 自製表格（實機 bug 情境）---------- */

test('自製表格：欄寬不均、無標題、有時間軸——星期一仍在第一欄', () => {
  const g = grid(['時間', '', '', '', '', ''], [
    ['08:10-09:00', '數學', '英文', '', '理化', '國文'],
    ['09:10-10:00', '數學', '', '公民', '理化', ''],
    ['10:10-11:00', '', '英文', '公民', '', '國文'],
  ]);
  const p = buildPreview(g);
  assert.equal(p.time_axis_column, 0);
  assert.deepEqual(p.course_columns, [1, 2, 3, 4, 5]);
  assert.equal(p.weekday_mapping[1], 1, '第一個課程欄＝星期一');
  assert.equal(p.requires_mapping_confirmation, true, '無標題必須確認');
  // 星期一那欄的課確實被讀到（舊 bug 是整欄消失）
  const monday = p.items.filter(i => i.day_of_week === 1);
  assert.equal(monday.length, 1);
  assert.equal(monday[0].title, '數學');
  assert.equal(monday[0].end_time, '10:00');
});

test('整週 +1 位移的候選，可用 -1 修正回來', () => {
  const g = grid(['', '星期二', '星期三', '星期四', '星期五', '星期六'],
    TIMES.map((t, i) => [t, `A${i}`, `B${i}`, `C${i}`, `D${i}`, `E${i}`]));
  const p = buildPreview(g);
  assert.equal(p.weekday_mapping[1], 2);
  assert.equal(p.requires_mapping_confirmation, true);
  const fixed = shiftMapping(p.weekday_mapping, -1);
  assert.equal(fixed[1], 1);
  const items = buildItems(g, fixed);
  assert.ok(items.every(i => i.day_of_week >= 1 && i.day_of_week <= 5));
});
