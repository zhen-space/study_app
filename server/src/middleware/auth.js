import jwt from 'jsonwebtoken';
import { q } from '../db/init.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(header.slice(7), SECRET);
    // 資料庫可能被重置，帳號不存在時強制重新登入
    if (!(await q.get('SELECT id FROM users WHERE id=?', [payload.userId]))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

export function signToken(userId) {
  return jwt.sign({ userId }, SECRET, { expiresIn: '30d' });
}
