import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ---- settings (sleep/meals) ----
router.get('/settings', async (req, res) => {
  const u = await q.get('SELECT sleep_start, sleep_end, meal_windows, custom_tags FROM users WHERE id=?', [req.userId]);
  let ct = []; try { ct = JSON.parse(u.custom_tags || '[]'); } catch {}
  res.json({ ...u, meal_windows: JSON.parse(u.meal_windows), custom_tags: Array.isArray(ct) ? ct : [] });
});
router.put('/settings', async (req, res) => {
  const { sleep_start, sleep_end, meal_windows, custom_tags } = req.body;
  if (custom_tags !== undefined) {
    await q.run('UPDATE users SET custom_tags=? WHERE id=?', [JSON.stringify(custom_tags || []), req.userId]);
    if (sleep_start === undefined) return res.json({ ok: true }); // 只更新標籤
  }
  await q.run('UPDATE users SET sleep_start=?, sleep_end=?, meal_windows=? WHERE id=?',
    [sleep_start, sleep_end, JSON.stringify(meal_windows), req.userId]);
  res.json({ ok: true });
});

// ---- fixed events ----
router.get('/events', async (req, res) => {
  res.json(await q.all('SELECT * FROM fixed_events WHERE user_id=? ORDER BY date, start_time', [req.userId]));
});
router.post('/events', async (req, res) => {
  const { title, date, start_time, end_time, recurring, location, color } = req.body;
  if (!title || !date || !start_time || !end_time) return res.status(400).json({ error: '欄位不完整' });
  const r = await q.run('INSERT INTO fixed_events (user_id,title,date,start_time,end_time,recurring,location,color) VALUES (?,?,?,?,?,?,?,?)',
    [req.userId, title, date, start_time, end_time, recurring || null, location || '', color || '']);
  res.json({ id: r.lastInsertRowid });
});
// 改行程（顏色、標題等）；recurring 行程改色會套用到同名同時段的所有筆
router.patch('/events/:id', async (req, res) => {
  const ev = await q.get('SELECT * FROM fixed_events WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  if (!ev) return res.status(404).json({ error: 'not found' });
  const { color, title, location, start_time, end_time } = req.body;
  if (req.body.applyAll) {
    // 每週重複：套用到同名同時段的每一筆（用「原本」的時段比對）
    await q.run('UPDATE fixed_events SET color=COALESCE(?,color), title=COALESCE(?,title), location=COALESCE(?,location), start_time=COALESCE(?,start_time), end_time=COALESCE(?,end_time) WHERE user_id=? AND title=? AND start_time=? AND end_time=?',
      [color ?? null, title ?? null, location ?? null, start_time ?? null, end_time ?? null, req.userId, ev.title, ev.start_time, ev.end_time]);
  } else {
    await q.run('UPDATE fixed_events SET color=COALESCE(?,color), title=COALESCE(?,title), location=COALESCE(?,location), start_time=COALESCE(?,start_time), end_time=COALESCE(?,end_time) WHERE id=? AND user_id=?',
      [color ?? null, title ?? null, location ?? null, start_time ?? null, end_time ?? null, req.params.id, req.userId]);
  }
  res.json({ ok: true });
});
router.delete('/events/:id', async (req, res) => {
  await q.run('DELETE FROM fixed_events WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});
// 批次匯入：一個請求完成「刪掉被取代日期的舊行程＋加入全部新行程」（逐筆打 API 太慢）
router.post('/events/bulk', async (req, res) => {
  const { events = [], replaceDates = [], replaceWeekdays = [] } = req.body;
  if (!events.length) return res.status(400).json({ error: '沒有行程' });
  for (const ev of events) {
    if (!ev.title || !ev.date || !ev.start_time || !ev.end_time) return res.status(400).json({ error: `「${ev.title || '未命名'}」欄位不完整` });
  }
  const stmts = [];
  // 刪掉被取代的：單次行程比日期、每週行程比星期
  if (replaceDates.length || replaceWeekdays.length) {
    const all = await q.all('SELECT id, date, recurring FROM fixed_events WHERE user_id=?', [req.userId]);
    const dSet = new Set(replaceDates), wSet = new Set(replaceWeekdays);
    for (const ev of all) {
      const dow = new Date(ev.date + 'T00:00:00').getDay();
      if (ev.recurring ? wSet.has(dow) : dSet.has(ev.date)) {
        stmts.push(['DELETE FROM fixed_events WHERE id=?', [ev.id]]);
      }
    }
  }
  for (const ev of events) {
    stmts.push(['INSERT INTO fixed_events (user_id,title,date,start_time,end_time,recurring,location,color) VALUES (?,?,?,?,?,?,?,?)',
      [req.userId, ev.title, ev.date, ev.start_time, ev.end_time, ev.recurring || null, ev.location || '', ev.color || '']]);
  }
  await q.batch(stmts);   // 全部一個來回寫入
  res.json({ added: events.length });
});

export default router;
