// 教材編輯器新增節／主題／內容的回應可能遺失。保存 exact endpoint/body/key，
// 重新整理後只能 replay 原請求；owner 取 JWT userId，不保存登入 token。
const currentUserId = () => {
  try {
    const payload = localStorage.getItem('token')?.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return parsed?.userId == null ? null : String(parsed.userId);
  } catch { return null; }
};

const requestId = () => globalThis.crypto?.randomUUID?.()
  || `material_edit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;

const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const NODE_KINDS = new Set(['chapter', 'section', 'topic']);
const ITEM_KINDS = new Set([
  'reading', 'example', 'example_problem', 'unit_exercise', 'past_exam', 'workbook_exercise',
]);
const ownKeysOnly = (body, allowed) => body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).every(key => allowed.has(key));
const positiveId = value => typeof value === 'number' && Number.isInteger(value) && value > 0;
const optionalOrder = value => value == null || (Number.isFinite(value) && Number.isInteger(value));

const validNodeBody = (body, bookId) => ownKeysOnly(body, new Set([
  'book_id', 'parent_id', 'kind', 'title', 'order_index', 'client_request_id',
]))
  && positiveId(body.book_id) && Number(body.book_id) === Number(bookId)
  && (body.parent_id == null || positiveId(body.parent_id))
  && NODE_KINDS.has(body.kind) && typeof body.title === 'string' && Boolean(body.title.trim())
  && optionalOrder(body.order_index) && REQUEST_ID.test(body.client_request_id || '');

const validItemBody = body => ownKeysOnly(body, new Set([
  'node_id', 'kind', 'title', 'estimated_minutes', 'order_index', 'client_request_id',
]))
  && positiveId(body.node_id) && ITEM_KINDS.has(body.kind)
  && typeof body.title === 'string' && Boolean(body.title.trim())
  && (body.estimated_minutes == null
    || (Number.isFinite(body.estimated_minutes) && body.estimated_minutes > 0))
  && optionalOrder(body.order_index) && REQUEST_ID.test(body.client_request_id || '');

const validFence = (fence, bookId, owner) => {
  if (!fence || typeof fence !== 'object' || Array.isArray(fence)
    || Object.keys(fence).some(key => !['owner', 'book_id', 'endpoint', 'body'].includes(key))
    || typeof fence.owner !== 'string' || fence.owner !== owner
    || !positiveId(fence.book_id) || Number(fence.book_id) !== Number(bookId)) return false;
  if (fence.endpoint === '/material/nodes') return validNodeBody(fence.body, bookId);
  if (fence.endpoint === '/material/content-items') return validItemBody(fence.body);
  return false;
};

export const materialEditorFenceKey = bookId => `tt-material-book-create-v1:${bookId}`;

export const createMaterialEditorFence = (bookId, endpoint, body) => {
  const owner = currentUserId();
  if (!owner) return null;
  const fence = {
    owner, book_id: Number(bookId), endpoint,
    body: { ...body, client_request_id: requestId() },
  };
  return validFence(fence, bookId, owner) ? fence : null;
};

export const loadMaterialEditorFence = bookId => {
  const key = materialEditorFenceKey(bookId);
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const fence = JSON.parse(raw);
    const owner = currentUserId();
    if (!owner || !validFence(fence, bookId, owner)) {
      sessionStorage.removeItem(key);
      return null;
    }
    return fence;
  } catch {
    try { sessionStorage.removeItem(key); } catch {}
    return null;
  }
};

export const saveMaterialEditorFence = fence => {
  if (!fence?.owner) return false;
  try {
    sessionStorage.setItem(materialEditorFenceKey(fence.book_id), JSON.stringify(fence));
    return true;
  } catch { return false; }
};

export const clearMaterialEditorFence = (bookId, owner) => {
  const key = materialEditorFenceKey(bookId);
  try {
    const fence = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!fence || fence.owner === owner) sessionStorage.removeItem(key);
  } catch { try { sessionStorage.removeItem(key); } catch {} }
};
