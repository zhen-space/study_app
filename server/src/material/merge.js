// 教材合併／增補目錄的**純函式**：把一份新 TOC（draft）比對到既有教材樹，
// 分類每個章節／內容為 新增 / 已存在 / 疑似重複 / 順序變更，並算出是否需要人工
// 確認順序。這裡完全不寫 DB、不判斷完成度——完成度與合併無關。
//
// 合併與「同一本書增補目錄」是同一個操作：把新內容併進既有書，保留一切既有東西。
//
// 契約重點（對應 blocker 2、3、4）：
//   ・相同章節不可重複建立：以 (parent, 正規化標題) 對應既有節點，命中就重用。
//   ・疑似重複（序數相同但標題不同，或標題互為子字串）預設 fail-closed，交使用者確認。
//   ・新章節放到既有之間的順序，只有在序數全部可靠時才敢自動排；否則
//     ORDER_CONFIRMATION_REQUIRED。
//   ・fingerprint 讓 apply 能偵測 preview 之後 CURRENT book 被改動（stale）。

import { extractOrdinal, canOrderReliably } from './natural-order.js';

// 標題正規化（對應用途：判斷「同一個章節／內容」，不改真正存下來的標題）。
export const normTitle = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// 既有教材樹的指紋：節點與內容的 id＋標題＋順序，排序後串接。CURRENT 一有改動就變，
// apply 用它擋 stale preview（避免拿舊畫面覆蓋新狀態）。
export function bookFingerprint(nodes = [], items = []) {
  const n = [...nodes]
    .map(x => `n:${x.id}:${x.parent_id ?? 0}:${x.kind}:${normTitle(x.title)}:${x.order_index ?? 0}`)
    .sort();
  const i = [...items]
    .map(x => `i:${x.id}:${x.node_id}:${x.kind}:${normTitle(x.title)}:${x.order_index ?? 0}`)
    .sort();
  return [...n, ...i].join('|');
}

// 疑似重複判斷：非完全同名，但標題互為子字串；章／節層另可用序數相同判斷。
// useOrdinal 只給章／節：內容項常用子編號（1-1、1-2）會抽出相同的前導序數，
// 對內容用序數會誤判，所以內容層一律不看序數，只看子字串包含。
function suspectDuplicate(incomingTitle, candidateTitles, { useOrdinal = false } = {}) {
  const inNorm = normTitle(incomingTitle);
  const inOrd = useOrdinal ? extractOrdinal(incomingTitle) : null;
  for (const c of candidateTitles) {
    const cNorm = normTitle(c);
    if (cNorm === inNorm) return null; // 完全同名 → 交給 exact 判斷，不是疑似
    if (useOrdinal && inOrd != null) {
      const cOrd = extractOrdinal(c);
      if (cOrd != null && inOrd === cOrd) return c;
    }
    if (inNorm && cNorm && (inNorm.includes(cNorm) || cNorm.includes(inNorm))) return c;
  }
  return null;
}

// 建立既有樹的查找索引。
function indexExisting(nodes, items) {
  const chapters = nodes.filter(n => n.parent_id == null && n.kind === 'chapter');
  const childrenByChapter = new Map(); // chapterId -> child nodes
  for (const n of nodes) {
    if (n.parent_id != null) {
      if (!childrenByChapter.has(n.parent_id)) childrenByChapter.set(n.parent_id, []);
      childrenByChapter.get(n.parent_id).push(n);
    }
  }
  const itemsByNode = new Map(); // nodeId -> items
  for (const it of items) {
    if (!itemsByNode.has(it.node_id)) itemsByNode.set(it.node_id, []);
    itemsByNode.get(it.node_id).push(it);
  }
  const chapterByNorm = new Map(chapters.map(c => [normTitle(c.title), c]));
  return { chapters, childrenByChapter, itemsByNode, chapterByNorm };
}

// 對一組既有 items 分類一個 incoming item。
function classifyItem(incoming, existingItems) {
  const inNorm = normTitle(incoming.title);
  const exact = existingItems.find(e => e.kind === incoming.kind && normTitle(e.title) === inNorm);
  if (exact) return { title: incoming.title, kind: incoming.kind, status: 'exists', matched_id: exact.id };
  const dup = suspectDuplicate(incoming.title, existingItems.filter(e => e.kind === incoming.kind).map(e => e.title));
  if (dup) return { title: incoming.title, kind: incoming.kind, status: 'suspected_duplicate', similar_to: dup };
  return { title: incoming.title, kind: incoming.kind, status: 'new' };
}

// 主 preview。existing＝{ nodes, items }（CURRENT 教材樹），draft＝validateDraft 後的 draft。
export function previewTocMerge(existing, draft) {
  const { nodes = [], items = [] } = existing || {};
  const idx = indexExisting(nodes, items);
  const counts = { new: 0, exists: 0, suspected_duplicate: 0, order_change: 0 };
  const bump = s => { if (counts[s] != null) counts[s] += 1; };

  const newChapterTitles = [];
  const outChapters = (draft.chapters || []).map((ch, ci) => {
    const chNorm = normTitle(ch.title);
    const matched = idx.chapterByNorm.get(chNorm) || null;
    let status;
    if (matched) status = 'exists';
    else {
      const dup = suspectDuplicate(ch.title, idx.chapters.map(c => c.title), { useOrdinal: true });
      status = dup ? 'suspected_duplicate' : 'new';
      if (status === 'new') newChapterTitles.push(ch.title);
    }
    bump(status);

    // 章的順序變更：既有章、且依序數該在的位置與目前 order_index 名次不同 → 標記（純資訊）。
    let orderChanged = false;
    if (matched) {
      const ord = extractOrdinal(ch.title);
      if (ord != null) {
        const naturalRank = [...idx.chapters]
          .map(c => ({ id: c.id, ord: extractOrdinal(c.title) }))
          .filter(c => c.ord != null)
          .sort((a, b) => a.ord - b.ord)
          .findIndex(c => c.id === matched.id);
        const currentRank = [...idx.chapters]
          .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
          .findIndex(c => c.id === matched.id);
        if (naturalRank !== -1 && naturalRank !== currentRank) { orderChanged = true; bump('order_change'); }
      }
    }

    const existDirectItems = matched ? (idx.itemsByNode.get(matched.id) || []) : [];
    const outItems = (ch.content_items || []).map(it => {
      const r = classifyItem(it, existDirectItems);
      bump(r.status);
      return r;
    });

    const existChildren = matched ? (idx.childrenByChapter.get(matched.id) || []) : [];
    const childByNorm = new Map(existChildren.map(c => [`${c.kind}|${normTitle(c.title)}`, c]));
    const outChildren = (ch.children || []).map(child => {
      const key = `${child.kind}|${normTitle(child.title)}`;
      const cm = childByNorm.get(key) || null;
      let cstatus;
      if (cm) cstatus = 'exists';
      else {
        const dup = suspectDuplicate(child.title, existChildren.filter(e => e.kind === child.kind).map(e => e.title), { useOrdinal: true });
        cstatus = dup ? 'suspected_duplicate' : 'new';
      }
      bump(cstatus);
      const existChildItems = cm ? (idx.itemsByNode.get(cm.id) || []) : [];
      const cItems = (child.content_items || []).map(it => {
        const r = classifyItem(it, existChildItems);
        bump(r.status);
        return r;
      });
      return { title: child.title, kind: child.kind, status: cstatus, items: cItems };
    });

    return { title: ch.title, status, order_changed: orderChanged, items: outItems, children: outChildren };
  });

  const existingChapterTitles = idx.chapters.map(c => c.title);
  const orderReliable = newChapterTitles.length === 0
    || canOrderReliably(existingChapterTitles, newChapterTitles);

  return {
    chapters: outChapters,
    counts,
    has_suspected_duplicates: counts.suspected_duplicate > 0,
    order_status: orderReliable ? 'ok' : 'ORDER_CONFIRMATION_REQUIRED',
    fingerprint: bookFingerprint(nodes, items),
  };
}
