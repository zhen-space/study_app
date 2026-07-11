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
  const { items, excludeWeekdays = [], excludeDates = [], skipIfBusyHours = 0, timed = true, perDay = 3, pace = 'even' } = req.body;
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
      if (!timed) { out.push({ ...it, chunk: 0 }); continue; } // 不計時：一項就是一個單位
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
  const finals = buildQueue(items.filter(i => i.final));               // 壓軸也照順序

  const blocks = [];
  const failed = [];
  days.forEach(d => { d.load = 0; d.count = 0; d.subs = new Set(); }); // load=分鐘數 count=項數 subs=當天已排科目

  // 這一天塞不塞得下這個 chunk（timed 才需要判斷時間）
  function fits(day, w) {
    if (!timed) return day.slots.length > 0;
    let idx = day.slotIdx, pos = day.pos;
    while (idx < day.slots.length) {
      if (pos + w.chunk <= day.slots[idx][1]) return true;
      idx++; pos = day.slots[idx]?.[0] ?? null;
    }
    return false;
  }
  // 真的排進去
  function put(day, w) {
    if (!timed) {
      if (!day.slots.length) return false;
      blocks.push({ subject_id: w.subject_id, title: w.title, date: day.date });
      day.count++; day.load++; day.subs.add(w.subject_id);
      return true;
    }
    while (day.slotIdx < day.slots.length) {
      const end = day.slots[day.slotIdx][1];
      if (day.pos + w.chunk <= end) {
        blocks.push({ subject_id: w.subject_id, title: w.title, date: day.date, start_time: toHM(day.pos), end_time: toHM(day.pos + w.chunk) });
        day.pos += w.chunk + BREAK; day.load += w.chunk; day.count++; day.subs.add(w.subject_id);
        if (day.pos >= end) { day.slotIdx++; day.pos = day.slots[day.slotIdx]?.[0] ?? null; }
        return true;
      }
      day.slotIdx++; day.pos = day.slots[day.slotIdx]?.[0] ?? null;
    }
    return false;
  }
  const eligible = (w, minDate, maxDate) => {
    const base = days.filter(d => d.date >= w.start && d.date <= w.end
      && (!minDate || d.date >= minDate) && (!maxDate || d.date <= maxDate));
    return base.length ? base : days.filter(d => d.date >= w.start && d.date <= w.end);
  };

  // 平均分配（一科一科分）：每科用「項數 ÷ 可排天數」得到每日速率，把該科平均鋪滿
  // 整個日期範圍，再換下一科。這樣每科都會用到全部日子，不會某科擠前面、某科擠後面。
  // pace='front' 盡早排完：改用約 6 成天數消化，前面的日子塞多一點、後面留空。
  const front = pace === 'front';
  function distribute(queue, minDate, maxDate) {
    if (!queue.length) return;
    // 以「科目＋日期範圍」分組：同一科不同題型組可各有自己的日期範圍（如例題排前段、
    // 練習排後段），各組在自己的範圍內平均鋪滿，互不干擾。
    const groups = {};
    queue.forEach(w => { const key = `${w.subject_id}|${w.start}|${w.end}`; (groups[key] = groups[key] || []).push(w); });
    for (const list of Object.values(groups)) {
      const n = list.length;
      const daySet = new Set();
      list.forEach(w => eligible(w, minDate, maxDate).forEach(d => daySet.add(d.date)));
      const D = days.filter(d => daySet.has(d.date));           // 這組可排的日子（已依日期排序）
      if (!D.length) { list.forEach(w => failed.push(w.title)); continue; } // 範圍內沒有可排的日子
      const m = D.length;
      const keepOrder = list[0].spread === false;               // 照章節順序：只往後排
      const capOk = day => timed ? true : (perDay > 0 ? day.count < perDay : true);
      const rate = Math.max(1, Math.ceil(n / Math.max(1, Math.ceil(m * 0.6)))); // front 用的速率
      let lastIdx = 0;
      list.forEach((w, k) => {
        const ti = Math.min(m - 1, front ? Math.floor(k / rate) : Math.floor(k * m / n)); // 目標日子索引
        const start = keepOrder ? Math.max(ti, lastIdx) : ti;
        let done = false;
        // 從目標日往後找塞得下、未超過每日上限的日子
        for (let i = start; i < m && !done; i++) if (capOk(D[i]) && fits(D[i], w)) { put(D[i], w); lastIdx = i; done = true; }
        // 打散科目：往前找
        if (!done && !keepOrder) for (let i = start - 1; i >= 0 && !done; i--) if (capOk(D[i]) && fits(D[i], w)) { put(D[i], w); done = true; }
        // 放寬每日上限，往後找（維持章節順序）
        if (!done) for (let i = start; i < m && !done; i++) if (fits(D[i], w)) { put(D[i], w); lastIdx = i; done = true; }
        if (!done && !keepOrder) for (let i = start - 1; i >= 0 && !done; i--) if (fits(D[i], w)) { put(D[i], w); done = true; }
        if (!done) failed.push(w.title);
      });
    }
  }

  // 壓軸（模考、學測實驗必考重點等）要「絕對排最後」，所以先按項數比例
  // 幫壓軸保留尾端的日子，一般項目只能排到保留日之前，壓軸再平均鋪在尾端。
  // 否則一般項目鋪滿到截止日時，壓軸會全部擠在最後一天、甚至排不進去。
  let normalMax = null;
  if (finals.length && (firstsQ.length + work.length)) {
    const F = finals.length, W = firstsQ.length + work.length;
    const nF = Math.max(1, Math.min(F, Math.min(days.length - 1, Math.round(days.length * F / (F + W)))));
    normalMax = days[days.length - nF - 1].date;
  }
  distribute(firstsQ, null, normalMax);   // 先完成的最先排
  distribute(work, null, normalMax);      // 一般項目：平均分配、照章節順序（讓出尾端）
  const lastNormal = blocks.reduce((a, b) => b.date > a ? b.date : a, '0000');
  const afterDay = days.find(d => d.date > lastNormal);
  distribute(finals, afterDay ? afterDay.date : lastNormal);

  blocks.sort((a, b) => a.date === b.date ? (a.start_time || '').localeCompare(b.start_time || '') : a.date.localeCompare(b.date));
  res.json({
    blocks, unplaced: failed.length > 0,
    message: failed.length ? `空檔不足，排不進去：${[...new Set(failed)].slice(0, 5).join('、')}${failed.length > 5 ? '…' : ''}（請延長日期或減少內容）` : undefined,
  });
});

export default router;
