// 課表匯入 v2：結構層。
//
// 為什麼要有這一層：舊版是「圖片 → AI prompt → events」，中間沒有任何結構判斷。
// 星期幾完全由模型自己說了算，於是實機出現最典型的兩種錯：星期一整欄被吃掉、
// 以及整週水平位移一天（沒有清楚的星期標題時，模型很容易把第一個課程欄當成星期二）。
//
// 光改 prompt 治不好這種錯——那只是換一組運氣。所以這裡把「哪一欄是星期幾」
// 從模型手上拿回來，改成程式依欄位幾何與標題文字**確定性**地決定。
//
// v2 硬性原則（P0）：weekday identity 綁「絕對欄位位置」，不是「還活著的欄位序位」。
//   ・舊版用 survivingCols.map((col, i) => days[i])——星期一整欄被 OCR 漏掉時，
//     後面的欄位就往左遞補，星期二被貼成星期一。這正是實機 bug。
//   ・v2 改用「離時間軸的絕對欄距」推星期：星期一是軸右邊第 0 欄、星期二第 1 欄……
//     漏掉的欄位留成一個空 slot（phantom），後面欄位**絕不左移**。
//   ・有星期標題時，用標題的星期身分當錨點，其餘欄位以絕對欄距回填——
//     即使星期一標題與內容都不見，星期二仍然是星期二。
//   ・欄位缺失／位置不確定時：標記 uncertain + 要求確認，不得 silent 寫入。
//
// 分工是硬性的：
//   ・AI / OCR 只負責：讀出每一格的文字與**絕對欄列位置**、提出科目名稱
//   ・AI / OCR **不得**決定：哪一欄是星期幾、哪一欄是時間軸、欄列邊界
//
// 這個檔案不碰資料庫、不呼叫 AI，全部是純函式。

/* ---------- 星期字典 ---------- */

// 只用來判讀「標題格寫的是不是星期」。判讀出來之後還要跟欄位幾何交叉檢查，
// 不會單憑文字就採用（契約：不得只靠 OCR text 判斷 weekday）。
const WEEKDAY_PATTERNS = [
  [1, /^(星期|週|周|禮拜)?一$|^mon(day)?$|^m$/i],
  [2, /^(星期|週|周|禮拜)?二$|^tue(s|sday)?$|^t$/i],
  [3, /^(星期|週|周|禮拜)?三$|^wed(nesday)?$|^w$/i],
  [4, /^(星期|週|周|禮拜)?四$|^thu(r|rs|rsday)?$|^th$/i],
  [5, /^(星期|週|周|禮拜)?五$|^fri(day)?$|^f$/i],
  [6, /^(星期|週|周|禮拜)?六$|^sat(urday)?$|^sa$/i],
  [0, /^(星期|週|周|禮拜)?日$|^(星期|週|周|禮拜)?天$|^sun(day)?$|^su$/i],
];

// 0=日, 1=一 … 6=六。認不出來回 null。
export function parseWeekday(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, '');
  if (!s) return null;
  for (const [dow, re] of WEEKDAY_PATTERNS) if (re.test(s)) return dow;
  return null;
}

/* ---------- 時間軸 ---------- */

const TIME_RE = /\d{1,2}\s*[:：]\s*\d{2}/;
const PERIOD_RE = /^(第\s*\d+\s*節|[一二三四五六七八九十]+節|\d+\s*節|P\s*\d+|Period\s*\d+)$/i;

// 一格看起來像不像「時間軸的標籤」（時刻、節次）。
export function looksLikeTimeLabel(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  return TIME_RE.test(s) || PERIOD_RE.test(s.replace(/\s+/g, ''));
}

// 找出左側時間軸的欄索引。找不到回 null。
//
// 判準刻意不是「它在第一欄」——那正是舊版把時間軸誤當星期一的原因。
// 真正的依據是欄內容：整欄的非空格子有沒有超過半數看起來像時刻或節次。
// 只在最左邊幾欄裡找，因為時間軸不會出現在中間。
export function detectTimeAxis(grid) {
  const cols = presentColumnIndices(grid);
  for (const col of cols.slice(0, 2)) {
    const cells = bodyCells(grid).filter(c => c.col === col && String(c.text ?? '').trim());
    if (!cells.length) continue;
    const hits = cells.filter(c => looksLikeTimeLabel(c.text)).length;
    if (hits / cells.length > 0.5) return col;
  }
  return null;
}

/* ---------- 欄位幾何 ---------- */

const headerRowIndex = grid => (grid?.header_row == null ? 0 : grid.header_row);
const bodyCells = grid => (grid?.cells || []).filter(c => c.row !== headerRowIndex(grid));
const headerCells = grid => (grid?.cells || []).filter(c => c.row === headerRowIndex(grid));
const hasText = t => !!String(t ?? '').trim();

// 有內容（含標題）的欄索引，排序。
function presentColumnIndices(grid) {
  return [...new Set((grid?.cells || []).map(c => c.col))].sort((a, b) => a - b);
}
export const columnIndices = presentColumnIndices;

// 模型宣告的總欄數（含時間軸與空白欄）。用來偵測「整欄漏掉／空白欄」——
// 有這個訊號才分得出「星期一是空堂」與「星期一被 OCR 吃掉」。
function declaredColumnCount(grid) {
  const n = Number(grid?.column_count);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 絕對欄位總數：取「模型宣告」與「實際看到的最大欄索引 + 1」的較大者。
// explicit=true 代表模型有明講欄數（幾何可靠，空白欄的位置可信）。
function resolveColumnSpan(grid) {
  const present = presentColumnIndices(grid);
  const observed = present.length ? present[present.length - 1] + 1 : 0;
  const declared = declaredColumnCount(grid);
  const count = Math.max(declared || 0, observed);
  return { count, observed, declared, explicit: declared != null && declared >= observed };
}

// 課程欄的「絕對 slot 清單」：從 0 到欄數-1，扣掉時間軸欄。
//
// 關鍵：**不因為某欄空白就把它拿掉**。空白欄要保留它的絕對位置，
// 這樣後面的欄位才不會左移。這是與舊版最大的差別。
export function courseColumns(grid) {
  const axis = detectTimeAxis(grid);
  const { count } = resolveColumnSpan(grid);
  const cols = [];
  for (let c = 0; c < count; c++) {
    if (c === axis) continue;
    cols.push(c);
  }
  return cols;
}

// 某一欄是否有實際內容（標題或課程），用來分辨空白欄／缺欄。
function columnHasContent(grid, col) {
  return bodyCells(grid).some(c => c.col === col && hasText(c.text))
    || headerCells(grid).some(c => c.col === col && hasText(c.text));
}

/* ---------- 星期對應 ---------- */

export const WEEK_STRUCTURES = {
  5: { name: 'mon_fri', days: [1, 2, 3, 4, 5] },
  6: { name: 'mon_sat', days: [1, 2, 3, 4, 5, 6] },
  7: { name: 'mon_sun', days: [1, 2, 3, 4, 5, 6, 0] },
};

// 一般學校週的第一個上課日。時間軸右邊第一個 slot 的預設星期——
// **不是**星期二。舊版最常見的錯就是整週往後位移一天。
export const FIRST_SCHOOL_DAY = 1;

export const CONFIDENCE_THRESHOLD = 0.85;

// 以星期一為 0 的序位，只為了做加減與判斷順序
const cyclicIndex = dow => (dow === 0 ? 6 : dow - 1);
const fromCyclic = idx => {
  const wrapped = ((idx % 7) + 7) % 7;
  return wrapped === 6 ? 0 : wrapped + 1;
};
const shiftWeekday = (dow, delta) => fromCyclic(cyclicIndex(dow) + delta);

// 依「絕對欄距」推星期：slot 0 = 第一個上課日（星期一），往右每一格 +1 天。
// slot 由「該欄的絕對索引 − 第一個課程 slot 的絕對索引」決定，
// 空白／缺欄會佔掉它自己的 slot，所以後面欄位不會遞補。
function positionalWeekday(slotOffset) {
  return fromCyclic(cyclicIndex(FIRST_SCHOOL_DAY) + slotOffset);
}

// 決定「第幾欄是星期幾」。
//
// 回傳 { mapping, confidence, week_structure, warnings, source, missing_columns,
//        uncertain, course_columns }：
//   ・source='header'    —— 標題可讀，用標題的星期身分當錨點，其餘以絕對欄距回填
//   ・source='positional'—— 沒有可用標題，依絕對欄距從第一個上課日往右排
//
// confidence 低於 CONFIDENCE_THRESHOLD 時必須由使用者在 preview 確認，不得直接寫入。
export function mapWeekdays(grid) {
  const cols = courseColumns(grid);
  const warnings = [];
  if (!cols.length) {
    return {
      mapping: {}, confidence: 0, week_structure: null, source: 'none',
      warnings: ['no_course_columns'], missing_columns: [], uncertain: true, course_columns: [],
    };
  }

  const span = resolveColumnSpan(grid);
  const firstCourseCol = cols[0];                 // 時間軸右邊第一個課程 slot 的絕對索引
  const slotOf = col => col - firstCourseCol;      // 0 = 星期一那個位置
  const structure = WEEK_STRUCTURES[cols.length] || null;
  if (!structure) warnings.push('unexpected_column_count');

  // 缺欄／空白欄偵測：課程 slot 裡沒有任何內容的欄。位置決定它是 leading / interior / trailing。
  const missing = cols.filter(col => !columnHasContent(grid, col));
  const lastContentCol = [...cols].reverse().find(col => columnHasContent(grid, col));
  const firstContentCol = cols.find(col => columnHasContent(grid, col));
  for (const col of missing) {
    if (firstContentCol == null || col < firstContentCol) warnings.push('leading_missing_column');
    else if (lastContentCol != null && col > lastContentCol) warnings.push('trailing_missing_column');
    else warnings.push('interior_missing_column');
  }

  // 絕對欄距推出來的 baseline（每一欄都對到自己的 slot，缺欄佔位、後面不左移）
  const positional = Object.fromEntries(cols.map(col => [col, positionalWeekday(slotOf(col))]));

  // 讀標題
  const headers = new Map();
  for (const col of cols) {
    const cell = headerCells(grid).find(c => c.col === col && hasText(c.text));
    const dow = parseWeekday(cell?.text);
    if (dow != null) headers.set(col, dow);
  }

  const anyMissing = missing.length > 0;

  if (headers.size === 0) {
    // 沒有任何星期標題。這是實機出錯的主要情境——**不得**因此假設第一欄是星期二。
    // 依絕對欄距，第一個課程 slot 預設是第一個上課日（星期一）。
    warnings.push('missing_weekday_header');
    // 幾何是否足夠可靠：模型有明講欄數、且欄數是常見週結構、且沒有缺欄。
    const geometrySufficient = span.explicit && !!structure && !anyMissing;
    if (!geometrySufficient) warnings.push('insufficient_geometry');
    const confidence = geometrySufficient ? 0.8 : (anyMissing ? 0.4 : 0.5);
    return finalize(cols, positional, {
      confidence, week_structure: structure?.name ?? null, source: 'positional', warnings, missing,
    });
  }

  if (headers.size < cols.length) warnings.push('partial_weekday_header');

  // 標題必須遞增且不重複，否則就是讀錯或欄位錯位，不能採信
  const orderedCols = cols.filter(c => headers.has(c));
  const ordered = orderedCols.map(c => headers.get(c));
  const strictlyOrdered = ordered.every((d, i) => i === 0 || cyclicIndex(ordered[i - 1]) < cyclicIndex(d));
  const unique = new Set(ordered).size === ordered.length;
  if (!unique || !strictlyOrdered) {
    warnings.push('weekday_header_inconsistent');
    return finalize(cols, positional, {
      confidence: 0.4, week_structure: structure?.name ?? null, source: 'positional', warnings, missing,
    });
  }

  // 用標題當**星期身分錨點**：以有標題的欄為錨，其餘欄位以「絕對欄距」回填。
  // 即使星期一整欄不見，星期二的標題仍把星期二釘在它的位置上——後面不會左移。
  const anchorCol = orderedCols[0];
  const anchorDow = headers.get(anchorCol);
  const anchorSlot = slotOf(anchorCol);
  const mapping = Object.fromEntries(cols.map(col => {
    if (headers.has(col)) return [col, headers.get(col)];
    return [col, shiftWeekday(anchorDow, slotOf(col) - anchorSlot)];
  }));

  // 有標題的欄位彼此是否與絕對欄距自洽（例如週二在第 0 欄、週四在第 2 欄才算對得上）
  const headerSelfConsistent = orderedCols.every(
    col => headers.get(col) === shiftWeekday(anchorDow, slotOf(col) - anchorSlot));
  if (!headerSelfConsistent) {
    warnings.push('weekday_header_inconsistent');
    return finalize(cols, positional, {
      confidence: 0.4, week_structure: structure?.name ?? null, source: 'positional', warnings, missing,
    });
  }

  // 標題錨定的結果與「純絕對欄距」是否一致；不一致代表整週位移（例如標題從週二開始），
  // 交給使用者確認。注意：即使不一致，我們採用的仍是**標題錨定**的結果（星期二＝星期二）。
  const agreesWithPositional = cols.every(c => mapping[c] === positional[c]);
  if (!agreesWithPositional) warnings.push('header_position_mismatch');

  const full = headers.size === cols.length;
  let confidence = full ? (agreesWithPositional ? 0.98 : 0.6) : (agreesWithPositional ? 0.9 : 0.55);
  if (anyMissing) confidence = Math.min(confidence, 0.6);   // 有缺欄一律要求確認
  return finalize(cols, mapping, {
    confidence, week_structure: structure?.name ?? null, source: 'header', warnings, missing,
  });
}

// 收斂輸出：去重 warnings、補 missing_columns、判定 uncertain。
function finalize(cols, mapping, { confidence, week_structure, source, warnings, missing }) {
  const uniqWarnings = [...new Set(warnings)];
  const uncertain = confidence < CONFIDENCE_THRESHOLD || uniqWarnings.length > 0;
  return {
    mapping, confidence, week_structure, source,
    warnings: uniqWarnings, missing_columns: [...missing].sort((a, b) => a - b),
    uncertain, course_columns: cols,
  };
}

// 使用者在 preview 說「整週往前／往後一天」時，一次改完整張對應表。
// 不要逼使用者逐格改——那是把系統的問題丟給人。
export function shiftMapping(mapping, delta) {
  return Object.fromEntries(Object.entries(mapping).map(([col, dow]) => [col, shiftWeekday(dow, delta)]));
}

/* ---------- 課程項目 ---------- */

// 把格子轉成課程項目，並把「同一欄、上下相鄰、同名」的格子合併成一段。
//
// 合併是必要的：大格跨多節在 OCR 出來會是多個 row，逐格輸出會產生一堆互相接續
// 卻分開的項目。合併成 start/end 才符合既有 fixed_events 的形狀。
export function buildItems(grid, mapping) {
  const axis = detectTimeAxis(grid);
  const periods = periodTimes(grid, axis);
  const items = [];
  const cols = Object.keys(mapping).map(Number).sort((a, b) => a - b);

  for (const col of cols) {
    const dow = mapping[col];
    if (dow == null) continue;
    const cells = bodyCells(grid)
      .filter(c => c.col === col && hasText(c.text))
      .sort((a, b) => a.row - b.row);

    let cur = null;
    for (const cell of cells) {
      const title = String(cell.text).trim();
      const span = Math.max(1, Number(cell.row_span) || 1);
      const startRow = cell.row;
      const endRow = cell.row + span - 1;
      // 相鄰（中間沒有空堂）且同名才合併；隔著空堂的同名課是兩段不同的課
      if (cur && cur.title === title && startRow === cur.end_row + 1) {
        cur.end_row = endRow;
        continue;
      }
      if (cur) items.push(cur);
      cur = { column: col, day_of_week: dow, title, start_row: startRow, end_row: endRow };
    }
    if (cur) items.push(cur);
  }

  return items.map(it => {
    const start = periods.get(it.start_row);
    const end = periods.get(it.end_row);
    return {
      day_of_week: it.day_of_week,
      title: it.title,
      start_time: start?.start ?? null,
      end_time: end?.end ?? start?.end ?? null,
      start_row: it.start_row,
      end_row: it.end_row,
      column: it.column,
    };
  });
}

// 從時間軸欄讀出每一列的起訖時間。讀不出來就留 null，由使用者在 preview 補，
// **不憑空推估**——猜出來的時間看起來很像真的，錯了也不會有人發現。
export function periodTimes(grid, axisCol) {
  const map = new Map();
  if (axisCol == null) return map;
  for (const cell of bodyCells(grid).filter(c => c.col === axisCol)) {
    const text = String(cell.text ?? '');
    const times = [...text.matchAll(/(\d{1,2})\s*[:：]\s*(\d{2})/g)]
      .map(m => `${String(m[1]).padStart(2, '0')}:${m[2]}`);
    if (times.length >= 2) map.set(cell.row, { start: times[0], end: times[1] });
    else if (times.length === 1) map.set(cell.row, { start: times[0], end: null });
  }
  return map;
}

/* ---------- 結構驗證 ---------- */

// persist 之前一定要跑。回傳 { ok, errors, warnings }。
export function validateStructure(grid, mapped, items) {
  const errors = [];
  const cols = Object.keys(mapped.mapping || {}).map(Number);
  if (!cols.length) errors.push('no_course_columns');
  if (!items.length) errors.push('no_items');

  const days = new Set(Object.values(mapped.mapping || {}));
  if (days.size !== cols.length) errors.push('duplicate_weekday_mapping');

  // 時間軸絕不能被當成課程欄——這條單獨驗，因為它是實機錯誤的來源之一
  const axis = detectTimeAxis(grid);
  if (axis != null && cols.includes(axis)) errors.push('time_axis_used_as_weekday');

  for (const it of items) {
    if (it.start_time && it.end_time && it.end_time <= it.start_time) errors.push('invalid_time_range');
  }
  return { ok: errors.length === 0, errors, warnings: mapped.warnings || [] };
}

/* ---------- preview ---------- */

// 匯入前一定要給人看的那一份。can_persist=false 時前端不得送出匯入。
//
// requires_mapping_confirmation 為 true 代表「星期對應是猜的、或有缺欄／位置不確定」，
// 使用者必須明確確認（或整週位移修正）之後才准寫入。
export function buildPreview(grid) {
  const mapped = mapWeekdays(grid);
  const items = buildItems(grid, mapped.mapping);
  const validation = validateStructure(grid, mapped, items);
  const lowConfidence = mapped.confidence < CONFIDENCE_THRESHOLD;
  const requires = lowConfidence || validation.warnings.length > 0 || mapped.uncertain;

  // 缺欄的絕對欄 → 它被推成哪個星期，讓 UI 能明確標「星期X 那一欄可能漏了」
  const missingWeekdays = (mapped.missing_columns || []).map(col => mapped.mapping[col]).filter(d => d != null);

  return {
    mode: 'preview_only',
    week_structure: mapped.week_structure,
    weekday_mapping: mapped.mapping,
    mapping_source: mapped.source,
    mapping_confidence: mapped.confidence,
    requires_mapping_confirmation: requires,
    uncertain: !!mapped.uncertain,
    can_persist: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    missing_columns: mapped.missing_columns || [],
    missing_weekdays: missingWeekdays,
    time_axis_column: detectTimeAxis(grid),
    course_columns: mapped.course_columns || courseColumns(grid),
    // 每一堂課帶一個 uncertain 旗標，UI 才能逐筆標示低信心
    items: items.map(it => ({ ...it, uncertain: requires })),
  };
}
