// 課表匯入 v2：P0 硬契約——weekday identity 綁「絕對欄位位置」，不綁「還活著的欄位序位」。
//
// 這一組專門釘住 audit 找出的實機 bug：星期一整欄漏掉時，星期二～星期五絕對不可以
// 整體左移。輸入是 OCR 出來的格子（含絕對欄列索引與 column_count 幾何訊號），不是圖片。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapWeekdays, buildItems, buildPreview, CONFIDENCE_THRESHOLD,
} from '../src/timetable/structure.js';

// 造一張表：headers 是每一欄的標題（null/'' = 沒有標題），rows 是每一列每一欄的文字。
// col 一律是絕對欄位索引；空白欄用 undefined 佔位（不輸出格子，但欄位仍存在）。
const grid = (headers, rows, opts = {}) => {
  const cells = [];
  headers.forEach((text, col) => { if (text != null && String(text).trim()) cells.push({ row: 0, col, text }); });
  rows.forEach((cols, r) => cols.forEach((text, col) => {
    if (text === undefined || text === null) return;
    const spec = typeof text === 'object' ? text : { text };
    cells.push({ row: r + 1, col, ...spec });
  }));
  return { header_row: 0, cells, ...opts };
};

const TIMES = ['08:10-09:00', '09:10-10:00', '10:10-11:00'];
const dowOfCol = (m, col) => m.mapping[col];

/* ---------- A. dropped Monday（整欄漏掉，含標題）---------- */

test('A. 星期一整欄漏掉、Tue–Fri 有標題：靠標題身分錨定，Tue–Fri 不左移', () => {
  // OCR 把星期一整欄吃掉，倖存欄被重新編號成 col 1..4（最壞情況），標題是週二～週五
  const g = grid(['時間', '星期二', '星期三', '星期四', '星期五'],
    TIMES.map((t, i) => [t, `英${i}`, `數${i}`, `理${i}`, `史${i}`]));
  const m = mapWeekdays(g);
  // 每一欄的星期身分必須跟著標題，不可以被推成星期一起算
  assert.equal(dowOfCol(m, 1), 2, '星期二欄仍是星期二');
  assert.equal(dowOfCol(m, 2), 3);
  assert.equal(dowOfCol(m, 3), 4);
  assert.equal(dowOfCol(m, 4), 5, '星期五欄仍是星期五');
  assert.notDeepEqual(Object.values(m.mapping), [1, 2, 3, 4], '絕不可整體左移成 Mon–Thu');
  assert.ok(m.uncertain, '欄數與標題起點不尋常 → 必須標記不確定');
  assert.ok(m.confidence < CONFIDENCE_THRESHOLD);
});

test('A2. 星期一漏掉但模型保留絕對欄位（col 2 起、含 column_count）：無標題也不左移', () => {
  // 模型有保留絕對欄位：時間軸 col0、星期一 col1 空白、星期二 col2 起有課，column_count=6
  const g = grid([], [
    ['08:10-09:00', undefined, '英', '數', '理', '史'],
    ['09:10-10:00', undefined, '英', '數', '理', '史'],
  ], { column_count: 6 });
  const m = mapWeekdays(g);
  assert.equal(dowOfCol(m, 2), 2, 'col2 的課是星期二，不是星期一');
  assert.equal(dowOfCol(m, 5), 5, 'col5 的課是星期五');
  assert.ok(m.warnings.includes('leading_missing_column'), '要標出前面漏了一欄');
  assert.ok(m.missing_columns.includes(1), '漏掉的是 col1（星期一）');
  assert.ok(m.uncertain);
  // 星期二～星期五的實際課程項目，星期一定要對
  const items = buildItems(g, m.mapping);
  assert.ok(items.every(it => it.day_of_week >= 2 && it.day_of_week <= 5));
});

/* ---------- B. blank Monday column（空白欄但幾何存在）---------- */

test('B. 星期一是空白欄但版面存在（column_count）：Tue–Fri 不左移', () => {
  const g = grid(['', '', '', '', '', ''], [
    ['08:10-09:00', undefined, '英', '數', '理', '史'],
    ['09:10-10:00', undefined, '英', '數', '理', '史'],
  ], { column_count: 6 });
  const m = mapWeekdays(g);
  assert.equal(dowOfCol(m, 1), 1, 'col1 這個空白 slot 仍屬星期一');
  assert.equal(dowOfCol(m, 2), 2, 'col2 的課是星期二');
  assert.equal(dowOfCol(m, 5), 5);
  const items = buildItems(g, m.mapping);
  assert.equal(items.filter(i => i.day_of_week === 1).length, 0, '星期一沒有課');
  assert.ok(items.every(i => i.day_of_week >= 2), '倖存的課全部 ≥ 星期二');
});

/* ---------- C. missing middle column（星期三 dropped）---------- */

test('C. 星期三整欄漏掉：Thu/Fri 不左移，缺口標記 uncertain', () => {
  // 時間軸 col0；星期一 col1、星期二 col2、（星期三 col3 空白）、星期四 col4、星期五 col5
  const g = grid(['', '', '', '', '', ''], [
    ['08:10-09:00', '國', '英', undefined, '理', '史'],
    ['09:10-10:00', '國', '英', undefined, '理', '史'],
  ], { column_count: 6 });
  const m = mapWeekdays(g);
  assert.equal(dowOfCol(m, 1), 1);
  assert.equal(dowOfCol(m, 2), 2);
  assert.equal(dowOfCol(m, 4), 4, '星期四欄仍是星期四，不左移成星期三');
  assert.equal(dowOfCol(m, 5), 5, '星期五欄仍是星期五');
  assert.ok(m.warnings.includes('interior_missing_column'), '中間缺欄要標記');
  assert.ok(m.missing_columns.includes(3));
  assert.ok(m.uncertain);
});

/* ---------- D. partial headers（只有週二/週四標題）---------- */

test('D. 只有星期二、星期四標題：以絕對欄距回填，星期三不錯位', () => {
  const g = grid(['', '', '星期二', '', '星期四', ''],
    TIMES.map((t, i) => [t, `A${i}`, `B${i}`, `C${i}`, `D${i}`, `E${i}`]));
  const m = mapWeekdays(g);
  assert.equal(dowOfCol(m, 1), 1, 'col1 回填成星期一');
  assert.equal(dowOfCol(m, 2), 2, '星期二標題');
  assert.equal(dowOfCol(m, 3), 3, 'col3 回填成星期三，不被拉成星期四');
  assert.equal(dowOfCol(m, 4), 4, '星期四標題');
  assert.equal(dowOfCol(m, 5), 5);
  assert.ok(m.warnings.includes('partial_weekday_header'));
});

test('D2. 標題與絕對欄距互相矛盾（週二在第 0 欄、週三在第 2 欄）→ 不採信、要求確認', () => {
  // 時間軸 col0；週二標在 col1（slot0）、週三標在 col3（slot2）——中間差了兩格，對不上
  const g = grid(['', '星期二', '', '星期三', '', ''],
    TIMES.map((t, i) => [t, `A${i}`, `B${i}`, `C${i}`, `D${i}`, `E${i}`]));
  const m = mapWeekdays(g);
  assert.ok(m.warnings.includes('weekday_header_inconsistent'));
  assert.equal(m.source, 'positional');
  assert.ok(m.uncertain);
});

/* ---------- E. headerless：幾何足夠 vs 不足 ---------- */

test('E1. 無標題但幾何足夠（column_count 一致、五欄齊全）：對應正確、仍要求確認', () => {
  const g = grid(['', '', '', '', '', ''],
    TIMES.map((t, i) => [t, `A${i}`, `B${i}`, `C${i}`, `D${i}`, `E${i}`]), { column_count: 6 });
  const m = mapWeekdays(g);
  assert.deepEqual(Object.values(m.mapping), [1, 2, 3, 4, 5], '五欄齊全 → 正確對應');
  assert.ok(!m.warnings.includes('insufficient_geometry'), '幾何足夠時不標 insufficient_geometry');
  const p = buildPreview(g);
  assert.equal(p.requires_mapping_confirmation, true, '無標題一律要求確認');
});

test('E2. 無標題且幾何不足（沒有 column_count、欄數異常）：標記 insufficient_geometry + 要求確認', () => {
  const g = grid(['', '', '', ''],
    TIMES.map((t, i) => [t, `A${i}`, `B${i}`, `C${i}`]));   // 3 課程欄，非 5/6/7
  const m = mapWeekdays(g);
  assert.ok(m.warnings.includes('missing_weekday_header'));
  assert.ok(m.warnings.includes('insufficient_geometry'));
  assert.ok(m.uncertain);
  assert.ok(m.confidence < CONFIDENCE_THRESHOLD);
});

/* ---------- preview 對外欄位 ---------- */

test('preview 對外帶出 uncertain / missing_columns / 每筆 uncertain 旗標', () => {
  const g = grid(['', '', '', '', '', ''], [
    ['08:10-09:00', undefined, '英', '數', '理', '史'],
  ], { column_count: 6 });
  const p = buildPreview(g);
  assert.equal(p.uncertain, true);
  assert.ok(Array.isArray(p.missing_columns) && p.missing_columns.includes(1));
  assert.ok(p.missing_weekdays.includes(1), '漏掉的欄對應到星期一，UI 才能提示');
  assert.ok(p.items.length > 0 && p.items.every(it => it.uncertain === true));
});
