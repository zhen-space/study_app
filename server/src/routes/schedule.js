import { Router } from 'express';
import { db } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function freeSlotsForDay(dateStr, events, settings) {
  // busy intervals in minutes
  const busy = [];
  const sleepStart = toMin(settings.sleep_start); // e.g. 23:00
  const sleepEnd = toMin(settings.sleep_end);     // e.g. 07:00
  if (sleepStart > sleepEnd) { // crosses midnight
    busy.push([0, sleepEnd], [sleepStart, 1440]);
  } else {
    busy.push([sleepStart, sleepEnd]);
  }
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
    if (a - cur >= 30) free.push([cur, a]); // ignore gaps < 30min
    cur = Math.max(cur, b);
  }
  if (1440 - cur >= 30) free.push([cur, 1440]);
  return free;
}

// POST /api/schedule/preview  { startDate, endDate, items:[{subject_id, title, minutes}], mode:'order'|'spread', dailyMax? }
router.post('/preview', (req, res) => {
  const { startDate, endDate, items, mode } = req.body;
  if (!startDate || !endDate || !items?.length) return res.status(400).json({ error: '參數不完整' });

  const u = db.prepare('SELECT sleep_start, sleep_end, meal_windows FROM users WHERE id=?').get(req.userId);
  const settings = { ...u, meal_windows: JSON.parse(u.meal_windows) };
  if (req.body.sleep_start) settings.sleep_start = req.body.sleep_start;
  if (req.body.sleep_end) settings.sleep_end = req.body.sleep_end;
  const events = db.prepare('SELECT * FROM fixed_events WHERE user_id=?').all(req.userId);

  // build day list with free slots
  const days = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let d = new Date(startDate + 'T00:00:00'); ; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    if (ds > endDate) break;
    if (ds < today) continue;
    days.push({ date: ds, slots: freeSlotsForDay(ds, events, settings) });
  }
  if (!days.length) return res.status(400).json({ error: '沒有可排的日期' });

  // work queue: chunks of study, each item split into <=90min chunks (with 10min break implied by gap)
  const CHUNK = 90;
  const queue = [];
  for (const it of items) {
    let rem = it.minutes || 120;
    while (rem > 0) {
      const c = Math.min(CHUNK, rem);
      queue.push({ ...it, chunk: rem - c > 0 && rem - c < 30 ? rem : c }); // avoid tiny leftovers
      rem -= queue[queue.length - 1].chunk;
    }
  }

  // 'spread' mode: interleave subjects; 'order': keep as-is
  let work = queue;
  if (mode === 'spread') {
    const groups = {};
    for (const q of queue) (groups[q.subject_id] = groups[q.subject_id] || []).push(q);
    work = [];
    const lists = Object.values(groups);
    let added = true;
    while (added) {
      added = false;
      for (const l of lists) if (l.length) { work.push(l.shift()); added = true; }
    }
  }

  // place chunks into free slots, round-robin across days for spread, sequential for order
  const blocks = [];
  const dayCursors = days.map(d => ({ ...d, slotIdx: 0, pos: d.slots[0]?.[0] ?? null }));
  let di = 0;
  const BREAK = 10;

  for (const w of work) {
    let placed = false;
    for (let tries = 0; tries < dayCursors.length && !placed; tries++) {
      const day = dayCursors[(di + tries) % dayCursors.length];
      while (day.slotIdx < day.slots.length) {
        const [, end] = day.slots[day.slotIdx];
        if (day.pos + w.chunk <= end) {
          blocks.push({
            subject_id: w.subject_id, study_range_id: w.study_range_id || null,
            title: w.title, date: day.date,
            start_time: toHM(day.pos), end_time: toHM(day.pos + w.chunk),
          });
          day.pos += w.chunk + BREAK;
          if (day.pos >= end) { day.slotIdx++; day.pos = day.slots[day.slotIdx]?.[0] ?? null; }
          placed = true;
          if (mode === 'spread') di = (di + tries + 1) % dayCursors.length;
          break;
        }
        day.slotIdx++;
        day.pos = day.slots[day.slotIdx]?.[0] ?? null;
      }
    }
    if (!placed) {
      return res.json({ blocks, unplaced: true, message: '空檔不足，部分內容排不進去，請延長日期範圍或減少內容' });
    }
  }
  res.json({ blocks, unplaced: false });
});

// POST /api/schedule/confirm  { blocks:[...], clearRange:{from,to} }
router.post('/confirm', (req, res) => {
  const { blocks, clearRange } = req.body;
  if (!blocks?.length) return res.status(400).json({ error: '沒有排程內容' });
  const tx = db.transaction(() => {
    if (clearRange) {
      db.prepare('DELETE FROM schedule_blocks WHERE user_id=? AND date>=? AND date<=? AND completed=0')
        .run(req.userId, clearRange.from, clearRange.to);
    }
    const ins = db.prepare(`INSERT INTO schedule_blocks
      (user_id, subject_id, study_range_id, date, start_time, end_time) VALUES (?,?,?,?,?,?)`);
    const insRange = db.prepare('INSERT INTO study_ranges (user_id, subject_id, title) VALUES (?,?,?)');
    const rangeIds = {};
    for (const b of blocks) {
      let rid = b.study_range_id;
      if (!rid && b.title) {
        const key = b.subject_id + '|' + b.title;
        if (!rangeIds[key]) rangeIds[key] = insRange.run(req.userId, b.subject_id, b.title).lastInsertRowid;
        rid = rangeIds[key];
      }
      ins.run(req.userId, b.subject_id, rid, b.date, b.start_time, b.end_time);
    }
  });
  tx();
  res.json({ ok: true, count: blocks.length });
});

export default router;
