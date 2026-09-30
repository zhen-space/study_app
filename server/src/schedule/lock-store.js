import { q } from '../db/init.js';
import { isValidDay } from '../util/date.js';

class LockInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockInputError';
    this.status = 400;
  }
}

const isTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
const uniqueConflict = e => /unique constraint failed/i.test(String(e?.message || e));

const identitySql = type => type === 'task'
  ? ["type='task' AND task_id=?", 'task_id']
  : type === 'day'
    ? ["type='day' AND date=?", 'date']
    : ["type='time' AND date=? AND start_time=? AND end_time=?", 'time'];

async function findLive(db, userId, type, b) {
  const [where] = identitySql(type);
  const args = type === 'task' ? [b.task_id] : type === 'day' ? [b.date] : [b.date, b.start_time, b.end_time];
  return db.get(`SELECT * FROM schedule_locks WHERE user_id=? AND released_at IS NULL AND ${where} ORDER BY id LIMIT 1`, [userId, ...args]);
}

function publicLock(row) {
  return { id: Number(row.id), type: row.type, task_id: row.task_id == null ? undefined : Number(row.task_id),
    date: row.date ?? undefined, start_time: row.start_time ?? undefined, end_time: row.end_time ?? undefined };
}

export async function createScheduleLock(userId, body = {}) {
  const type = body.type;
  if (!['task', 'day', 'time'].includes(type)) throw new LockInputError('鎖定類型不正確');
  const b = { type };
  if (type === 'task') {
    if (!Number.isInteger(Number(body.task_id)) || body.date || body.start_time || body.end_time) throw new LockInputError('Task Lock 只能指定 task_id');
    b.task_id = Number(body.task_id);
  } else {
    if (!isValidDay(body.date || '')) throw new LockInputError('請指定日期');
    b.date = body.date;
    if (type === 'day') {
      if (body.task_id || body.start_time || body.end_time) throw new LockInputError('Day Lock 只能指定日期');
    } else {
      if (body.task_id || !isTime(body.start_time) || !isTime(body.end_time) || body.start_time >= body.end_time) throw new LockInputError('Time Lock 需要有效的開始與結束時間');
      b.start_time = body.start_time; b.end_time = body.end_time;
    }
  }

  try {
    return await q.tx(async tx => {
      const existing = await findLive(tx, userId, type, b);
      if (existing) return { lock: publicLock(existing), created: false };
      if (type === 'task') {
        const state = await tx.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
        const task = await tx.get('SELECT id,deleted,completed,cancelled FROM tasks WHERE id=? AND user_id=?', [b.task_id, userId]);
        const block = state?.active_version_id == null ? null : await tx.get(
          'SELECT 1 FROM scheduled_blocks WHERE user_id=? AND schedule_version_id=? AND task_id=?', [userId, state.active_version_id, b.task_id]);
        if (!task || task.deleted || task.completed || task.cancelled || !block) throw new LockInputError('這個任務尚未排入時間，請先安排後再鎖定');
      }
      const r = type === 'task'
        ? await tx.run('INSERT INTO schedule_locks (user_id,type,task_id) VALUES (?,?,?)', [userId, type, b.task_id])
        : type === 'day'
          ? await tx.run('INSERT INTO schedule_locks (user_id,type,date) VALUES (?,?,?)', [userId, type, b.date])
          : await tx.run('INSERT INTO schedule_locks (user_id,type,date,start_time,end_time) VALUES (?,?,?,?,?)', [userId, type, b.date, b.start_time, b.end_time]);
      return { lock: publicLock({ id: r.lastInsertRowid, ...b }), created: true };
    });
  } catch (e) {
    // 多 instance 同時插入時由 partial UNIQUE 決勝；輸家讀回 winner，仍是冪等成功。
    if (!uniqueConflict(e)) throw e;
    const existing = await findLive(q, userId, type, b);
    if (!existing) throw e;
    return { lock: publicLock(existing), created: false };
  }
}
