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

  // 平均分配（逐日發放）：以「科目＋日期範圍」分桶，照日期逐天輪流看每一桶，
  // 按速率（項數÷天數）領量。速率≥1 的科目每天都會出現、速率<1 的等距出現，
  // 某天塞不下就之後立刻補回，不會整串往後推、擠在最後面。
  // pace='front' 盡早排完：速率加快（約 6 成天數消化），前面多排、後面留空。
  const front = pace === 'front';
  // minDate / maxDate 可以是函式（依科目不同）：收到桶的第一個項目，回傳該桶的界線
  function distribute(queue, minDate, maxDate) {
    if (!queue.length) return;
    const capOk = day => timed ? true : (perDay > 0 ? day.count < perDay : true);
    const buckets = [];
    const byKey = {};
    queue.forEach(w => {
      const key = `${w.subject_id}|${w.start}|${w.end}`;
      if (!byKey[key]) { byKey[key] = { list: [] }; buckets.push(byKey[key]); }
      byKey[key].list.push(w);
    });
    for (const b of buckets) {
      const md = typeof minDate === 'function' ? minDate(b.list[0]) : minDate;
      const xd = typeof maxDate === 'function' ? maxDate(b.list[0]) : maxDate;
      b.minDate = md;
      let D = eligible(b.list[0], md, xd);                       // 同桶共用日期範圍
      if (!D.length) {
        // 範圍內完全沒有可排日（範圍設錯、已過期，或全被排除條件蓋掉）：
        // 退回用全部可排日（壓軸仍維持在 minDate 之後），至少排得進去
        D = days.filter(d => !md || d.date >= md);
        if (!D.length) D = days;
      }
      b.dates = new Set(D.map(d => d.date));
      b.rate = (b.list.length / D.length) * (front ? 1 / 0.6 : 1);
      b.err = 0;
    }
    // 主輪：逐天、各桶按速率領量 → 各科每天交錯出現，順序保持
    for (const day of days) {
      for (const b of buckets) {
        if (!b.list.length || !b.dates.has(day.date)) continue;
        b.err += b.rate;
        while (b.err >= 0.999 && b.list.length) {
          const w = b.list[0];
          if (capOk(day) && fits(day, w) && put(day, w)) { b.list.shift(); b.err -= 1; }
          else break;                                            // 今天滿了，額度留著之後補
        }
      }
    }
    // 剩下的（被每日上限/空檔擋住）：照順序找最早塞得下的日子
    for (const b of buckets) {
      let ci = 0;
      for (const w of b.list) {
        let done = false;
        for (let i = ci; i < days.length && !done; i++) {
          if (!b.dates.has(days[i].date)) continue;
          if (fits(days[i], w) && put(days[i], w)) { done = true; ci = i; }
        }
        if (!done) failed.push(`${w.title}〔${w.start}～${w.end}〕`); // 附上範圍，方便看出是哪段日期塞不下
      }
    }
  }

  // 壓軸（模考、學測實驗必考重點等）「排在該科所有一般項目之後」——分科計算：
  // 生物的模考只要等生物的練習/歷屆做完，不用等其他科。這樣壓軸可以從該科
  // 內容結束後就開始平均鋪開（該科每天都會出現），不會全部擠在最後幾天。
  // 先按「該科壓軸÷該科總項數」的比例，幫每科的壓軸保留尾端日子。
  const cntBy = (arr) => arr.reduce((m, w) => (m[w.subject_id] = (m[w.subject_id] || 0) + 1, m), {});
  const finalsBySub = cntBy(finals);
  const normalsBySub = cntBy([...firstsQ, ...work]);
  const normalMaxBySub = {};
  for (const sid of Object.keys(finalsBySub)) {
    const F = finalsBySub[sid], W = normalsBySub[sid] || 0;
    if (!W) continue;
    const nF = Math.max(1, Math.min(F, Math.min(days.length - 1, Math.round(days.length * F / (F + W)))));
    normalMaxBySub[sid] = days[days.length - nF - 1].date;
  }
  const normalMaxFor = w => normalMaxBySub[w.subject_id] ?? null;
  distribute(firstsQ, null, normalMaxFor);   // 先完成的最先排
  distribute(work, null, normalMaxFor);      // 一般項目：平均分配、照章節順序（讓出該科尾端）
  const lastNormalBySub = {};
  blocks.forEach(b => { if (!lastNormalBySub[b.subject_id] || b.date > lastNormalBySub[b.subject_id]) lastNormalBySub[b.subject_id] = b.date; });
  distribute(finals, w => {
    const ln = lastNormalBySub[w.subject_id];
    if (!ln) return null;                    // 這科只有壓軸：全範圍平均排
    const after = days.find(d => d.date > ln);
    return after ? after.date : ln;          // 該科一般項目最後一天的隔天以後
  });

  blocks.sort((a, b) => a.date === b.date ? (a.start_time || '').localeCompare(b.start_time || '') : a.date.localeCompare(b.date));
  res.json({
    blocks, unplaced: failed.length > 0,
    message: failed.length ? `空檔不足，排不進去：${[...new Set(failed)].slice(0, 5).join('、')}${failed.length > 5 ? '…' : ''}（請延長日期或減少內容）` : undefined,
  });
});

export default router;
