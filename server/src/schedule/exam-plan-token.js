import { createHmac, timingSafeEqual } from 'node:crypto';

const secret = () => process.env.JWT_SECRET || 'dev-secret-change-me';

export function signExamPlanPreview(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyExamPlanPreview(token) {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  let actual;
  try { actual = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}
