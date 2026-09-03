import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router(); router.use(requireAuth);
const validDate = x => x == null || x === '' || /^\d{4}-\d\d-\d\d$/.test(x);
const mine = (id, userId) => q.get('SELECT * FROM goals WHERE id=? AND user_id=?', [id, userId]);
async function detail(goal, userId) {
  // 取消表示「這件工作不再做」，不應把 Goal 的完成率假性拉低；它不計入
  // 進度分母，也不算完成，但會以獨立數字保留給 UI／歷史說明。
  const plans = await q.all(`SELECT p.*,
    SUM(CASE WHEN t.id IS NOT NULL AND COALESCE(t.cancelled,0)=0 THEN 1 ELSE 0 END) task_count,
    SUM(CASE WHEN t.completed=1 AND COALESCE(t.cancelled,0)=0 THEN 1 ELSE 0 END) completed_task_count,
    SUM(CASE WHEN COALESCE(t.cancelled,0)=1 THEN 1 ELSE 0 END) cancelled_task_count
    FROM plans p LEFT JOIN tasks t ON t.plan_id=p.id AND t.user_id=p.user_id AND COALESCE(t.deleted,0)=0
    WHERE p.user_id=? AND p.goal_id=? AND p.status<>'deleted' GROUP BY p.id ORDER BY p.target_date,p.id`, [userId, goal.id]);
  const total = plans.reduce((n, p) => n + (p.task_count || 0), 0);
  const completed = plans.reduce((n, p) => n + (p.completed_task_count || 0), 0);
  return { ...goal, plans, progress: { total_tasks: total, completed_tasks: completed, percent: total ? Math.round(completed / total * 100) : 0 } };
}
router.get('/goals', async (req, res) => {
  const rows = await q.all('SELECT * FROM goals WHERE user_id=? ORDER BY COALESCE(target_date,created_at),id', [req.userId]);
  res.json(await Promise.all(rows.map(x => detail(x, req.userId))));
});
router.get('/goals/:id', async (req, res) => { const goal = await mine(req.params.id, req.userId); if (!goal) return res.status(404).json({ error: '找不到目標' }); res.json(await detail(goal, req.userId)); });
router.post('/goals', async (req, res) => {
  const b = req.body || {}; if (!String(b.name || '').trim()) return res.status(400).json({ error: '請輸入目標名稱' }); if (!validDate(b.target_date)) return res.status(400).json({ error: '目標日期不正確' });
  const r = await q.run('INSERT INTO goals (user_id,name,description,target_date) VALUES (?,?,?,?)', [req.userId, String(b.name).trim(), b.description || '', b.target_date || null]);
  res.status(201).json(await detail(await mine(r.lastInsertRowid, req.userId), req.userId));
});
router.patch('/goals/:id', async (req, res) => {
  const goal = await mine(req.params.id, req.userId); if (!goal) return res.status(404).json({ error: '找不到目標' }); const b = req.body || {};
  if (b.name != null && !String(b.name).trim()) return res.status(400).json({ error: '請輸入目標名稱' }); if (b.target_date !== undefined && !validDate(b.target_date)) return res.status(400).json({ error: '目標日期不正確' });
  await q.run('UPDATE goals SET name=?,description=?,target_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [b.name == null ? goal.name : String(b.name).trim(), b.description == null ? goal.description : b.description, b.target_date === undefined ? goal.target_date : (b.target_date || null), goal.id]);
  res.json(await detail(await mine(goal.id, req.userId), req.userId));
});
export default router;
