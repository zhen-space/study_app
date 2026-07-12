import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const parseTask = t => ({ ...t, tags: JSON.parse(t.tags), subtasks: JSON.parse(t.subtasks) });

// 每個 (kind, ref) 只發一次金幣，避免反覆勾選刷幣
async function award(userId, kind, refId, coins, refKey = '') {
  const r = await q.run('INSERT OR IGNORE INTO coin_awards (user_id,kind,ref_id,ref_key,coins) VALUES (?,?,?,?,?)',
    [userId, kind, refId, refKey, coins]);
  if (r.changes) await q.run('UPDATE users SET coins=coins+?, coins_total=coins_total+? WHERE id=?', [coins, coins, userId]);
  return r.changes ? coins : 0;
}

export const SHOP = [
  { id: 'hat', emoji: '🎩', name: '紳士帽', price: 50 },
  { id: 'bow', emoji: '🎀', name: '蝴蝶結', price: 30 },
  { id: 'glasses', emoji: '🕶️', name: '墨鏡', price: 40 },
  { id: 'ball', emoji: '⚽', name: '玩具球', price: 40 },
  { id: 'flower', emoji: '🌻', name: '向日葵', price: 60 },
  { id: 'house', emoji: '🏠', name: '小屋', price: 200 },
  { id: 'garden', emoji: '🌳', name: '花園', price: 150 },
  { id: 'castle', emoji: '🏰', name: '城堡', price: 500 },
];

// ---- lists ----
router.get('/lists', async (req, res) =>
  res.json(await q.all('SELECT * FROM lists WHERE user_id=? ORDER BY order_index, id', [req.userId])));
router.post('/lists', async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入名稱' });
  const r = await q.run('INSERT INTO lists (user_id,name,color) VALUES (?,?,?)', [req.userId, name, color || '#4772fa']);
  res.json({ id: r.lastInsertRowid });
});
router.patch('/lists/:id', async (req, res) => {
  const { name, color } = req.body;
  await q.run('UPDATE lists SET name=COALESCE(?,name), color=COALESCE(?,color) WHERE id=? AND user_id=?',
    [name ?? null, color ?? null, req.params.id, req.userId]);
  res.json({ ok: true });
});
router.delete('/lists/:id', async (req, res) => {
  await q.run('DELETE FROM lists WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// ---- tasks ----
router.get('/tasks', async (req, res) => {
  const rows = await q.all('SELECT * FROM tasks WHERE user_id=? ORDER BY order_index, id DESC', [req.userId]);
  // miss_policy=drop 的重複任務：過期沒做就自動滾到下一次（不留逾期）
  const todayStr = new Date().toISOString().slice(0, 10);
  for (const t of rows) {
    if (t.recurring && !t.completed && !t.deleted && t.miss_policy === 'drop' && t.due_date && t.due_date < todayStr) {
      let nd = t.due_date, guard = 0;
      while (nd && nd < todayStr && guard++ < 400) nd = nextDate(nd, t.recurring);
      if (nd) { await q.run('UPDATE tasks SET due_date=? WHERE id=?', [nd, t.id]); t.due_date = nd; }
    }
  }
  res.json(rows.map(parseTask));
});

router.post('/tasks', async (req, res) => {
  const { title, list_id, notes, due_date, due_time, priority, tags, subtasks, recurring, miss_policy } = req.body;
  if (!title) return res.status(400).json({ error: '請輸入標題' });
  const r = await q.run(`INSERT INTO tasks (user_id,list_id,title,notes,due_date,due_time,priority,tags,subtasks,recurring,miss_policy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [req.userId, list_id || null, title, notes || '', due_date || null, due_time || null,
      priority || 0, JSON.stringify(tags || []), JSON.stringify(subtasks || []), recurring || null, miss_policy || 'keep']);
  res.json(parseTask(await q.get('SELECT * FROM tasks WHERE id=?', [r.lastInsertRowid])));
});

// 重複規則：daily/weekly/monthly/yearly/weekdays 或自訂 JSON {"every":2,"unit":"week","days":[1,3,5]}
function nextDate(dateStr, rule) {
  const d = new Date(dateStr + 'T00:00:00');
  const iso = x => x.toISOString().slice(0, 10);
  if (rule === 'daily') { d.setDate(d.getDate() + 1); return iso(d); }
  if (rule === 'weekly') { d.setDate(d.getDate() + 7); return iso(d); }
  if (rule === 'monthly') { d.setMonth(d.getMonth() + 1); return iso(d); }
  if (rule === 'yearly') { d.setFullYear(d.getFullYear() + 1); return iso(d); }
  if (rule === 'weekdays') { // 週一至週五
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
    return iso(d);
  }
  if (rule && rule.startsWith('{')) {
    let cfg;
    try { cfg = JSON.parse(rule); } catch { return null; }
    const every = Math.max(1, cfg.every || 1);
    if (cfg.unit === 'day') { d.setDate(d.getDate() + every); return iso(d); }
    if (cfg.unit === 'month') { d.setMonth(d.getMonth() + every); return iso(d); }
    if (cfg.unit === 'year') { d.setFullYear(d.getFullYear() + every); return iso(d); }
    // week：每 N 週的指定星期（以起始日的當週為第 0 週）
    const days = cfg.days?.length ? cfg.days : [d.getDay()];
    const week0 = new Date(d); week0.setDate(d.getDate() - d.getDay());
    for (let i = 1; i <= 7 * every + 7; i++) {
      const c = new Date(d); c.setDate(d.getDate() + i);
      if (!days.includes(c.getDay())) continue;
      const wk = Math.round((c - week0) / (7 * 864e5) - ((c.getDay() ? 0 : 0)));
      if (Math.floor((c - week0) / (7 * 864e5)) % every !== 0) continue;
      return iso(c);
    }
    return null;
  }
  return null;
}

router.patch('/tasks/:id', async (req, res) => {
  const t = await q.get('SELECT * FROM tasks WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  if (!t) return res.status(404).json({ error: 'not found' });
  const b = req.body;
  const f = {
    list_id: b.list_id !== undefined ? b.list_id : t.list_id,
    title: b.title ?? t.title,
    notes: b.notes ?? t.notes,
    due_date: b.due_date !== undefined ? b.due_date : t.due_date,
    due_time: b.due_time !== undefined ? b.due_time : t.due_time,
    priority: b.priority ?? t.priority,
    tags: b.tags !== undefined ? JSON.stringify(b.tags) : t.tags,
    subtasks: b.subtasks !== undefined ? JSON.stringify(b.subtasks) : t.subtasks,
    recurring: b.recurring !== undefined ? b.recurring : t.recurring,
    miss_policy: b.miss_policy ?? t.miss_policy ?? 'keep',
    completed: b.completed !== undefined ? (b.completed ? 1 : 0) : t.completed,
    completed_at: b.completed !== undefined ? (b.completed ? new Date().toISOString() : null) : t.completed_at,
    order_index: b.order_index ?? t.order_index,
    deleted: b.deleted !== undefined ? (b.deleted ? 1 : 0) : (t.deleted || 0),
  };
  await q.run(`UPDATE tasks SET list_id=?,title=?,notes=?,due_date=?,due_time=?,priority=?,tags=?,subtasks=?,
    recurring=?,miss_policy=?,completed=?,completed_at=?,order_index=?,deleted=? WHERE id=?`,
    [f.list_id, f.title, f.notes, f.due_date, f.due_time, f.priority, f.tags, f.subtasks,
      f.recurring, f.miss_policy, f.completed, f.completed_at, f.order_index, f.deleted, t.id]);

  if (b.completed && !t.completed && t.recurring && t.due_date) {
    const nd = nextDate(t.due_date, t.recurring);
    if (nd) await q.run(`INSERT INTO tasks (user_id,list_id,title,notes,due_date,due_time,priority,tags,subtasks,recurring)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.userId, t.list_id, t.title, t.notes, nd, t.due_time, t.priority, t.tags,
        JSON.stringify(JSON.parse(t.subtasks).map(s => ({ ...s, done: false }))), t.recurring]);
  }
  let earned = 0;
  if (b.completed && !t.completed) earned = await award(req.userId, 'task', t.id, 10);
  res.json({ ok: true, earned });
});
router.delete('/tasks/:id', async (req, res) => {
  // 預設軟刪除進垃圾桶；?hard=1 才真的刪
  if (req.query.hard) await q.run('DELETE FROM tasks WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  else await q.run('UPDATE tasks SET deleted=1 WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});
// 清空垃圾桶
router.delete('/trash', async (req, res) => {
  const r = await q.run('DELETE FROM tasks WHERE user_id=? AND deleted=1', [req.userId]);
  res.json({ removed: r.rowsAffected ?? 0 });
});
// 清掉上一次讀書計劃建立的待辦（已完成的保留當紀錄），建立新排程前呼叫
router.delete('/plan-tasks', async (req, res) => {
  const r = await q.run(`DELETE FROM tasks WHERE user_id=? AND completed=0 AND tags LIKE '%讀書計劃%'`, [req.userId]);
  res.json({ removed: r.rowsAffected ?? 0 });
});

// ---- habits ----
router.get('/habits', async (req, res) => {
  const habits = await q.all('SELECT * FROM habits WHERE user_id=?', [req.userId]);
  const checkins = await q.all('SELECT c.* FROM habit_checkins c JOIN habits h ON h.id=c.habit_id WHERE h.user_id=?', [req.userId]);
  res.json(habits.map(h => ({ ...h, days: JSON.parse(h.days), checkins: checkins.filter(c => c.habit_id === h.id).map(c => c.date) })));
});
router.post('/habits', async (req, res) => {
  const { name, icon, color, days, miss_policy, category } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入名稱' });
  const r = await q.run('INSERT INTO habits (user_id,name,icon,color,days,miss_policy,category) VALUES (?,?,?,?,?,?,?)',
    [req.userId, name, icon || '⭐', color || '#16a34a', JSON.stringify(days || [0, 1, 2, 3, 4, 5, 6]), miss_policy || 'drop', category || '']);
  res.json({ id: r.lastInsertRowid });
});
router.patch('/habits/:id', async (req, res) => {
  const h = await q.get('SELECT id FROM habits WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  if (!h) return res.status(404).json({ error: 'not found' });
  const allowed = ['name', 'icon', 'color', 'miss_policy', 'category'];
  for (const k of allowed) if (k in req.body) await q.run(`UPDATE habits SET ${k}=? WHERE id=?`, [req.body[k], h.id]);
  res.json({ ok: true });
});
router.delete('/habits/:id', async (req, res) => {
  await q.run('DELETE FROM habits WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});
router.post('/habits/:id/checkin', async (req, res) => {
  const h = await q.get('SELECT id FROM habits WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  if (!h) return res.status(404).json({ error: 'not found' });
  const { date, undo } = req.body;
  let earned = 0;
  if (undo) await q.run('DELETE FROM habit_checkins WHERE habit_id=? AND date=?', [h.id, date]);
  else {
    await q.run('INSERT OR IGNORE INTO habit_checkins (habit_id,date) VALUES (?,?)', [h.id, date]);
    earned = await award(req.userId, 'habit', h.id, 5, date);
  }
  res.json({ ok: true, earned });
});

// ---- pomodoro ----
router.get('/pomo', async (req, res) =>
  res.json(await q.all(`SELECT p.*, t.title AS task_title FROM pomo_sessions p
    LEFT JOIN tasks t ON t.id=p.task_id WHERE p.user_id=? ORDER BY p.id DESC LIMIT 50`, [req.userId])));
router.post('/pomo', async (req, res) => {
  const { task_id, minutes, date } = req.body;
  const r = await q.run('INSERT INTO pomo_sessions (user_id,task_id,date,minutes) VALUES (?,?,?,?)',
    [req.userId, task_id || null, date || new Date().toISOString().slice(0, 10), minutes || 25]);
  const earned = await award(req.userId, 'pomo', r.lastInsertRowid, Math.max(2, Math.round((minutes || 25) / 5)));
  res.json({ ok: true, earned });
});

// ---- pet & shop ----
router.get('/pet', async (req, res) => {
  const u = await q.get('SELECT coins, coins_total, pet FROM users WHERE id=?', [req.userId]);
  res.json({ coins: u.coins, coins_total: u.coins_total, pet: JSON.parse(u.pet || '{}'), shop: SHOP });
});
router.patch('/pet', async (req, res) => {
  const u = await q.get('SELECT pet FROM users WHERE id=?', [req.userId]);
  const pet = { ...JSON.parse(u.pet || '{}'), ...req.body };
  await q.run('UPDATE users SET pet=? WHERE id=?', [JSON.stringify(pet), req.userId]);
  res.json({ ok: true });
});
router.post('/shop/buy', async (req, res) => {
  const item = SHOP.find(i => i.id === req.body.id);
  if (!item) return res.status(400).json({ error: '沒有這個商品' });
  const u = await q.get('SELECT coins, pet FROM users WHERE id=?', [req.userId]);
  const pet = JSON.parse(u.pet || '{}');
  pet.owned = pet.owned || [];
  if (pet.owned.includes(item.id)) return res.status(400).json({ error: '已經擁有了' });
  if (u.coins < item.price) return res.status(400).json({ error: '金幣不足' });
  pet.owned.push(item.id);
  await q.run('UPDATE users SET coins=coins-?, pet=? WHERE id=?', [item.price, JSON.stringify(pet), req.userId]);
  res.json({ ok: true });
});

// ---- filters ----
router.get('/filters', async (req, res) =>
  res.json((await q.all('SELECT * FROM filters WHERE user_id=?', [req.userId])).map(f => ({ ...f, rule: JSON.parse(f.rule) }))));
router.post('/filters', async (req, res) => {
  const { name, rule } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入名稱' });
  const r = await q.run('INSERT INTO filters (user_id,name,rule) VALUES (?,?,?)', [req.userId, name, JSON.stringify(rule || {})]);
  res.json({ id: r.lastInsertRowid });
});
router.delete('/filters/:id', async (req, res) => {
  await q.run('DELETE FROM filters WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// ---- stats ----
router.get('/tstats', async (req, res) => {
  const tasks = await q.all('SELECT completed, completed_at FROM tasks WHERE user_id=?', [req.userId]);
  const pomo = await q.all('SELECT date, SUM(minutes) m FROM pomo_sessions WHERE user_id=? GROUP BY date', [req.userId]);
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
