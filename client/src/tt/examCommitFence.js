// 段考建立／調整送進原子交易後，HTTP 回應可能遺失。這個 session fence
// 保存同一份已簽章請求，讓重新整理後只能 replay 原 token，不能產生第二份計畫。
// 只保存 JWT 裡的 userId 做帳號隔離，不保存 token 本身。
const currentUserId = () => {
  try {
    const token = localStorage.getItem('token');
    const payload = token?.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return parsed?.userId == null ? null : String(parsed.userId);
  } catch { return null; }
};

export const examCommitFenceKey = planId => planId == null
  ? 'tt-exam-create-commit-v1'
  : `tt-exam-edit-commit-v1:${planId}`;

export const loadExamCommitFence = key => {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const fence = JSON.parse(raw);
    const owner = currentUserId();
    const editPlanId = key.startsWith('tt-exam-edit-commit-v1:') ? key.slice('tt-exam-edit-commit-v1:'.length) : null;
    const expectedEndpoint = editPlanId == null ? '/exam-plans' : `/exam-plans/${editPlanId}`;
    const expectedMethod = editPlanId == null ? 'POST' : 'PUT';
    if (!owner || fence?.owner !== owner || fence?.endpoint !== expectedEndpoint
      || fence?.method !== expectedMethod || !fence?.body?.preview_token) {
      sessionStorage.removeItem(key);
      return null;
    }
    return fence;
  } catch {
    try { sessionStorage.removeItem(key); } catch {}
    return null;
  }
};

export const createExamCommitFence = ({ endpoint, method, body }) => {
  const owner = currentUserId();
  return owner ? { owner, endpoint, method, body } : null;
};

export const saveExamCommitFence = (key, fence) => {
  if (!fence?.owner) return;
  try { sessionStorage.setItem(key, JSON.stringify(fence)); } catch {}
};

export const clearExamCommitFence = (key, owner) => {
  try {
    const fence = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!fence || fence.owner === owner) sessionStorage.removeItem(key);
  } catch { try { sessionStorage.removeItem(key); } catch {} }
};
