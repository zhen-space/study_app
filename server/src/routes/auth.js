import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/init.js';
import { signToken } from '../middleware/auth.js';

const router = Router();

router.post('/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: '請輸入 Email 及至少 6 碼密碼' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: '此 Email 已被註冊' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
  const token = signToken(result.lastInsertRowid);
  res.json({ token, user: { id: result.lastInsertRowid, email } });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Email 或密碼錯誤' });
  }
  const token = signToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email } });
});

export default router;
