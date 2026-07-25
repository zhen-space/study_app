import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// 舊 bug 產生的碎片標籤（純 1–2 個英文字母，如 ek、ne、l）一律過濾掉
const cleanTags = arr => (Array.isArray(arr) ? arr : []).filter(x => typeof x === 'string' && x.trim() && !/^[a-zA-Z]{1,2}$/.test(x.trim()));

// ---- settings (sleep/meals) ----
router.get('/settings', async (req, res) => {
  const u = await q.get('SELECT sleep_start, sleep_end, meal_windows, custom_tags FROM users WHERE id=?', [req.userId]);
  let ct = []; try { ct = JSON.parse(u.custom_tags || '[]'); } catch {}
  res.json({ ...u, meal_windows: JSON.parse(u.meal_windows), custom_tags: cleanTags(ct) });
});
router.put('/settings', async (req, res) => {
  const { sleep_start, sleep_end, meal_windows, custom_tags } = req.body;
  if (custom_tags !== undefined) {
    await q.run('UPDATE users SET custom_tags=? WHERE id=?', [JSON.stringify(cleanTags(custom_tags)), req.userId]);
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
  const { title, date, start_time, end_time, recurring, location, color, kind } = req.body;
  // 重要日子（kind 有值＝全天標記）沒有時間；一般行程才要時間
  if (!title || !date || (!kind && (!start_time || !end_time))) return res.status(400).json({ error: '欄位不完整' });
  const r = await q.run('INSERT INTO fixed_events (user_id,title,date,start_time,end_time,recurring,location,color,kind) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.userId, title, date, start_time || '00:00', end_time || '00:00', recurring || null, location || '', color || '', kind || '']);
  res.json({ id: r.lastInsertRowid });
});
// 改行程（顏色、標題等）；recurring 行程改色會套用到同名同時段的所有筆
router.patch('/events/:id', async (req, res) => {
  const ev = await q.get('SELECT * FROM fixed_events WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  if (!ev) return res.status(404).json({ error: 'not found' });
  const { color, title, location, start_time, end_time, date, kind, recurring } = req.body;
  // 重要日子（全天標記）：可改類型與每年重複
  if (kind !== undefined || recurring !== undefined) {
    await q.run('UPDATE fixed_events SET kind=COALESCE(?,kind), recurring=? WHERE id=? AND user_id=?',
      [kind ?? null, recurring || null, req.params.id, req.userId]);
  }
  if (req.body.applyAll) {
    // 每週重複：套用到同名同時段的每一筆（用「原本」的時段比對）
    await q.run('UPDATE fixed_events SET color=COALESCE(?,color), title=COALESCE(?,title), location=COALESCE(?,location), start_time=COALESCE(?,start_time), end_time=COALESCE(?,end_time) WHERE user_id=? AND title=? AND start_time=? AND end_time=?',
      [color ?? null, title ?? null, location ?? null, start_time ?? null, end_time ?? null, req.userId, ev.title, ev.start_time, ev.end_time]);
    // 日期（＝每週重複的星期基準）只改被點的這一筆，不然全部會疊在同一天
    if (date) await q.run('UPDATE fixed_events SET date=? WHERE id=? AND user_id=?', [date, req.params.id, req.userId]);
  } else {
    await q.run('UPDATE fixed_events SET color=COALESCE(?,color), title=COALESCE(?,title), location=COALESCE(?,location), start_time=COALESCE(?,start_time), end_time=COALESCE(?,end_time), date=COALESCE(?,date) WHERE id=? AND user_id=?',
      [color ?? null, title ?? null, location ?? null, start_time ?? null, end_time ?? null, date ?? null, req.params.id, req.userId]);
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

// ---- 備忘錄（分類記錄要做的事）----
router.get('/memos', async (req, res) => {
  res.json(await q.all('SELECT * FROM memos WHERE user_id=? ORDER BY order_index, id', [req.userId]));
});
router.post('/memos', async (req, res) => {
  const { content, category, color } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '請輸入內容' });
  const mx = await q.get('SELECT MAX(order_index) AS m FROM memos WHERE user_id=?', [req.userId]);
  const r = await q.run('INSERT INTO memos (user_id,category,content,color,order_index) VALUES (?,?,?,?,?)',
    [req.userId, (category || '').trim(), content.trim(), color || '', (mx?.m ?? -1) + 1]);
  res.json(await q.get('SELECT * FROM memos WHERE id=?', [r.lastInsertRowid]));
});
router.patch('/memos/:id', async (req, res) => {
  const { content, category, color, done, order_index } = req.body;
  await q.run(`UPDATE memos SET content=COALESCE(?,content), category=COALESCE(?,category),
    color=COALESCE(?,color), done=COALESCE(?,done), order_index=COALESCE(?,order_index) WHERE id=? AND user_id=?`,
    [content ?? null, category ?? null, color ?? null, done === undefined ? null : (done ? 1 : 0), order_index ?? null, req.params.id, req.userId]);
  res.json({ ok: true });
});
router.delete('/memos/:id', async (req, res) => {
  await q.run('DELETE FROM memos WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

export default router;
