// 任務建立的回應可能在伺服器已寫入後遺失。fence 只保存本次請求所需資料，
// 並以 JWT 裡的 userId 隔離帳號；不保存 token，也不以 token 當身分鍵。
export const currentUserId = () => {
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const id = JSON.parse(json)?.userId;
    return id == null ? null : String(id);
  } catch { return null; }
};

export const createRequestId = prefix => globalThis.crypto?.randomUUID?.()
  || `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;

export const loadTaskCreateFence = key => {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const fence = JSON.parse(raw);
    const owner = currentUserId();
    if (!owner || fence?.owner !== owner || !fence?.body?.client_request_id || !Array.isArray(fence?.beforeIds)) {
      sessionStorage.removeItem(key);
      return null;
    }
    return fence;
  } catch {
    try { sessionStorage.removeItem(key); } catch {}
    return null;
  }
};

export const saveTaskCreateFence = (key, fence) => {
  if (!fence?.owner) return;
  try { sessionStorage.setItem(key, JSON.stringify(fence)); } catch {}
};

export const clearTaskCreateFence = (key, owner) => {
  try {
    const fence = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!fence || fence.owner === owner) sessionStorage.removeItem(key);
  } catch { try { sessionStorage.removeItem(key); } catch {} }
};
