import { Router } from 'express';
import { db } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ---- settings (sleep/meals) ----
router.get('/settings', (req, res) => {
  const u = db.prepare('SELECT sleep_start, sleep_end, meal_windows FROM users WHERE id=?').get(req.userId);
  res.json({ ...u, meal_windows: JSON.parse(u.meal_windows) });
});
router.put('/settings', (req, res) => {
  const { sleep_start, sleep_end, meal_windows } = req.body;
  db.prepare('UPDATE users SET sleep_start=?, sleep_end=?, meal_windows=? WHERE id=?')
    .run(sleep_start, sleep_end, JSON.stringify(meal_windows), req.userId);
  res.json({ ok: true });
});

// ---- fixed events ----
router.get('/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM fixed_events WHERE user_id=? ORDER BY date, start_time').all(req.userId));
});
router.post('/events', (req, res) => {
  const { title, date, start_time, end_time, recurring } = req.body;
  if (!title || !date || !start_time || !end_time) return res.status(400).json({ error: '欄位不完整' });
  const r = db.prepare('INSERT INTO fixed_events (user_id,title,date,start_time,end_time,recurring) VALUES (?,?,?,?,?,?)')
    .run(req.userId, title, date, start_time, end_time, recurring || null);
  res.json({ id: r.lastInsertRowid });
});
router.delete('/events/:id', (req, res) => {
  db.prepare('DELETE FROM fixed_events WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---- subjects ----
router.get('/subjects', (req, res) => {
  res.json(db.prepare('SELECT * FROM subjects WHERE user_id=?').all(req.userId));
});
router.post('/subjects', (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入科目名稱' });
  const r = db.prepare('INSERT INTO subjects (user_id,name,color) VALUES (?,?,?)')
    .run(req.userId, name, color || '#4f46e5');
  res.json({ id: r.lastInsertRowid });
});
router.delete('/subjects/:id', (req, res) => {
  db.prepare('DELETE FROM subjects WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---- schedule blocks (daily todos) ----
router.get('/blocks', (req, res) => {
  const { from, to } = req.query;
  res.json(db.prepare(`
    SELECT b.*, s.name AS subject_name, s.color, r.title AS range_title
    FROM schedule_blocks b
    JOIN subjects s ON s.id=b.subject_id
    LEFT JOIN study_ranges r ON r.id=b.study_range_id
    WHERE b.user_id=? AND b.date>=? AND b.date<=?
    ORDER BY b.date, b.start_time
  `).all(req.userId, from || '0000', to || '9999'));
});
router.patch('/blocks/:id', (req, res) => {
  db.prepare('UPDATE schedule_blocks SET completed=? WHERE id=? AND user_id=?')
    .run(req.body.completed ? 1 : 0, req.params.id, req.userId);
  res.json({ ok: true });
});
router.delete('/blocks/:id', (req, res) => {
  db.prepare('DELETE FROM schedule_blocks WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---- stats ----
router.get('/stats', (req, res) => {
  const { from, to } = req.query;
  const blocks = db.prepare(`
    SELECT b.*, s.name AS subject_name, s.color FROM schedule_blocks b
    JOIN subjects s ON s.id=b.subject_id
    WHERE b.user_id=? AND b.date>=? AND b.date<=?
  `).all(req.userId, from, to);

  const mins = b => {
    const [h1, m1] = b.start_time.split(':').map(Number);
    const [h2, m2] = b.end_time.split(':').map(Number);
    return (h2 * 60 + m2) - (h1 * 60 + m1);
  };
  const done = blocks.filter(b => b.completed);
  const bySubject = {};
  for (const b of done) {
    bySubject[b.subject_name] = bySubject[b.subject_name] || { minutes: 0, color: b.color };
    bySubject[b.subject_name].minutes += mins(b);
  }

  // streak: consecutive days (ending today or yesterday) with >=1 completed block
  const days = db.prepare(`
    SELECT DISTINCT date FROM schedule_blocks WHERE user_id=? AND completed=1 ORDER BY date DESC
  `).all(req.userId).map(r => r.date);
  let streak = 0;
  const today = new Date();
  const dstr = d => d.toISOString().slice(0, 10);
  let cursor = new Date(today);
  if (!days.includes(dstr(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.includes(dstr(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  res.json({
    totalMinutes: done.reduce((a, b) => a + mins(b), 0),
    bySubject,
    completionRate: blocks.length ? done.length / blocks.length : 0,
    totalTasks: blocks.length,
    doneTasks: done.length,
    streak,
  });
});

export default router;
