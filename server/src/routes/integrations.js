import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as gcal from '../integrations/google-calendar.js';

// Google Calendar 連結／中斷。
//
// 這裡只做「授權」這件事，不做任何行事曆讀寫；忙碌時段是排程當下才去問的。
// callback 是唯一沒有 requireAuth 的端點——Google 把瀏覽器導回來時不會帶
// 我們的 Authorization header，所以身分改由**伺服器自己簽的 state** 認定。
const router = Router();

// 連結狀態。永遠不會回 token、密文或 client secret。
router.get('/integrations/google-calendar/status', requireAuth, async (req, res) => {
  const status = await gcal.statusFor(req.userId);
  res.json({ ...status, configured: gcal.isConfigured() });
});

// 產生 Google 授權網址。網址由伺服器組，前端不參與 scope 或 redirect 的決定。
router.post('/integrations/google-calendar/connect', requireAuth, async (req, res) => {
  try {
    res.json({ authorization_url: gcal.authorizationUrl(req.userId) });
  } catch (e) {
    res.status(e.code === 'NOT_CONFIGURED' ? 503 : 400).json({ error: e.message, code: e.code });
  }
});

// OAuth callback。走完就把使用者導回 App，不在網址上帶任何 token。
router.get('/integrations/google-calendar/callback', async (req, res) => {
  const back = (ok, reason = '') =>
    res.redirect(`/?go=settings&google=${ok ? 'connected' : 'failed'}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);
  try {
    if (req.query.error) return back(false, String(req.query.error).slice(0, 40));
    const { userId } = gcal.verifyState(req.query.state);
    const code = String(req.query.code || '');
    if (!code) return back(false, 'missing_code');
    const token = await gcal.exchangeCode(code);
    await gcal.saveConnection(userId, token);
    back(true);
  } catch (e) {
    // 錯誤原因只給代碼，不回傳 Google 的原始回應——它可能含 token。
    back(false, e.code || 'failed');
  }
});

router.delete('/integrations/google-calendar', requireAuth, async (req, res) => {
  const out = await gcal.disconnect(req.userId);
  // remote revoke 失敗不影響結果：本地憑證一定已經刪掉，使用者確實中斷了。
  res.json({ connected: false, mode: 'read_only_busy', ...out });
});

export default router;
