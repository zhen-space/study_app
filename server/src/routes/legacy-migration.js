import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router(); router.use(requireAuth);
// I：使用者只看自己的 legacy 候選資料。這不是 migration runner，完全不寫資料。
router.get('/legacy-migration/preview', async (req, res) => {
  const tasks = await q.all(`SELECT t.id,t.title,t.list_id,t.due_date,t.completed,l.name AS list_name FROM tasks t LEFT JOIN lists l ON l.id=t.list_id
    WHERE t.user_id=? AND t.plan_id IS NULL AND COALESCE(t.deleted,0)=0`, [req.userId]);
  const candidates = tasks.filter(t => String(t.title || '').includes('｜'));
  res.json({ mode: 'preview_only', candidates, warning: '舊任務不會自動被分群、移動或刪除。請建立正式計畫後逐筆確認要加入的任務。' });
});
export default router;
