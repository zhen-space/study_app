import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../db/init.js';
import { signToken } from '../middleware/auth.js';

const router = Router();

router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: '請輸入 Email 及至少 6 碼密碼' });
  }
  if (await q.get('SELECT id FROM users WHERE email = ?', [email])) {
    return res.status(409).json({ error: '此 Email 已被註冊' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const r = await q.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
  res.json({ token: signToken(r.lastInsertRowid), user: { id: r.lastInsertRowid, email } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await q.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Email 或密碼錯誤' });
  }
  res.json({ token: signToken(user.id), user: { id: user.id, email: user.email } });
});

export default router;
