import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
const STATUS = new Set(['running', 'paused', 'completed', 'cancelled']);
const SOURCE = new Set(['manual', 'scheduled_block']);
const isoNow = () => new Date().toISOString();
const elapsedMinutes = (start, end = isoNow()) => Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60000));
const readSession = (id, userId) => q.get(`SELECT s.*, COALESCE(t.title,s.task_title_snapshot,'已刪除任務') AS task_title FROM study_sessions s
  LEFT JOIN tasks t ON t.id=s.task_id AND t.user_id=s.user_id WHERE s.id=? AND s.user_id=?`, [id, userId]);

async function ownTask(userId, taskId) {
  return q.get(`SELECT t.id,t.plan_id,t.deleted,t.completed,t.cancelled,t.title,p.status AS plan_status
    FROM tasks t LEFT JOIN plans p ON p.id=t.plan_id AND p.user_id=t.user_id
    WHERE t.id=? AND t.user_id=?`, [taskId, userId]);
}

// GET /api/study-sessions?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/study-sessions', async (req, res) => {
  const where = ['user_id=?']; const args = [req.userId];
  if (/^\d{4}-\d\d-\d\d$/.test(req.query.from || '')) { where.push('started_at>=?'); args.push(`${req.query.from}T00:00:00.000Z`); }
  if (/^\d{4}-\d\d-\d\d$/.test(req.query.to || '')) { where.push('started_at<?'); args.push(`${req.query.to}T23:59:59.999Z`); }
  res.json(await q.all(`SELECT s.*, COALESCE(t.title,s.task_title_snapshot,'已刪除任務') AS task_title FROM study_sessions s LEFT JOIN tasks t ON t.id=s.task_id AND t.user_id=s.user_id WHERE s.${where.join(' AND s.')} ORDER BY s.started_at DESC`, args));
});

// 一個任務同時只能有一個 running session；這是執行中的狀態，不影響歷史 block。
router.post('/study-sessions', async (req, res) => {
  const b = req.body || {};
  const task = await ownTask(req.userId, Number(b.task_id));
  if (!task || task.deleted) return res.status(400).json({ error: '找不到可讀書的任務' });
  if (task.completed || task.cancelled) return res.status(409).json({ error: '已完成或已取消的任務不能開始讀書' });
  if (task.plan_status && !['draft', 'active'].includes(task.plan_status)) return res.status(409).json({ error: '目前未執行的計畫不能開始讀書' });
  if (b.scheduled_block_id != null) {
    const block = await q.get('SELECT id FROM scheduled_blocks WHERE id=? AND user_id=? AND task_id=?', [b.scheduled_block_id, req.userId, task.id]);
    if (!block) return res.status(400).json({ error: '排程區塊不屬於這個任務' });
  }
  const active = await q.get("SELECT * FROM study_sessions WHERE user_id=? AND status IN ('running','paused')", [req.userId]);
  if (active) return res.status(409).json({ error: '已有進行中的讀書計時', session: active });
  const began = isoNow();
  const r = await q.run(`INSERT INTO study_sessions (user_id,task_id,scheduled_block_id,task_title_snapshot,started_at,running_since,status,source)
    VALUES (?,?,?,?,?,?,?,?)`, [req.userId, task.id, b.scheduled_block_id ?? null, task.title, began, began, 'running', SOURCE.has(b.source) ? b.source : 'manual']);
  res.status(201).json(await readSession(r.lastInsertRowid, req.userId));
});

// POST /api/study-sessions/backfill：補登。
//
// 補登＝真的讀了，只是當下沒開計時器，事後補記這段學習紀錄。
// 所以它是**正式的 StudySession**：分鐘數要算進 actual_minutes、今日／本週
// 讀書時間、科目分項，跟即時計時完全一樣。
//
// 但它不是 live session：
//   ・直接以 completed 寫入，不會有 running / paused 的中間狀態
//   ・因此不佔用、也不受「同時只能有一個進行中」的限制——那條 invariant
//     管的是「正在讀」，補登講的是「已經讀完了」
//   ・不碰 Material completion：讀了多久跟教材完成與否是兩件事，
//     actual_minutes > 0 不能推論教材做完了。要標完成走既有 completion 流程。
//   ・不碰 Plan selection、不碰 ScheduledBlock / ScheduleVersion。
//
// 時間：使用者填的是台灣時間的日期與時刻，存進去是 UTC ISO，
// 統計再用 twDayOf 換回台灣的那一天。三邊一致才不會出現「凌晨讀的算前一天」。
const DATE_RE = /^\d{4}-\d\d-\d\d$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_BACKFILL_MINUTES = 24 * 60;

router.post('/study-sessions/backfill', async (req, res) => {
  const b = req.body || {};
  const task = await ownTask(req.userId, Number(b.task_id));
  if (!task || task.deleted) return res.status(400).json({ error: '找不到這個任務' });

  const date = String(b.date || '');
  const startTime = String(b.start_time || '');
  const minutes = Number(b.minutes);
  if (!DATE_RE.test(date)) return res.status(400).json({ error: '日期格式要像 2026-08-23' });
  if (!TIME_RE.test(startTime)) return res.status(400).json({ error: '開始時間格式要像 19:30' });
  if (!Number.isInteger(minutes) || minutes <= 0) return res.status(400).json({ error: '請填實際讀了幾分鐘' });
  if (minutes > MAX_BACKFILL_MINUTES) return res.status(400).json({ error: '一次補登不能超過 24 小時' });

  // 台灣時間 → UTC：減 8 小時。
  const began = new Date(Date.parse(`${date}T${startTime}:00Z`) - 8 * 3600e3);
  if (Number.isNaN(began.getTime())) return res.status(400).json({ error: '時間不正確' });
  const ended = new Date(began.getTime() + minutes * 60000);
  // 補登的是「已經發生的事」，未來的時間不該補得出來。
  if (ended.getTime() > Date.now() + 60000) return res.status(400).json({ error: '不能補登還沒發生的時間' });

  const r = await q.run(`INSERT INTO study_sessions
    (user_id,task_id,scheduled_block_id,task_title_snapshot,started_at,ended_at,actual_minutes,running_since,status,source)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [req.userId, task.id, null, task.title, began.toISOString(), ended.toISOString(), minutes, null, 'completed', 'backfill']);
  res.status(201).json(await readSession(r.lastInsertRowid, req.userId));
});

// PATCH /api/study-sessions/:id：pause/resume/complete/cancel。完成時才固定 actual_minutes。
router.patch('/study-sessions/:id', async (req, res) => {
  const session = await q.get('SELECT * FROM study_sessions WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  if (!session) return res.status(404).json({ error: '找不到讀書紀錄' });
  const status = req.body?.status;
  if (!STATUS.has(status)) return res.status(400).json({ error: '讀書狀態不正確' });
  if (session.status === 'completed' || session.status === 'cancelled') return res.status(409).json({ error: '這筆讀書紀錄已結束' });
  if (status === 'running') {
    const active = await q.get("SELECT id FROM study_sessions WHERE user_id=? AND status IN ('running','paused') AND id<>?", [req.userId, session.id]);
    if (active) return res.status(409).json({ error: '已有進行中的讀書計時' });
  }
  const ends = status === 'completed' || status === 'cancelled';
  const runningMinutes = session.status === 'running' ? elapsedMinutes(session.running_since || session.started_at) : 0;
  const accumulated = (session.actual_minutes || 0) + runningMinutes;
  // pause 立刻結算該段；resume 重新開一段 running_since，避免把暫停時間算進 actual。
  const actual = (ends && Number.isInteger(req.body?.actual_minutes) && req.body.actual_minutes >= 0)
    ? req.body.actual_minutes : (status === 'paused' || ends ? accumulated : session.actual_minutes);
  const end = ends ? isoNow() : null;
  const runningSince = status === 'running' ? isoNow() : null;
  await q.run('UPDATE study_sessions SET status=?,ended_at=?,actual_minutes=?,running_since=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, end, actual, runningSince, session.id]);
  res.json(await readSession(session.id, req.userId));
});

export default router;
