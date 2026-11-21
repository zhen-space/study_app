// 整本教材建立進入後端交易後，HTTP 回應可能遺失。session fence 保存同一份
// client_request_id 與請求內容，重新整理後只能 replay 原請求，不能建立第二本。
// owner 只取 JWT payload 的 userId；不保存登入 token。
const currentUserId = () => {
  try {
    const payload = localStorage.getItem('token')?.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return parsed?.userId == null ? null : String(parsed.userId);
  } catch { return null; }
};

export const MATERIAL_COMMIT_FENCE_KEY = 'tt-material-create-commit-v1';

export const createMaterialRequestId = () => globalThis.crypto?.randomUUID?.()
  || `material_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;

export const createMaterialCommitFence = draft => {
  const owner = currentUserId();
  if (!owner) return null;
  return { owner, body: { draft, client_request_id: createMaterialRequestId() } };
};

export const loadMaterialCommitFence = () => {
  try {
    const raw = sessionStorage.getItem(MATERIAL_COMMIT_FENCE_KEY);
    if (!raw) return null;
    const fence = JSON.parse(raw);
    const owner = currentUserId();
    if (!owner || fence?.owner !== owner || !fence?.body?.draft || !fence?.body?.client_request_id) {
      sessionStorage.removeItem(MATERIAL_COMMIT_FENCE_KEY);
      return null;
    }
    return fence;
  } catch {
    try { sessionStorage.removeItem(MATERIAL_COMMIT_FENCE_KEY); } catch {}
    return null;
  }
};

export const saveMaterialCommitFence = fence => {
  if (!fence?.owner) return false;
  try {
    sessionStorage.setItem(MATERIAL_COMMIT_FENCE_KEY, JSON.stringify(fence));
    return true;
  } catch { return false; }
};

export const clearMaterialCommitFence = owner => {
  try {
    const fence = JSON.parse(sessionStorage.getItem(MATERIAL_COMMIT_FENCE_KEY) || 'null');
    if (!fence || fence.owner === owner) sessionStorage.removeItem(MATERIAL_COMMIT_FENCE_KEY);
  } catch { try { sessionStorage.removeItem(MATERIAL_COMMIT_FENCE_KEY); } catch {} }
};
