import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizeConstraints, constraintContract } from '../schedule/constraints.js';
const router = Router(); router.use(requireAuth);
async function ownPlan(id, userId) { return q.get('SELECT id FROM plans WHERE id=? AND user_id=?', [id, userId]); }
router.get('/plans/:id/constraints', async (req, res) => {
  if (!await ownPlan(req.params.id, req.userId)) return res.status(404).json({ error: '找不到這個計畫' });
  const row = await q.get('SELECT * FROM plan_constraints WHERE plan_id=? AND user_id=?', [req.params.id, req.userId]);
  res.json(row ? { ...row, intent: JSON.parse(row.intent_json), unsupported: JSON.parse(row.unsupported_json), contract: constraintContract } : { intent: {}, unsupported: [], contract: constraintContract });
});
// AI 或表單都只能呼叫這個「確認後」寫入端點；它不會建立 ScheduleVersion。
router.put('/plans/:id/constraints', async (req, res) => {
  if (!await ownPlan(req.params.id, req.userId)) return res.status(404).json({ error: '找不到這個計畫' });
  const out = normalizeConstraints(req.body?.intent || {});
  await q.run(`INSERT INTO plan_constraints (plan_id,user_id,intent_json,unsupported_json,source_text,confirmed_at,updated_at)
    VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(plan_id) DO UPDATE SET intent_json=excluded.intent_json,unsupported_json=excluded.unsupported_json,source_text=excluded.source_text,confirmed_at=excluded.confirmed_at,updated_at=CURRENT_TIMESTAMP`,
    [Number(req.params.id), req.userId, JSON.stringify(out.supported), JSON.stringify(out.unsupported), req.body?.source_text || '', new Date().toISOString()]);
  res.json({ ...out, confirmed: true, contract: constraintContract });
});
export default router;
