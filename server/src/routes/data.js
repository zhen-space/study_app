import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ---- settings (sleep/meals) ----
router.get('/settings', async (req, res) => {
  const u = await q.get('SELECT sleep_start, sleep_end, meal_windows FROM users WHERE id=?', [req.userId]);
  res.json({ ...u, meal_windows: JSON.parse(u.meal_windows) });
});
router.put('/settings', async (req, res) => {
  const { sleep_start, sleep_end, meal_windows } = req.body;
  await q.run('UPDATE users SET sleep_start=?, sleep_end=?, meal_windows=? WHERE id=?',
    [sleep_start, sleep_end, JSON.stringify(meal_windows), req.userId]);
  res.json({ ok: true });
});

// ---- fixed events ----
router.get('/events', async (req, res) => {
  res.json(await q.all('SELECT * FROM fixed_events WHERE user_id=? ORDER BY date, start_time', [req.userId]));
});
router.post('/events', async (req, res) => {
  const { title, date, start_time, end_time, recurring, location } = req.body;
  if (!title || !date || !start_time || !end_time) return res.status(400).json({ error: '欄位不完整' });
  const r = await q.run('INSERT INTO fixed_events (user_id,title,date,start_time,end_time,recurring,location) VALUES (?,?,?,?,?,?,?)',
    [req.userId, title, date, start_time, end_time, recurring || null, location || '']);
  res.json({ id: r.lastInsertRowid });
});
router.delete('/events/:id', async (req, res) => {
  await q.run('DELETE FROM fixed_events WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

export default router;
