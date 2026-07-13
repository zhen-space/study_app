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
  const { color, title, location } = req.body;
  if (color !== undefined && req.body.applyAll) {
    await q.run('UPDATE fixed_events SET color=? WHERE user_id=? AND title=? AND start_time=? AND end_time=?',
      [color, req.userId, ev.title, ev.start_time, ev.end_time]);
  } else {
    await q.run('UPDATE fixed_events SET color=COALESCE(?,color), title=COALESCE(?,title), location=COALESCE(?,location) WHERE id=? AND user_id=?',
      [color ?? null, title ?? null, location ?? null, req.params.id, req.userId]);
  }
  res.json({ ok: true });
});
router.delete('/events/:id', async (req, res) => {
  await q.run('DELETE FROM fixed_events WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

export default router;
