// Canonical Material Draft：一份「還沒寫進資料庫的完整教材」。
//
// 這是 import preview 與（未來）手動建立教材共用的**唯一**中間形狀。
// 兩條路都輸出同一種 draft，再交給同一個 transactional writer——
// 不維護兩套 full-tree writer，才不會有一邊擋得住、另一邊繞得過。
//
//   圖片／PDF ──► parser ─┐
//                        ├─► canonical draft ─► commitMaterialDraft()（單一 transaction）
//   手動建立 ────────────┘
//
// draft 本身**不帶任何 id**：它描述的是「要建立什麼」，不是「已經有什麼」。
// 任何 identity 都由 commit 當下的 INSERT 決定，不從 title / path 猜。

import { NODE_KINDS, ITEM_KINDS, ITEM_KIND_LABEL, itemPlacementProblem } from './tree.js';

/*
canonical draft 形狀：

{
  book: { title, publisher?, subject_list_id? },
  chapters: [{
    title, order?,
    content_items: [ ... ],        // 章直屬：reading / unit_exercise / past_exam
    children: [{                   // Section 與 Topic 是**同層**，都直接掛在章底下
      kind: 'section' | 'topic',
      title, order?,
      content_items: [ ... ],      // reading / example / example_problem
    }],
  }],
}

content_item：{ title, kind, order?, estimated_minutes? }
*/

export class DraftError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'DraftError';
    this.problems = problems;
  }
}

const CHILD_KINDS = ['section', 'topic'];
const str = v => (typeof v === 'string' ? v.trim() : '');
const int = v => (v == null || v === '' ? null : Number(v));

// 驗證並正規化一份 draft。回傳 { draft, problems }：
//   problems 非空代表這份 draft 不可 commit。
// 刻意「全部檢查完才回報」，不是遇到第一個錯就中斷——使用者要一次看到所有問題。
export function validateDraft(input) {
  const problems = [];
  const at = (path, message) => problems.push({ path, message });

  const bookIn = input?.book || {};
  const title = str(bookIn.title);
  if (!title) at('book.title', '請填教材名稱');
  const subject = int(bookIn.subject_list_id);
  if (subject != null && !Number.isFinite(subject)) at('book.subject_list_id', '科目不正確');

  const chaptersIn = Array.isArray(input?.chapters) ? input.chapters : [];
  if (!chaptersIn.length) at('chapters', '至少要有一章');

  const items = (list, parentKind, path) => {
    if (list == null) return [];
    if (!Array.isArray(list)) { at(path, '內容必須是陣列'); return []; }
    return list.map((raw, i) => {
      const p = `${path}[${i}]`;
      const t = str(raw?.title);
      const kind = str(raw?.kind);
      if (!t) at(`${p}.title`, '請填名稱');
      if (!ITEM_KINDS.includes(kind)) {
        at(`${p}.kind`, `教材項目類型不正確：${kind || '（空白）'}`);
      } else {
        // placement 規則只有一份：tree.js。這裡不重寫，只呼叫。
        const problem = itemPlacementProblem(kind, parentKind);
        if (problem) at(`${p}.kind`, problem);
      }
      const est = int(raw?.estimated_minutes);
      if (est != null && (!Number.isFinite(est) || est <= 0)) {
        at(`${p}.estimated_minutes`, '預估時間不正確');
      }
      return {
        title: t,
        kind,
        order: Number.isFinite(int(raw?.order)) ? int(raw.order) : i,
        estimated_minutes: est,
      };
    });
  };

  const chapters = chaptersIn.map((raw, ci) => {
    const p = `chapters[${ci}]`;
    const t = str(raw?.title);
    if (!t) at(`${p}.title`, '請填章名稱');

    const childrenIn = Array.isArray(raw?.children) ? raw.children : [];
    const children = childrenIn.map((c, si) => {
      const cp = `${p}.children[${si}]`;
      const kind = str(c?.kind);
      const ct = str(c?.title);
      if (!ct) at(`${cp}.title`, '請填名稱');
      if (!CHILD_KINDS.includes(kind)) {
        at(`${cp}.kind`, `章底下只能是「節」或「主題」，不接受：${kind || '（空白）'}`);
      }
      // Section / Topic 底下不得再有節點。Topic 巢狀在 Section 底下是舊資料的形狀，
      // canonical draft 一律拒絕——正式 hierarchy 裡兩者是同層。
      if (Array.isArray(c?.children) && c.children.length) {
        at(`${cp}.children`, '「節」與「主題」是同層，底下不能再放節或主題');
      }
      return {
        kind: CHILD_KINDS.includes(kind) ? kind : kind,
        title: ct,
        order: Number.isFinite(int(c?.order)) ? int(c.order) : si,
        content_items: items(c?.content_items, CHILD_KINDS.includes(kind) ? kind : null, `${cp}.content_items`),
      };
    });

    return {
      title: t,
      order: Number.isFinite(int(raw?.order)) ? int(raw.order) : ci,
      content_items: items(raw?.content_items, 'chapter', `${p}.content_items`),
      children,
    };
  });

  // 空殼教材：一個 ContentItem 都沒有的 draft 建起來也沒有東西可排，
  // 與其讓學生之後才發現，不如在 preview 就講。
  const total = chapters.reduce((n, c) =>
    n + c.content_items.length + c.children.reduce((m, s) => m + s.content_items.length, 0), 0);
  if (chaptersIn.length && total === 0) at('chapters', '整本教材沒有任何內容項目');

  return {
    draft: { book: { title, publisher: str(bookIn.publisher), subject_list_id: subject }, chapters },
    problems,
  };
}

// 統計數字，給 preview 讓使用者確認「AI 讀到多少東西」。
export function draftSummary(draft) {
  const byKind = Object.fromEntries(ITEM_KINDS.map(k => [k, 0]));
  let sections = 0; let topics = 0; let items = 0;
  for (const c of draft.chapters) {
    for (const it of c.content_items) { byKind[it.kind] = (byKind[it.kind] || 0) + 1; items++; }
    for (const s of c.children) {
      if (s.kind === 'section') sections++; else if (s.kind === 'topic') topics++;
      for (const it of s.content_items) { byKind[it.kind] = (byKind[it.kind] || 0) + 1; items++; }
    }
  }
  return {
    chapters: draft.chapters.length,
    sections,
    topics,
    content_items: items,
    by_kind: byKind,
    labels: ITEM_KIND_LABEL,
  };
}

export { NODE_KINDS, ITEM_KINDS, ITEM_KIND_LABEL };
