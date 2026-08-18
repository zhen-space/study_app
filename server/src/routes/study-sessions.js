import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const STATUS = new Set(['running', 'paused', 'completed', 'cancelled']);
const SOURCE = new Set(['manual', 'scheduled_block', 'pomo']);
const isoNow = () => new Date().toISOString();
const elapsedMinutes = (start, end = isoNow()) => Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60000));

async function ownTask(userId, taskId) {
  return q.get('SELECT id,plan_id,deleted FROM tasks WHERE id=? AND user_id=?', [taskId, userId]);
}

// GET /api/study-sessions?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/study-sessions', async (req, res) => {
  const where = ['user_id=?']; const args = [req.userId];
  if (/^\d{4}-\d\d-\d\d$/.test(req.query.from || '')) { where.push('started_at>=?'); args.push(`${req.query.from}T00:00:00.000Z`); }
  if (/^\d{4}-\d\d-\d\d$/.test(req.query.to || '')) { where.push('started_at<?'); args.push(`${req.query.to}T23:59:59.999Z`); }
  res.json(await q.all(`SELECT * FROM study_sessions WHERE ${where.join(' AND ')} ORDER BY started_at DESC`, args));
});

// 一個任務同時只能有一個 running session；這是執行中的狀態，不影響歷史 block。
router.post('/study-sessions', async (req, res) => {
  const b = req.body || {};
  const task = await ownTask(req.userId, Number(b.task_id));
  if (!task || task.deleted) return res.status(400).json({ error: '找不到可讀書的任務' });
  if (b.scheduled_block_id != null) {
    const block = await q.get('SELECT id FROM scheduled_blocks WHERE id=? AND user_id=? AND task_id=?', [b.scheduled_block_id, req.userId, task.id]);
    if (!block) return res.status(400).json({ error: '排程區塊不屬於這個任務' });
  }
  const active = await q.get("SELECT * FROM study_sessions WHERE user_id=? AND status='running'", [req.userId]);
  if (active) return res.status(409).json({ error: '已有進行中的讀書計時', session: active });
  const r = await q.run(`INSERT INTO study_sessions (user_id,task_id,scheduled_block_id,started_at,status,source)
    VALUES (?,?,?,?,?,?)`, [req.userId, task.id, b.scheduled_block_id ?? null, isoNow(), 'running', SOURCE.has(b.source) ? b.source : 'manual']);
  res.status(201).json(await q.get('SELECT * FROM study_sessions WHERE id=?', [r.lastInsertRowid]));
});

// PATCH /api/study-sessions/:id：pause/resume/complete/cancel。完成時才固定 actual_minutes。
router.patch('/study-sessions/:id', async (req, res) => {
  const session = await q.get('SELECT * FROM study_sessions WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  if (!session) return res.status(404).json({ error: '找不到讀書紀錄' });
  const status = req.body?.status;
  if (!STATUS.has(status)) return res.status(400).json({ error: '讀書狀態不正確' });
  if (session.status === 'completed' || session.status === 'cancelled') return res.status(409).json({ error: '這筆讀書紀錄已結束' });
  if (status === 'running') {
    const active = await q.get("SELECT id FROM study_sessions WHERE user_id=? AND status='running' AND id<>?", [req.userId, session.id]);
    if (active) return res.status(409).json({ error: '已有進行中的讀書計時' });
  }
  const ends = status === 'completed' || status === 'cancelled';
  const actual = ends ? (Number.isInteger(req.body?.actual_minutes) && req.body.actual_minutes >= 0 ? req.body.actual_minutes : elapsedMinutes(session.started_at)) : session.actual_minutes;
  const end = ends ? isoNow() : null;
  await q.run('UPDATE study_sessions SET status=?,ended_at=?,actual_minutes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, end, actual, session.id]);
  res.json(await q.get('SELECT * FROM study_sessions WHERE id=?', [session.id]));
});

export default router;
