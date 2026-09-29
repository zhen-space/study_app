import { createHmac, timingSafeEqual } from 'node:crypto';

const secret = () => process.env.JWT_SECRET || 'dev-secret-change-me';
const fields = ['user_id', 'plan_id', 'base_version_id', 'subject_list_id', 'exam_date'];
const canonical = value => JSON.stringify(Object.fromEntries(fields.map(k => [k, value[k] ?? null])));

export function signExamSubjectToken(value) {
  const body = Buffer.from(canonical(value), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyExamSubjectToken(token) {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra) return null;
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}
