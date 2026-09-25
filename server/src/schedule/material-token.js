// §Phase2 audit r3：Material snapshot 必須是伺服器簽章、client 無法自行重建的 opaque token。
//
// 為什麼不能只信 client 傳回的 snapshot JSON：title / material_book_id / subject_list_id
// 這三個欄位不影響 block 分鐘，estimate 對帳保護不到；client 可在 apply 前把 CURRENT 改掉、
// 同時把普通 snapshot 也改成 CURRENT 值，比較就通過了。改用 HMAC-SHA256 簽章後，任何欄位
// （含 preview 當下的 CURRENT 值與 user/plan/base_version/client_key/content item 綁定）都被簽進
// token，client 動一個字元簽章就失效。
//
// 用既有的後端 secret（與 auth JWT 同一把；dev fallback 與 auth.js 一致），不引入新 secret／schema。
import { createHmac, timingSafeEqual } from 'node:crypto';

const secret = () => process.env.JWT_SECRET || 'dev-secret-change-me';

// 兩端必須用同一個 canonical 欄位順序，否則簽章對不上。
const FIELDS = [
  'user_id', 'plan_id', 'base_version_id', 'client_key', 'content_item_id',
  'title', 'estimated_minutes', 'material_book_id', 'subject_list_id',
];

function canonical(payload) {
  const o = {};
  for (const f of FIELDS) o[f] = payload[f] ?? null;
  return JSON.stringify(o);
}

// 產生 opaque token：base64url(canonical(payload)).base64url(HMAC)。
export function signMaterialSnapshotToken(payload) {
  const body = Buffer.from(canonical(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// 回 { ok:true, payload } 或 { ok:false, reason:'missing'|'malformed'|'bad_signature' }。
// 只有簽章驗過才回 payload——之後才拿去做 binding 與 CURRENT 比較。
export function verifyMaterialSnapshotToken(token) {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'malformed' }; }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  return { ok: true, payload };
}
