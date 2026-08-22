import { api } from '../api';

// Material 前端資料層。所有 Material 相關的 API 呼叫只從這裡走。
//
// 三條分界線，跟後端契約一字不差（docs/material-domain.md）：
//   ① completion 與 selection 是兩個完全獨立的狀態。前端不從其中一個推另一個，
//      也不從 Task.completed 推 Material completion。
//   ② 節點（Chapter / Section / Topic）的完成度與 tri-state 一律**相信後端**
//      回傳的 progress / selection，前端不自己 aggregate 出第二套 truth。
//   ③ 正式 hierarchy 是 Book → Chapter →（Section｜Topic 同層），
//      Chapter 底下可以直接掛 unit_exercise / past_exam。
//      不得把 Topic 當 Section 的 child，也不得為 Chapter-level 內容造假的 Section。

/* ---------- 讀取 ---------- */

export const listBooks = ({ archived = false } = {}) =>
  api('/material/books' + (archived ? '?archived=1' : ''));

export const listCategories = () => api('/material/categories');

// plan_id 存在時，後端會一併回傳這個 Plan 的 tri-state selection。
export const getBookTree = (bookId, { planId = null } = {}) =>
  api(`/material/books/${bookId}/tree` + (planId != null ? `?plan_id=${planId}` : ''));

export const getPlanSelection = planId => api(`/plans/${planId}/material-items`);

// 學生的教材書櫃。正式教材與舊資料一起回來，同一個形狀、同一份清單。
// 前端不分辨兩者「是不是同一本」——那需要書名比對，而書名不是 identity。
// 唯一的差別是 requires_content_confirmation：還沒確認過內容的教材，
// 第一次要用的時候會先請學生確認一次。
export const listShelf = ({ planId = null } = {}) =>
  api('/study-materials?shelf=1' + (planId != null ? `&plan_id=${planId}` : ''));

// 還沒確認過內容的教材：讀回系統已經知道的結構（書名、出版社、科目、章、
// 節／主題），以及一份 source_snapshot。這一步不寫任何東西。
export const getContentCheck = (listId, book = '') =>
  api(`/material/legacy-books/${listId}/content-check?book=${encodeURIComponent(book)}`);

// 學生確認完內容之後才寫入。source_snapshot 必須原樣送回——
// 確認的是他剛剛實際看到的那一份，不是送出當下重新查到的。
export const commitContentCheck = (listId, { book = '', draft, sourceSnapshot }) =>
  api(`/material/legacy-books/${listId}/content-check`, {
    method: 'POST', body: { book, draft, source_snapshot: sourceSnapshot },
  });

/* ---------- 加入教材 ---------- */

// 拍照／PDF：AI 讀完先回一份 draft 讓學生確認，這一步完全不寫資料庫。
export const importPreview = ({ files, subjectListId = null, title = '' }) =>
  api('/material/import/preview', {
    method: 'POST', body: { files, subject_list_id: subjectListId, title },
  });

// 確認之後整本一次建立（全成功或全不做）。手動建立教材走的是同一支——
// 前端也不維護第二套「建立整本教材」的路徑。
export const commitDraft = draft => api('/material/import/commit', { method: 'POST', body: { draft } });

/* ---------- 寫入 ---------- */

// 教材完成度。**只有**教材庫的完成操作可以呼叫這支；
// Plan 的 selection checkbox 絕對不能呼叫它。
export const setItemCompletion = (itemId, completed) =>
  api(`/material/content-items/${itemId}/completion`, { method: 'PUT', body: { completed } });

// Plan selection。這支永遠不會改到 completion。
export const selectItems = (planId, contentItemIds, selected) =>
  api(`/plans/${planId}/material-items`, {
    method: 'POST', body: { content_item_ids: contentItemIds, selected },
  });

// 節點 tri-state 批次選取：送的是 node id，後端只會寫底下尚未完成的 ContentItem。
export const selectNode = (planId, nodeId, selected) =>
  api(`/plans/${planId}/material-nodes/${nodeId}`, { method: 'POST', body: { selected } });

/* ---------- 錯誤修正：改名、改種類、刪除 ---------- */

// 改名不換 identity：完成度、Plan selection 與既有 Task 的 linkage 全部留著。
export const updateNode = (nodeId, body) =>
  api(`/material/nodes/${nodeId}`, { method: 'PATCH', body });

export const updateContentItem = (itemId, body) =>
  api(`/material/content-items/${itemId}`, { method: 'PATCH', body });

// 刪除只在完全沒有使用紀錄時才成立。後端擋下來時會回 409 與 references，
// 呼叫端要把「為什麼不能刪」講出來，不要只說失敗。
export const deleteNode = nodeId => api(`/material/nodes/${nodeId}`, { method: 'DELETE' });
export const deleteContentItem = itemId =>
  api(`/material/content-items/${itemId}`, { method: 'DELETE' });

// 建立一個科目（lists）。剛註冊的帳號一個都沒有，而沒有科目就排不進計畫。
export const createSubject = name =>
  api('/lists', { method: 'POST', body: { name, color: '#5E6AD2' } });

export const createCategory = name => api('/material/categories', { method: 'POST', body: { name } });
export const createBook = body => api('/material/books', { method: 'POST', body });
export const updateBook = (bookId, body) =>
  api(`/material/books/${bookId}`, { method: 'PATCH', body });
export const addBookToCategory = (categoryId, bookId) =>
  api(`/material/categories/${categoryId}/books/${bookId}`, { method: 'PUT' });

/* ---------- 純函式：只做「呈現」需要的整理，不重算 truth ---------- */

export const NODE_LABEL = { chapter: '章', section: '節', topic: '主題' };
// 與後端 material/tree.js 的 ITEM_KIND_LABEL 一字不差。
// 「範例」與「例題」是兩種不同的東西，不能合成一項。
export const ITEM_LABEL = {
  reading: '課本內容',
  example: '範例',
  example_problem: '例題',
  unit_exercise: '單元練習',
  past_exam: '歷屆試題',
};
// Chapter 可以直接承載的內容類型。用它判斷「這一列是 chapter-level content」，
// 而不是靠「沒有 section parent」去猜。
export const CHAPTER_LEVEL_KINDS = ['unit_exercise', 'past_exam'];

// 章底下的子節點：Section 與 Topic 是**同層**，這裡只是為了顯示而保持後端順序。
// 刻意不做任何 section→topic 的巢狀重組。
export const childNodes = chapter => chapter.children || [];

// 章自己直接掛的內容（單元練習／歷屆試題／章層內文）。
export const chapterOwnItems = chapter => chapter.content_items || [];

// 把整棵樹攤平成 ContentItem 陣列，附上顯示用的來源路徑。
// path 只用於顯示，不是 identity——identity 永遠是 content_item_id。
export function flattenItems(tree) {
  const out = [];
  const walkNode = (node, trail) => {
    const here = [...trail, node.title];
    for (const it of node.content_items || []) out.push({ ...it, path: here, node });
    for (const child of node.children || []) walkNode(child, here);
  };
  for (const n of tree?.nodes || []) walkNode(n, []);
  return out;
}

export const countSelected = tree => flattenItems(tree).filter(i => i.selected && !i.completed).length;

// 一本書在這個 Plan 裡選了幾項。用於 selector 首層顯示，不影響任何寫入。
export const bookSelectedCount = countSelected;

// tri-state → checkbox 的三種視覺狀態。後端已經算好 selection，
// 這裡只是把字串對應到 UI，不重新判定。
export const triState = node => node.selection || 'none';

// 節點底下是否還有「尚未完成、可以被選取」的內容。
// 全部完成的節點不該給出可點的批次選取框——點了也沒有東西會被選。
export function hasSelectable(node) {
  const items = node.content_items || [];
  if (items.some(i => !i.completed)) return true;
  return (node.children || []).some(hasSelectable);
}

/* ---------- Material → 排程項目 ---------- */

// 教材必須有科目才排得進計畫：排程是以科目分組的。
// 這裡回傳的永遠是**正式的 subject id**（material_books.subject_list_id → lists.id），
// 絕不用科目名稱去比對——名稱可以重複、可以改，不是 identity。
export const bookSubjectId = book => book?.subject_list_id ?? null;
export const bookNeedsSubject = book => bookSubjectId(book) == null;

// 把「這次選了哪些 ContentItem」轉成排程項目。
//
// Material 的 ContentItem 本身就是原子單位（某一份單元練習、某一題例題），
// 不需要再經過舊版的「題型展開」——那是為了把抽象的章節拆成可排的份數而存在的。
// 一項對一項，並保留 material_content_item_id 讓套用時的 Task 帶得上正式 linkage。
//
// 沒有科目的書會被放進 blocked，呼叫端必須把它顯示出來，
// 不可以等到排程最後一步才無預警失敗。
export function materialSchedulingItems(picked, books, lists = [], fallbackColor = '#0086CC') {
  const byId = new Map((books || []).map(b => [b.id, b]));
  const items = [];
  const blocked = new Map();          // book_id → { book_id, book_title, count }
  for (const d of (picked instanceof Map ? [...picked.values()] : picked || [])) {
    const book = byId.get(d.book_id);
    const sid = bookSubjectId(book);
    if (sid == null) {
      const prev = blocked.get(d.book_id)
        || { book_id: d.book_id, book_title: book?.title ?? d.book_title ?? '', count: 0 };
      prev.count += 1;
      blocked.set(d.book_id, prev);
      continue;
    }
    const subject = (lists || []).find(l => l.id === sid);
    items.push({
      key: `mat-${d.id}`,
      material_content_item_id: d.id,
      subject_id: sid,                                  // 正式 identity，不是名稱
      name: subject?.name || '',
      color: subject?.color || fallbackColor,
      // 標題帶書名與所在章節，學生在任務列表才看得懂這是哪一本的哪一段。
      // 這只是顯示用的組字，identity 一律是 material_content_item_id。
      title: [book?.title ?? d.book_title, ...(d.path || []), d.title].filter(Boolean).join('｜'),
      minutes: d.estimated_minutes || 60,
      kind: d.kind,
    });
  }
  return { items, blocked: [...blocked.values()] };
}

/* ---------- Create Plan 的草稿選取 ---------- */

// Create Plan 的時候 Plan 還不存在，沒有 plan_material_items 可以寫，
// 所以這一段草稿選取只能放在前端。這是**唯一**允許在前端算 selection 的情況，
// 而且規則必須與後端 buildTree 一模一樣：
//   ・只有「尚未完成」的 ContentItem 參與 selection
//   ・沒有可選項目的節點一律 none（不是 all）
// Plan 建立之後就把草稿送到正式 API，之後一律以後端回傳為準。
export function applyDraftSelection(tree, selectedIds) {
  const sel = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const walk = node => {
    const children = (node.children || []).map(walk);
    const items = (node.content_items || []).map(i => ({ ...i, selected: sel.has(i.id) }));
    const all = [...items, ...children.flatMap(c => c.__all)];
    const open = all.filter(i => !i.completed);
    const chosen = open.filter(i => i.selected);
    return {
      ...node,
      children,
      content_items: items,
      selection: !open.length ? 'none'
        : chosen.length === open.length ? 'all'
          : chosen.length ? 'some' : 'none',
      __all: all,
    };
  };
  const nodes = (tree?.nodes || []).map(walk);
  const flat = nodes.flatMap(n => n.__all);
  const open = flat.filter(i => !i.completed);
  const chosen = open.filter(i => i.selected);
  const strip = n => { const { __all, ...rest } = n; return { ...rest, children: n.children.map(strip) }; };
  return {
    ...tree,
    nodes: nodes.map(strip),
    selection: !open.length ? 'none'
      : chosen.length === open.length ? 'all'
        : chosen.length ? 'some' : 'none',
  };
}

// 一個節點底下所有「尚未完成」的 ContentItem id。草稿模式的批次選取用，
// 對應後端 selectNode 只會寫未完成項目的行為。
export function openItemIdsUnder(node) {
  const out = [];
  const walk = n => {
    for (const i of n.content_items || []) if (!i.completed) out.push(i.id);
    for (const c of n.children || []) walk(c);
  };
  walk(node);
  return out;
}

/* ---------- blocked / reconciliation ---------- */

// 把各種 API 回應裡的 blocked 清單統一成同一個形狀。
// 後端有兩個來源：completion 的 reconciliation.blocked[]、
// selection 的 task_exits.blocked[]。兩者結構相同，UI 只需要一種。
export function collectBlocked(...responses) {
  const out = [];
  for (const r of responses) {
    if (!r) continue;
    for (const b of r.reconciliation?.blocked || []) out.push(b);
    for (const b of r.task_exits?.blocked || []) out.push(b);
  }
  return out;
}

export function collectCancelled(...responses) {
  const out = [];
  for (const r of responses) {
    if (!r) continue;
    for (const b of r.reconciliation?.cancelled || []) out.push(b);
    for (const b of r.task_exits?.cancelled || []) out.push(b);
  }
  return out;
}
