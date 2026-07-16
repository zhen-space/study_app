import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// tags/subtasks 一定回傳陣列（曾有存成字串的髒資料，前端 flatMap 會拆成單一字母）
const asArr = s => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
// 過濾掉舊 bug 產生的碎片標籤（純 1–2 個英文小寫字母，如 ek、ne、l）
const cleanTags = arr => arr.filter(x => typeof x === 'string' && x.trim() && !/^[a-zA-Z]{1,2}$/.test(x.trim()));
const parseTask = t => ({ ...t, tags: cleanTags(asArr(t.tags)), subtasks: asArr(t.subtasks) });

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
// 自己的清單＋別人分享給我的清單（shared_in=1、附擁有者 email）
router.get('/lists', async (req, res) => {
  const own = await q.all('SELECT * FROM lists WHERE user_id=? ORDER BY order_index, id', [req.userId]);
  const outIds = new Set((await q.all('SELECT DISTINCT list_id FROM list_shares WHERE owner_id=?', [req.userId])).map(r => r.list_id));
  const sharedIn = await q.all(`SELECT l.*, u.email AS owner_email, 1 AS shared_in FROM list_shares s
    JOIN lists l ON l.id=s.list_id JOIN users u ON u.id=s.owner_id WHERE s.member_id=?`, [req.userId]);
  res.json([...own.map(l => ({ ...l, shared_out: outIds.has(l.id) ? 1 : 0 })), ...sharedIn]);
});
// 分享清單給其他使用者（用 email）
router.get('/lists/:id/shares', async (req, res) => {
  const rows = await q.all(`SELECT s.id, s.member_id, u.email FROM list_shares s JOIN users u ON u.id=s.member_id
    WHERE s.list_id=? AND s.owner_id=?`, [req.params.id, req.userId]);
  res.json(rows);
});
router.post('/lists/:id/share', async (req, res) => {
  const l = await q.get('SELECT * FROM lists WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  if (!l) return res.status(404).json({ error: '找不到清單（只能分享自己的清單）' });
  const u = await q.get('SELECT id FROM users WHERE email=?', [(req.body.email || '').trim().toLowerCase()]);
  if (!u) return res.status(404).json({ error: '找不到這個 email 的使用者（對方要先註冊）' });
  if (u.id === req.userId) return res.status(400).json({ error: '不用分享給自己啦' });
  const dup = await q.get('SELECT id FROM list_shares WHERE list_id=? AND member_id=?', [l.id, u.id]);
  if (!dup) await q.run('INSERT INTO list_shares (list_id,owner_id,member_id) VALUES (?,?,?)', [l.id, req.userId, u.id]);
  res.json({ ok: true });
});
router.delete('/lists/:id/share/:shareId', async (req, res) => {
  await q.run('DELETE FROM list_shares WHERE id=? AND owner_id=?', [req.params.shareId, req.userId]);
  res.json({ ok: true });
});
// 可以動這個任務嗎：自己的，或它屬於分享給我的清單
async function canTouch(uid, t) {
  if (!t) return false;
  if (t.user_id === uid) return true;
  if (!t.list_id) return false;
  return !!(await q.get('SELECT id FROM list_shares WHERE list_id=? AND member_id=?', [t.list_id, uid]));
}
router.post('/lists', async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入名稱' });
  const r = await q.run('INSERT INTO lists (user_id,name,color) VALUES (?,?,?)', [req.userId, name, color || '#0086CC']);
  res.json({ id: r.lastInsertRowid });
});
router.patch('/lists/:id', async (req, res) => {
  const { name, color, icon } = req.body;
  await q.run('UPDATE lists SET name=COALESCE(?,name), color=COALESCE(?,color), icon=COALESCE(?,icon) WHERE id=? AND user_id=?',
    [name ?? null, color ?? null, icon ?? null, req.params.id, req.userId]);
  res.json({ ok: true });
});
router.delete('/lists/:id', async (req, res) => {
  await q.run('DELETE FROM lists WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// ---- tasks ----
router.get('/tasks', async (req, res) => {
  // 自己的任務＋「分享給我的清單」裡的任務
  const rows = await q.all(`SELECT * FROM tasks WHERE user_id=?
    UNION SELECT t.* FROM tasks t JOIN list_shares s ON s.list_id=t.list_id AND s.member_id=?
    ORDER BY order_index, id DESC`, [req.userId, req.userId]);
  // miss_policy=drop 的重複任務：過期沒做就自動滾到下一次（不留逾期）
  const todayStr = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣時區
  for (const t of rows) {
    if (t.user_id === req.userId && t.recurring && !t.completed && !t.deleted && t.miss_policy === 'drop' && t.due_date && t.due_date < todayStr) {
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
  // 新增到「分享給我的清單」時，任務掛在清單擁有者名下（雙方都看得到）
  let ownerId = req.userId;
  if (list_id) {
    const l = await q.get('SELECT user_id FROM lists WHERE id=?', [list_id]);
    if (l && l.user_id !== req.userId) {
      const sh = await q.get('SELECT id FROM list_shares WHERE list_id=? AND member_id=?', [list_id, req.userId]);
      if (!sh) return res.status(403).json({ error: '沒有這個清單的權限' });
      ownerId = l.user_id;
    }
  }
  const r = await q.run(`INSERT INTO tasks (user_id,list_id,title,notes,due_date,due_time,priority,tags,subtasks,recurring,miss_policy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [ownerId, list_id || null, title, notes || '', due_date || null, due_time || null,
      priority || 0, JSON.stringify(cleanTags(asArr(tags || []))), JSON.stringify(subtasks || []), recurring || null, miss_policy || 'keep']);
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
  const t = await q.get('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (!(await canTouch(req.userId, t))) return res.status(404).json({ error: 'not found' });
  const b = req.body;
  const f = {
    list_id: b.list_id !== undefined ? b.list_id : t.list_id,
    title: b.title ?? t.title,
    notes: b.notes ?? t.notes,
    due_date: b.due_date !== undefined ? b.due_date : t.due_date,
    due_time: b.due_time !== undefined ? b.due_time : t.due_time,
    priority: b.priority ?? t.priority,
    tags: b.tags !== undefined ? JSON.stringify(cleanTags(asArr(b.tags))) : t.tags,
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
  const t = await q.get('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (!(await canTouch(req.userId, t))) return res.status(404).json({ error: 'not found' });
  // 預設軟刪除進垃圾桶；?hard=1 才真的刪
  if (req.query.hard) await q.run('DELETE FROM tasks WHERE id=?', [t.id]);
  else await q.run('UPDATE tasks SET deleted=1 WHERE id=?', [t.id]);
  res.json({ ok: true });
});
// 批次建立任務（排程精靈一次建立整份讀書計劃用，逐筆打 API 太慢）
router.post('/tasks/bulk', async (req, res) => {
  const list = (req.body.tasks || []).filter(t => t.title);
  if (!list.length) return res.status(400).json({ error: '沒有任務' });
  await q.batch(list.map(t => [
    `INSERT INTO tasks (user_id,list_id,title,notes,due_date,due_time,priority,tags,subtasks,recurring,miss_policy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [req.userId, t.list_id || null, t.title, t.notes || '', t.due_date || null, t.due_time || null,
      t.priority || 0, JSON.stringify(cleanTags(asArr(t.tags || []))), JSON.stringify(t.subtasks || []), t.recurring || null, t.miss_policy || 'keep'],
  ]));
  res.json({ added: list.length });
});
// 拖曳排序：一次寫入一批任務的順序
router.post('/tasks/reorder', async (req, res) => {
  const ids = req.body.ids || [];
  for (let i = 0; i < ids.length; i++) {
    await q.run('UPDATE tasks SET order_index=? WHERE id=? AND user_id=?', [i, ids[i], req.userId]);
  }
  res.json({ ok: true });
});
// ---- 附件 ----
router.get('/tasks/:id/attachments', async (req, res) => {
  const t = await q.get('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (!(await canTouch(req.userId, t))) return res.status(404).json({ error: 'not found' });
  res.json(await q.all('SELECT id, name, mime, length(data) AS size, created_at FROM attachments WHERE task_id=?', [t.id]));
});
router.post('/tasks/:id/attachments', async (req, res) => {
  const t = await q.get('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (!(await canTouch(req.userId, t))) return res.status(404).json({ error: 'not found' });
  const { name, mime, data } = req.body;
  if (!name || !data) return res.status(400).json({ error: '沒有收到檔案' });
  if (data.length > 4_000_000) return res.status(400).json({ error: '檔案太大（上限約 3MB）' });
  const r = await q.run('INSERT INTO attachments (task_id,user_id,name,mime,data,created_at) VALUES (?,?,?,?,?,?)',
    [t.id, req.userId, name, mime || '', data, new Date().toISOString()]);
  res.json({ id: r.lastInsertRowid });
});
router.get('/attachments/:id', async (req, res) => {
  const a = await q.get('SELECT * FROM attachments WHERE id=?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'not found' });
  const t = await q.get('SELECT * FROM tasks WHERE id=?', [a.task_id]);
  if (!(await canTouch(req.userId, t))) return res.status(404).json({ error: 'not found' });
  res.json(a);
});
router.delete('/attachments/:id', async (req, res) => {
  const a = await q.get('SELECT * FROM attachments WHERE id=?', [req.params.id]);
  if (a) {
    const t = await q.get('SELECT * FROM tasks WHERE id=?', [a.task_id]);
    if (await canTouch(req.userId, t)) await q.run('DELETE FROM attachments WHERE id=?', [a.id]);
  }
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
    [req.userId, task_id || null, date || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), minutes || 25]);
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
  // 年度回顧：本年度每月完成數/專注分鐘、完成最多的清單
  const year = String(new Date().getFullYear());
  const byMonth = Array(12).fill(0), focusByMonth = Array(12).fill(0);
  for (const [d, n] of Object.entries(days)) if (d.startsWith(year)) byMonth[+d.slice(5, 7) - 1] += n;
  for (const p of pomo) if (p.date?.startsWith(year)) focusByMonth[+p.date.slice(5, 7) - 1] += p.m;
  const topLists = await q.all(`SELECT l.name, l.color, COUNT(*) c FROM tasks t JOIN lists l ON l.id=t.list_id
    WHERE t.user_id=? AND t.completed=1 GROUP BY l.id ORDER BY c DESC LIMIT 5`, [req.userId]);
  res.json({
    total: tasks.length,
    done: tasks.filter(t => t.completed).length,
    completedByDay: days,
    focusByDay: Object.fromEntries(pomo.map(p => [p.date, p.m])),
    focusTotal: pomo.reduce((a, p) => a + p.m, 0),
    year: { byMonth, focusByMonth, topLists },
  });
});

export default router;
