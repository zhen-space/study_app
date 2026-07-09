import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function freeSlotsForDay(dateStr, events, settings) {
  const busy = [];
  const sleepStart = toMin(settings.sleep_start);
  const sleepEnd = toMin(settings.sleep_end);
  if (sleepStart > sleepEnd) busy.push([0, sleepEnd], [sleepStart, 1440]);
  else busy.push([sleepStart, sleepEnd]);
  for (const [a, b] of settings.meal_windows) busy.push([toMin(a), toMin(b)]);

  const dow = new Date(dateStr + 'T00:00:00').getDay();
  for (const e of events) {
    const applies = e.recurring === 'weekly'
      ? new Date(e.date + 'T00:00:00').getDay() === dow && e.date <= dateStr
      : e.date === dateStr;
    if (applies) busy.push([toMin(e.start_time), toMin(e.end_time)]);
  }

  busy.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of busy) {
    if (merged.length && iv[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
    } else merged.push([...iv]);
  }
  const free = [];
  let cur = 0;
  for (const [a, b] of merged) {
    if (a - cur >= 30) free.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (1440 - cur >= 30) free.push([cur, 1440]);
  return free;
}

// POST /api/schedule/preview
// { items:[{subject_id, title, minutes, start, end, final}], mode:'order'|'spread', startDate?, endDate? }
// 每個項目可有自己的日期範圍；final=true 的項目（壓軸）會排在其他項目全部結束之後
// 某天既定行程（含週期）的總分鐘數
function busyMinutesForDay(dateStr, events) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  let m = 0;
  for (const e of events) {
    const applies = e.recurring === 'weekly'
      ? new Date(e.date + 'T00:00:00').getDay() === dow && e.date <= dateStr
      : e.date === dateStr;
    if (applies) m += toMin(e.end_time) - toMin(e.start_time);
  }
  return m;
}

router.post('/preview', async (req, res) => {
  const { items, excludeWeekdays = [], excludeDates = [], skipIfBusyHours = 0 } = req.body;
  if (!items?.length) return res.status(400).json({ error: '參數不完整' });
  const today = new Date().toISOString().slice(0, 10);
  const gStart = req.body.startDate || today, gEnd = req.body.endDate || today;
  for (const it of items) { it.start = it.start || gStart; it.end = it.end || gEnd; }

  const minD = items.reduce((a, i) => i.start < a ? i.start : a, items[0].start);
  const maxD = items.reduce((a, i) => i.end > a ? i.end : a, items[0].end);

  const u = await q.get('SELECT sleep_start, sleep_end, meal_windows FROM users WHERE id=?', [req.userId]);
  const settings = { ...u, meal_windows: JSON.parse(u.meal_windows) };
  if (req.body.sleep_start) settings.sleep_start = req.body.sleep_start;
  if (req.body.sleep_end) settings.sleep_end = req.body.sleep_end;
  const events = await q.all('SELECT * FROM fixed_events WHERE user_id=?', [req.userId]);

  const days = [];
  for (let d = new Date(minD + 'T00:00:00'); ; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    if (ds > maxD) break;
    if (ds < today) continue;
    if (excludeDates.includes(ds)) continue;                      // 指定不排的日期
    if (excludeWeekdays.includes(d.getDay())) continue;           // 不排的星期
    if (skipIfBusyHours > 0 && busyMinutesForDay(ds, events) >= skipIfBusyHours * 60) continue; // 既定行程太滿
    days.push({ date: ds, slots: freeSlotsForDay(ds, events, settings), slotIdx: 0 });
  }
  if (!days.length) return res.status(400).json({ error: '沒有可排的日期' });
  days.forEach(d => { d.pos = d.slots[0]?.[0] ?? null; });

  const CHUNK = 90, BREAK = 10;
  const mkChunks = list => {
    const out = [];
    for (const it of list) {
      let rem = it.minutes || 120;
      while (rem > 0) {
        const c = Math.min(CHUNK, rem);
        out.push({ ...it, chunk: rem - c > 0 && rem - c < 30 ? rem : c });
        rem -= out[out.length - 1].chunk;
      }
    }
    return out;
  };

  // 佇列：同科目內依「打散/照順序」排列（item.spread，預設打散），跨科目一律輪流（每天各科都碰到）
  function buildQueue(list) {
    const bySub = {};
    list.forEach(it => { (bySub[it.subject_id] = bySub[it.subject_id] || []).push(it); });
    const subjQueues = Object.values(bySub).map(subjItems => {
      const chunkLists = subjItems.map(it => mkChunks([it]));
      if (subjItems[0].spread === false) return chunkLists.flat(); // 照章節順序
      const out = []; let added = true;                            // 章節打散：輪流
      while (added) { added = false; for (const cl of chunkLists) if (cl.length) { out.push(cl.shift()); added = true; } }
      return out;
    });
    const out = []; let added = true;
    while (added) { added = false; for (const q2 of subjQueues) if (q2.length) { out.push(q2.shift()); added = true; } }
    return out;
  }

  const firstsQ = buildQueue(items.filter(i => i.first && !i.final));  // 要先完成的
  const work = buildQueue(items.filter(i => !i.first && !i.final));
  const finals = mkChunks(items.filter(i => i.final));

  const blocks = [];
  const failed = [];
  days.forEach(d => { d.load = 0; }); // 每日已排讀書分鐘數 → 用來平均分配

  function tryDay(day, w) {
    while (day.slotIdx < day.slots.length) {
      const [, end] = day.slots[day.slotIdx];
      if (day.pos + w.chunk <= end) {
        blocks.push({ subject_id: w.subject_id, title: w.title, date: day.date, start_time: toHM(day.pos), end_time: toHM(day.pos + w.chunk) });
        day.pos += w.chunk + BREAK;
        day.load += w.chunk;
        if (day.pos >= end) { day.slotIdx++; day.pos = day.slots[day.slotIdx]?.[0] ?? null; }
        return true;
      }
      day.slotIdx++;
      day.pos = day.slots[day.slotIdx]?.[0] ?? null;
    }
    return false;
  }

  function place(w, minDate) {
    let pool = days.filter(d => d.date >= w.start && d.date <= w.end && (!minDate || d.date >= minDate));
    if (!pool.length) pool = days.filter(d => d.date >= w.start && d.date <= w.end);
    // 負載平衡：優先放到目前讀書量最少的那天（同量取較早的日期）
    pool = [...pool].sort((a, b) => a.load - b.load || a.date.localeCompare(b.date));
    for (const day of pool) if (tryDay(day, w)) return true;
    return false;
  }

  for (const w of firstsQ) if (!place(w)) failed.push(w.title); // 先完成的最先排（自然落在最早的日期）
  for (const w of work) if (!place(w)) failed.push(w.title);
  // 壓軸：排在所有一般項目最後一天之後（若其範圍允許）
  const lastNormal = blocks.reduce((a, b) => b.date > a ? b.date : a, '0000');
  for (const w of finals) if (!place(w, lastNormal)) failed.push(w.title);

  blocks.sort((a, b) => a.date === b.date ? a.start_time.localeCompare(b.start_time) : a.date.localeCompare(b.date));
  res.json({
    blocks, unplaced: failed.length > 0,
    message: failed.length ? `空檔不足，排不進去：${[...new Set(failed)].slice(0, 5).join('、')}${failed.length > 5 ? '…' : ''}（請延長日期或減少內容）` : undefined,
  });
});

export default router;
