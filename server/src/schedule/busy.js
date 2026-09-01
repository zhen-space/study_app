// 外部行事曆的忙碌時段：統一形狀、驗證、合併。
//
// 排程器只需要知道一件事：**哪些時間不能排**。它不需要知道那段時間是 Google
// 的會議還是 iPhone 上的家庭行事曆，更不需要知道事件標題。所以這裡把所有來源
// 收斂成同一種東西：
//
//   BusyInterval { start_at, end_at, source, source_ref? }
//
// 兩個刻意的設計：
//
//   1. **合併用區間聯集，不用事件比對。** 同一個 Google 帳號的行程，在
//      Google API 看得到、iPhone 的行事曆也看得到，如果照事件去比對就得處理
//      「Google event id ≠ EventKit event id」「標題被改過」這類永遠對不齊的問題。
//      但排程器要的只是「這段時間不能排」，所以重疊的區間直接聯集成一段就好——
//      同一段時間被兩個來源各報一次，不會變成兩倍忙碌。
//
//   2. **不落地。** 這些區間隨排程請求進來、算完就丟。沒有 apple_calendar_events、
//      沒有 busy cache、沒有跨來源的永久對應表。行事曆上刪掉的事件，下一次查詢
//      就自然消失，不需要任何失效機制。
//
// 這個檔案不碰資料庫、不呼叫任何外部服務，全部是純函式。

export const BUSY_SOURCES = ['google', 'apple', 'device'];

// 一次排程請求最多接受的區間數。這是防呆也是防濫用：正常一個月的行事曆
// 不會有上萬筆，數字大到不合理就是輸入有問題。
export const MAX_INTERVALS = 2000;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/* ---------- 驗證 ---------- */

// 只驗時間本身，不驗擁有權——因為這裡**沒有**任何屬於使用者的識別資訊，
// 也刻意不要有。呼叫端送進來的就只是幾段時間。
export function validateIntervals(input) {
  if (!Array.isArray(input)) return '忙碌時段格式不正確';
  if (input.length > MAX_INTERVALS) return '忙碌時段數量超出上限';
  for (const it of input) {
    if (!it || typeof it !== 'object') return '忙碌時段格式不正確';
    if (!ISO_RE.test(String(it.start_at ?? '')) || !ISO_RE.test(String(it.end_at ?? ''))) {
      return '忙碌時段時間格式不正確';
    }
    if (Date.parse(it.end_at) <= Date.parse(it.start_at)) return '忙碌時段的結束必須晚於開始';
    if (it.source != null && !BUSY_SOURCES.includes(it.source)) return '忙碌時段來源不正確';
  }
  return null;
}

// 收斂成內部形狀。刻意**只留時間與來源**——標題、地點、與會者一律丟掉，
// 排程器用不到，送進來也不存。
export function normalizeIntervals(input, defaultSource = 'device') {
  return (input || []).map(it => ({
    start_at: new Date(Date.parse(it.start_at)).toISOString(),
    end_at: new Date(Date.parse(it.end_at)).toISOString(),
    source: BUSY_SOURCES.includes(it.source) ? it.source : defaultSource,
    // 只作一次查詢內的除錯識別，絕不當成任何持久化的鍵
    source_ref: it.source_ref == null ? null : String(it.source_ref).slice(0, 128),
  })).sort((a, b) => a.start_at.localeCompare(b.start_at));
}

/* ---------- 合併 ---------- */

// 區間聯集。重疊或相接的合併成一段，並把來源收集起來（給 UI／除錯看，
// 排程器本身不看）。
//
// 這就是跨來源去重的全部：不比對事件、不猜 id、不做標題相似度。
export function mergeBusyIntervals(intervals) {
  const sorted = [...(intervals || [])].sort((a, b) => a.start_at.localeCompare(b.start_at));
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && it.start_at <= last.end_at) {
      // 相接（前一段的結束等於後一段的開始）也合併：中間沒有空隙就是同一段忙碌
      if (it.end_at > last.end_at) last.end_at = it.end_at;
      if (!last.sources.includes(it.source)) last.sources.push(it.source);
      continue;
    }
    out.push({ start_at: it.start_at, end_at: it.end_at, sources: [it.source] });
  }
  return out;
}

/* ---------- 投影到 Study App 的日子 ---------- */

// Study App v1 的「哪一天」一律是台灣時間。這裡把絕對時刻投影成
// 「台灣的哪一天、當天的第幾分鐘到第幾分鐘」，跨午夜的區間會被切成兩天。
const TW_OFFSET_MS = 8 * 3600e3;
const twParts = iso => {
  const d = new Date(Date.parse(iso) + TW_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
};

// 回傳 Map<'YYYY-MM-DD', [[起分, 迄分], …]>，與既有 Google busy 的形狀一致，
// 可以直接餵給 freeSlotsForDay / busyMinutesForDay。
export function busyByDay(merged, startDate = null, endDate = null) {
  const map = new Map();
  const push = (date, a, b) => {
    if (b <= a) return;
    if (startDate && date < startDate) return;
    if (endDate && date > endDate) return;
    if (!map.has(date)) map.set(date, []);
    map.get(date).push([a, b]);
  };
  for (const it of merged || []) {
    const s = twParts(it.start_at);
    const e = twParts(it.end_at);
    if (s.date === e.date) { push(s.date, s.minutes, e.minutes); continue; }
    // 跨午夜：頭一天補到 24:00，中間整天全滿，最後一天從 00:00 起
    push(s.date, s.minutes, 1440);
    let cur = s.date;
    for (let guard = 0; guard < 400; guard++) {
      cur = nextDate(cur);
      if (cur >= e.date) break;
      push(cur, 0, 1440);
    }
    push(e.date, 0, e.minutes);
  }
  for (const [, list] of map) list.sort((a, b) => a[0] - b[0]);
  return map;
}

const nextDate = ds => {
  const d = new Date(ds + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// 把既有 Google 的 Map<date, [[a,b],…]> 與外部送進來的區間合成一份。
// 兩邊同一段時間只會算一次。
export function combineDayMaps(...maps) {
  const out = new Map();
  for (const m of maps) {
    if (!m) continue;
    for (const [date, list] of m) {
      if (!out.has(date)) out.set(date, []);
      out.get(date).push(...list);
    }
  }
  for (const [date, list] of out) {
    const sorted = [...list].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [a, b] of sorted) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) { if (b > last[1]) last[1] = b; continue; }
      merged.push([a, b]);
    }
    out.set(date, merged);
  }
  return out;
}
