import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizeConstraints, constraintContract } from '../schedule/constraints.js';
import Anthropic from '@anthropic-ai/sdk';
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
// AI 只做自然語言→structured intent；結果不寫入，必須由下一支 PUT 明確確認。
router.post('/plans/:id/constraints/parse', async (req, res) => {
  if (!await ownPlan(req.params.id, req.userId)) return res.status(404).json({ error: '找不到這個計畫' });
  const source = String(req.body?.source_text || '').trim();
  if (!source) return res.status(400).json({ error: '請輸入想套用的排程條件' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: '伺服器尚未設定 AI 金鑰，請改用手動條件' });
  const lists = await q.all('SELECT id,name FROM lists WHERE user_id=? ORDER BY id', [req.userId]);
  try {
    const response = await new Anthropic().messages.create({
      model: 'claude-opus-4-8', max_tokens: 1000,
      system: `把學生的排程自然語言轉成 JSON。只能輸出 JSON，不可臆測。支援欄位：subject_order（科目 id 陣列）、exclude_weekdays（0=週日..6）、exclude_dates（YYYY-MM-DD）、date_window（{start_date,end_date}）。其他需求一律照原 key 放在 JSON，但不得假稱生效。科目：${JSON.stringify(lists)}。`,
      messages: [{ role: 'user', content: source }],
    });
    const text = response.content.find(x => x.type === 'text')?.text || '{}';
    let intent; try { intent = JSON.parse(text); } catch { return res.status(502).json({ error: 'AI 回傳格式異常，請再試一次' }); }
    res.json({ ...normalizeConstraints(intent), source_text: source, confirmed: false, contract: constraintContract });
  } catch (e) {
    res.status(502).json({ error: `AI 解讀失敗：${String(e.message || '').slice(0, 120)}` });
  }
});
export default router;
