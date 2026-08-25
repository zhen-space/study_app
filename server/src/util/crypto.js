// Token 加密：AES-256-GCM。
//
// 這裡保護的是 Google refresh token——它等同一把長期的帳號存取權，
// 外洩比密碼雜湊外洩更糟（雜湊還得先破解，refresh token 直接就能用）。
// 所以資料庫裡只放密文，任何時候都不會出現在 log、API 回應或前端。
//
// 金鑰來自 TOKEN_ENCRYPTION_KEY，刻意不與 JWT_SECRET 或 GOOGLE_CLIENT_SECRET
// 共用：那兩把的用途、輪替節奏與外洩後果都不一樣，混用等於把風險綁在一起。
//
// envelope 帶 v，schema 也存 encryption_version，將來換金鑰或換演算法時
// 舊資料還讀得出來，不必一次性重寫全部密文。

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export const ENCRYPTION_VERSION = 1;
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;          // GCM 標準長度
const KEY_BYTES = 32;         // AES-256

export class EncryptionKeyError extends Error {}

// 金鑰是 Base64 的 32 bytes。長度不對就直接讓它爆掉：
// 用一把長度不對的金鑰「勉強跑起來」比啟動失敗危險得多。
export function loadKey(raw = process.env.TOKEN_ENCRYPTION_KEY) {
  if (!raw) throw new EncryptionKeyError('尚未設定 TOKEN_ENCRYPTION_KEY');
  let key;
  try { key = Buffer.from(String(raw), 'base64'); }
  catch { throw new EncryptionKeyError('TOKEN_ENCRYPTION_KEY 不是合法的 Base64'); }
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(`TOKEN_ENCRYPTION_KEY 解碼後必須是 ${KEY_BYTES} bytes，目前是 ${key.length}`);
  }
  return key;
}

export function hasKey() {
  try { loadKey(); return true; } catch { return false; }
}

// 明文 → envelope 字串。每次都用新的隨機 IV：同樣的 token 加密兩次也不會一樣。
export function encryptToken(plaintext, key = loadKey()) {
  if (typeof plaintext !== 'string' || !plaintext) throw new Error('沒有可加密的內容');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: ENCRYPTION_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  });
}

// envelope 字串 → 明文。金鑰不對、密文被動過手腳，GCM 的 authentication tag
// 會讓 final() 直接丟例外——這正是我們要的：解不開就是解不開，不會悄悄回一段垃圾。
export function decryptToken(envelope, key = loadKey()) {
  let box;
  try { box = JSON.parse(envelope); } catch { throw new Error('token envelope 格式錯誤'); }
  if (box?.v !== ENCRYPTION_VERSION) throw new Error(`不支援的 token envelope 版本：${box?.v}`);
  const iv = Buffer.from(box.iv || '', 'base64');
  const tag = Buffer.from(box.tag || '', 'base64');
  const ct = Buffer.from(box.ct || '', 'base64');
  if (iv.length !== IV_BYTES) throw new Error('token envelope 的 IV 長度錯誤');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// 比對 signed state 之類的短字串。長度不同直接回 false，
// 長度相同才做 timing-safe 比較，避免用比較時間反推內容。
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
