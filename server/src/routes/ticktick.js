import { Router } from 'express';
import { db } from '../db/init.js';
import '../db/ticktick.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const parseTask = t => ({ ...t, tags: JSON.parse(t.tags), subtasks: JSON.parse(t.subtasks) });

// ---- lists ----
router.get('/lists', (req, res) =>
  res.json(db.prepare('SELECT * FROM lists WHERE user_id=? ORDER BY order_index, id').all(req.userId)));
router.post('/lists', (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入名稱' });
  const r = db.prepare('INSERT INTO lists (user_id,name,color) VALUES (?,?,?)').run(req.userId, name, color || '#4f46e5');
  res.json({ id: r.lastInsertRowid });
});
router.patch('/lists/:id', (req, res) => {
  const { name, color } = req.body;
  db.prepare('UPDATE lists SET name=COALESCE(?,name), color=COALESCE(?,color) WHERE id=? AND user_id=?')
    .run(name, color, req.params.id, req.userId);
  res.json({ ok: true });
});
router.delete('/lists/:id', (req, res) => {
  db.prepare('DELETE FROM lists WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---- tasks ----
router.get('/tasks', (req, res) =>
  res.json(db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY order_index, id DESC').all(req.userId).map(parseTask)));

router.post('/tasks', (req, res) => {
  const { title, list_id, notes, due_date, due_time, priority, tags, subtasks, recurring } = req.body;
  if (!title) return res.status(400).json({ error: '請輸入標題' });
  const r = db.prepare(`INSERT INTO tasks (user_id,list_id,title,notes,due_date,due_time,priority,tags,subtasks,recurring)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(req.userId, list_id || null, title, notes || '', due_date || null, due_time || null,
      priority || 0, JSON.stringify(tags || []), JSON.stringify(subtasks || []), recurring || null);
  res.json(parseTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(r.lastInsertRowid)));
});

function nextDate(dateStr, rule) {
  const d = new Date(dateStr + 'T00:00:00');
  if (rule === 'daily') d.setDate(d.getDate() + 1);
  else if (rule === 'weekly') d.setDate(d.getDate() + 7);
  else if (rule === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (rule === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

router.patch('/tasks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!t) return res.status(404).json({ error: 'not found' });
  const b = req.body;
  const fields = {
    list_id: b.list_id !== undefined ? b.list_id : t.list_id,
    title: b.title ?? t.title,
    notes: b.notes ?? t.notes,
    due_date: b.due_date !== undefined ? b.due_date : t.due_date,
    due_time: b.due_time !== undefined ? b.due_time : t.due_time,
    priority: b.priority ?? t.priority,
    tags: b.tags !== undefined ? JSON.stringify(b.tags) : t.tags,
    subtasks: b.subtasks !== undefined ? JSON.stringify(b.subtasks) : t.subtasks,
    recurring: b.recurring !== undefined ? b.recurring : t.recurring,
    completed: b.completed !== undefined ? (b.completed ? 1 : 0) : t.completed,
    completed_at: b.completed !== undefined ? (b.completed ? new Date().toISOString() : null) : t.completed_at,
    order_index: b.order_index ?? t.order_index,
  };
  db.prepare(`UPDATE tasks SET list_id=@list_id,title=@title,notes=@notes,due_date=@due_date,due_time=@due_time,
    priority=@priority,tags=@tags,subtasks=@subtasks,recurring=@recurring,completed=@completed,
    completed_at=@completed_at,order_index=@order_index WHERE id=${t.id}`).run(fields);

  // recurring: on complete, spawn next occurrence
  if (b.completed && !t.completed && t.recurring && t.due_date) {
    const nd = nextDate(t.due_date, t.recurring);
    if (nd) db.prepare(`INSERT INTO tasks (user_id,list_id,title,notes,due_date,due_time,priority,tags,subtasks,recurring)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(req.userId, t.list_id, t.title, t.notes, nd, t.due_time, t.priority, t.tags,
        JSON.stringify(JSON.parse(t.subtasks).map(s => ({ ...s, done: false }))), t.recurring);
  }
  res.json({ ok: true });
});
router.delete('/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---- habits ----
router.get('/habits', (req, res) => {
  const habits = db.prepare('SELECT * FROM habits WHERE user_id=?').all(req.userId);
  const checkins = db.prepare(`SELECT c.* FROM habit_checkins c JOIN habits h ON h.id=c.habit_id WHERE h.user_id=?`).all(req.userId);
  res.json(habits.map(h => ({ ...h, days: JSON.parse(h.days), checkins: checkins.filter(c => c.habit_id === h.id).map(c => c.date) })));
});
router.post('/habits', (req, res) => {
  const { name, icon, color, days } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入名稱' });
  const r = db.prepare('INSERT INTO habits (user_id,name,icon,color,days) VALUES (?,?,?,?,?)')
    .run(req.userId, name, icon || '⭐', color || '#16a34a', JSON.stringify(days || [0, 1, 2, 3, 4, 5, 6]));
  res.json({ id: r.lastInsertRowid });
});
router.delete('/habits/:id', (req, res) => {
  db.prepare('DELETE FROM habits WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});
router.post('/habits/:id/checkin', (req, res) => {
  const h = db.prepare('SELECT id FROM habits WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!h) return res.status(404).json({ error: 'not found' });
  const { date, undo } = req.body;
  if (undo) db.prepare('DELETE FROM habit_checkins WHERE habit_id=? AND date=?').run(h.id, date);
  else db.prepare('INSERT OR IGNORE INTO habit_checkins (habit_id,date) VALUES (?,?)').run(h.id, date);
  res.json({ ok: true });
});

// ---- pomodoro ----
router.get('/pomo', (req, res) =>
  res.json(db.prepare(`SELECT p.*, t.title AS task_title FROM pomo_sessions p
    LEFT JOIN tasks t ON t.id=p.task_id WHERE p.user_id=? ORDER BY p.id DESC LIMIT 50`).all(req.userId)));
router.post('/pomo', (req, res) => {
  const { task_id, minutes, date } = req.body;
  db.prepare('INSERT INTO pomo_sessions (user_id,task_id,date,minutes) VALUES (?,?,?,?)')
    .run(req.userId, task_id || null, date || new Date().toISOString().slice(0, 10), minutes || 25);
  res.json({ ok: true });
});

// ---- filters ----
router.get('/filters', (req, res) =>
  res.json(db.prepare('SELECT * FROM filters WHERE user_id=?').all(req.userId).map(f => ({ ...f, rule: JSON.parse(f.rule) }))));
router.post('/filters', (req, res) => {
  const { name, rule } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入名稱' });
  const r = db.prepare('INSERT INTO filters (user_id,name,rule) VALUES (?,?,?)').run(req.userId, name, JSON.stringify(rule || {}));
  res.json({ id: r.lastInsertRowid });
});
router.delete('/filters/:id', (req, res) => {
  db.prepare('DELETE FROM filters WHERE id=? AND user_id=?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---- stats ----
router.get('/tstats', (req, res) => {
  const tasks = db.prepare('SELECT completed, completed_at, due_date FROM tasks WHERE user_id=?').all(req.userId);
  const pomo = db.prepare('SELECT date, SUM(minutes) m FROM pomo_sessions WHERE user_id=? GROUP BY date').all(req.userId);
  const days = {};
  for (const t of tasks) {
    if (t.completed && t.completed_at) {
      const d = t.completed_at.slice(0, 10);
      days[d] = (days[d] || 0) + 1;
    }
  }
  res.json({
    total: tasks.length,
    done: tasks.filter(t => t.completed).length,
    completedByDay: days,
    focusByDay: Object.fromEntries(pomo.map(p => [p.date, p.m])),
    focusTotal: pomo.reduce((a, p) => a + p.m, 0),
  });
});

export default router;
