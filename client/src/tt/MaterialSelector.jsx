import { useCallback, useEffect, useState } from 'react';
import {
  listShelf, getBookTree, selectItems, selectNode,
  ITEM_LABEL, CHAPTER_LEVEL_KINDS, countSelected, collectBlocked, collectCancelled,
  applyDraftSelection, openItemIdsUnder, flattenItems, bookNeedsSubject,
} from './material';
import { Button, EmptyState } from './ui';
import BlockedNotice from './BlockedNotice';
import MaterialContentCheck from './MaterialContentCheck';
import AddMaterialFlow from './AddMaterialFlow';

// Create Plan 與 Edit Plan **共用的同一個**教材選取畫面。
// 兩邊只差在初始狀態從哪裡來——那由後端 tree 的 plan_id 決定，不是兩套元件。
//
// 學生在這裡只看到一件事：他的教材，以及這次要讀哪些內容。
// 資料底層是正式教材還是以前拍照留下的目錄，是系統自己的事，不外洩到畫面上。
//
// 這個元件的硬性規則：
//   ・checkbox 改的永遠是 Plan selection，絕對不呼叫 completion endpoint
//   ・completed 不畫成 checked checkbox，而且不只靠顏色區分
//   ・節點 checkbox 只做批次選取，狀態直接用後端算好的 selection
//   ・Section 與 Topic 是 Chapter 的同層子節點；chapter-level 內容
//     （單元練習／歷屆試題）直接畫在 Chapter 底下，不縮排成 Section 的樣子

/* ---------- 選取方塊 ---------- */

// 三種完全不同的東西，視覺上必須一眼分得出來，而且不能只靠顏色：
//   completed → 打勾徽章 ✓ ＋「已完成」文字，沒有 checkbox
//   checked   → 實心方塊 ＋ 勾
//   unchecked → 空心方塊
function SelectBox({ state, disabled, onToggle, label }) {
  if (state === 'completed') {
    return (
      <span className="mt-done" aria-label={`${label}：已完成`} title="已完成">
        <span aria-hidden="true">✓</span>
      </span>
    );
  }
  const tri = state === 'some';
  return (
    <button type="button" role="checkbox" disabled={disabled}
      aria-checked={tri ? 'mixed' : state === 'all' || state === 'checked'}
      aria-label={label}
      className={'mt-box' + (state === 'all' || state === 'checked' ? ' on' : '') + (tri ? ' mixed' : '')}
      onClick={e => { e.stopPropagation(); onToggle(); }}>
      <span aria-hidden="true">{tri ? '–' : (state === 'all' || state === 'checked') ? '✓' : ''}</span>
    </button>
  );
}

/* ---------- 單一 ContentItem ---------- */

function ItemRow({ item, busy, onToggle }) {
  const state = item.completed ? 'completed' : item.selected ? 'checked' : 'unchecked';
  return (
    <div className={'mt-item' + (item.completed ? ' is-done' : '')}>
      <SelectBox state={state} disabled={busy || item.completed} label={item.title}
        onToggle={() => onToggle(item)} />
      <div className="mt-item-main">
        <div className="mt-item-title">{item.title}</div>
        <div className="mt-item-meta">
          <span className="mt-kind">{ITEM_LABEL[item.kind] || item.kind}</span>
          {item.completed && <span className="mt-done-text">已完成</span>}
        </div>
      </div>
    </div>
  );
}

/* ---------- Section / Topic（Chapter 的同層子節點） ---------- */

function ChildNode({ node, busy, onToggleNode, onToggleItem }) {
  const items = node.content_items || [];
  const selectable = items.some(i => !i.completed);
  return (
    <div className="mt-child">
      <div className="mt-child-head">
        <SelectBox state={selectable ? node.selection : 'completed'} disabled={busy || !selectable}
          label={`${node.title}（整組）`} onToggle={() => onToggleNode(node)} />
        <div className="mt-child-main">
          <span className="mt-child-title">{node.title}</span>
          {/* Section 與 Topic 是同層。標籤要寫出來，學生才不會以為主題被包在節底下 */}
          <span className={'mt-tag mt-tag--' + node.kind}>{node.kind === 'section' ? '節' : '主題'}</span>
        </div>
        <span className="mt-progress-text">
          {node.progress.completed_items}/{node.progress.total_items}
        </span>
      </div>
      <div className="mt-child-items">
        {items.map(it => <ItemRow key={it.id} item={it} busy={busy} onToggle={onToggleItem} />)}
      </div>
    </div>
  );
}

/* ---------- Chapter ---------- */

function ChapterNode({ node, open, onOpen, busy, onToggleNode, onToggleItem }) {
  const own = node.content_items || [];
  // 章自己直接掛的單元練習／歷屆試題。它們**不屬於任何 Section**，
  // 所以畫在與 Section / Topic 同一層，而且標明「本章」。
  const chapterLevel = own.filter(i => CHAPTER_LEVEL_KINDS.includes(i.kind));
  const chapterReading = own.filter(i => !CHAPTER_LEVEL_KINDS.includes(i.kind));
  const selectable = node.progress.completed_items < node.progress.total_items;
  return (
    <div className="mt-chapter">
      <div className="mt-chapter-head">
        <SelectBox state={selectable ? node.selection : 'completed'} disabled={busy || !selectable}
          label={`${node.title}（整章）`} onToggle={() => onToggleNode(node)} />
        <button type="button" className="mt-chapter-btn" aria-expanded={open}
          onClick={() => onOpen(!open)}>
          <span className="mt-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="mt-chapter-title">{node.title}</span>
          <span className="mt-progress-text">
            {node.progress.completed_items}/{node.progress.total_items}
          </span>
        </button>
      </div>
      {open && (
        <div className="mt-chapter-body">
          {chapterReading.map(it => <ItemRow key={it.id} item={it} busy={busy} onToggle={onToggleItem} />)}
          {(node.children || []).map(c => (
            <ChildNode key={c.id} node={c} busy={busy}
              onToggleNode={onToggleNode} onToggleItem={onToggleItem} />
          ))}
          {chapterLevel.length > 0 && (
            <div className="mt-chapter-level">
              <div className="mt-chapter-level-label">本章直屬</div>
              {chapterLevel.map(it => <ItemRow key={it.id} item={it} busy={busy} onToggle={onToggleItem} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 書櫃列表的 React key。正式教材用它自己的 id；還沒確認過內容的教材沒有
// Material id，就用它來源座標本身當 key——**不用書名**，書名會重複。
const bookKey = b => (b.material_book_id != null
  ? `m${b.material_book_id}`
  : `s${b.legacy_ref?.list_id}|${b.legacy_ref?.book ?? ''}`);

// 這本書這次選了幾項。打開過的以剛算出來的為準，沒打開過的用清單帶回來的。
const bookCount = (b, counts, draft) => {
  const id = b.material_book_id;
  if (id == null) return 0;
  if (counts[id] !== undefined) return counts[id];
  return draft ? 0 : (b.selected_count ?? 0);
};

// 草稿選取集合的更新。回傳新的 Set，不就地修改——React 才看得到變化。
function toggleDraft(current, ids, selected) {
  const next = new Set(current || []);
  for (const id of ids) { if (selected) next.add(id); else next.delete(id); }
  return next;
}

/* ---------- 主元件 ---------- */

// planId == null → Create Plan 的草稿模式：Plan 還不存在，選取先留在前端，
//                   建立 Plan 之後才送到正式 API（見 material.js applyDraftSelection）
// planId != null → Edit Plan：每一次點擊都直接寫正式 selection API，狀態以後端為準
export default function MaterialSelector({
  planId = null, draftIds = null, onDraftChange = null, onSelectionChange = null,
  onPickedChange = null, footer = null, header = null, lists = [], onLibraryChange = null,
}) {
  const draft = planId == null;
  const [books, setBooks] = useState([]);
  // 'shelf' 書櫃｜'book' 打開一本｜'check' 確認教材內容｜'add' 加入教材
  const [view, setView] = useState('shelf');
  const [pending, setPending] = useState(null);  // 正在確認內容的那一本
  const [openBook, setOpenBook] = useState(null);
  const [tree, setTree] = useState(null);
  const [rawTree, setRawTree] = useState(null);
  const [openCh, setOpenCh] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState(null);
  const [counts, setCounts] = useState({});      // book_id → 這個 Plan 已選幾項

  // 書櫃只讀一份統一的清單。前端不需要知道每一本從哪裡來，
  // 也不做任何「這兩本是不是同一本」的比對——書名不是身分。
  const loadShelf = useCallback(async () => {
    const r = await listShelf({ planId: draft ? null : planId });
    setBooks(r.books || []);
    return r.books || [];
  }, [planId, draft]);

  useEffect(() => { loadShelf().catch(e => setErr(e.message)); }, [loadShelf]);

  const loadTree = useCallback(async bookId => {
    const raw = await getBookTree(bookId, { planId: draft ? null : planId });
    const t = draft ? applyDraftSelection(raw, draftIds) : raw;
    setRawTree(raw);
    setTree(t);
    setCounts(c => ({ ...c, [bookId]: countSelected(t) }));
    return t;
  }, [planId, draft, draftIds]);

  // 每次選取後重讀整棵樹：tri-state 與 progress 都以後端為準，
  // 前端不自己推算下一個狀態（那就是第二套 truth 的起點）。
  const refresh = useCallback(async (...responses) => {
    const b = collectBlocked(...responses);
    if (b.length) setBlocked({ blocked: b, cancelled: collectCancelled(...responses) });
    if (openBook != null) {
      const t = await loadTree(openBook);
      onSelectionChange?.(t);
    }
  }, [openBook, loadTree, onSelectionChange]);

  const toggleItem = async item => {
    if (item.completed) return;                 // 已完成的教材不參與 selection
    if (draft) {
      onDraftChange?.(toggleDraft(draftIds, [item.id], !item.selected));
      reportPicked([item], !item.selected);
      return;
    }
    setBusy(true); setErr('');
    try { await refresh(await selectItems(planId, [item.id], !item.selected)); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // 節點 checkbox 永遠只做批次 selection。partial 與 none 都往「全選」走，
  // all 才是取消——這是最不會讓人意外的方向。
  const toggleNode = async node => {
    const want = node.selection !== 'all';
    // 草稿模式也只動「尚未完成」的項目，與後端 selectNode 的行為一致
    if (draft) {
      const ids = openItemIdsUnder(node);
      onDraftChange?.(toggleDraft(draftIds, ids, want));
      reportPicked(flattenItems({ nodes: [node] }).filter(i => ids.includes(i.id)), want);
      return;
    }
    setBusy(true); setErr('');
    try { await refresh(await selectNode(planId, node.id, want)); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // 把被選／取消的項目描述往上送。descriptor 只用於排程與顯示，
  // identity 永遠是 content_item_id——不用 title 當 key。
  const reportPicked = useCallback((items, selected) => {
    if (!onPickedChange) return;
    onPickedChange(items.map(i => ({
      id: i.id,
      title: i.title,
      kind: i.kind,
      estimated_minutes: i.estimated_minutes ?? null,
      book_id: rawTree?.book?.id ?? tree?.book?.id ?? null,
      book_title: rawTree?.book?.title ?? tree?.book?.title ?? '',
      path: i.path || [],
    })), selected);
  }, [onPickedChange, rawTree, tree]);

  // 草稿選取改變時重算這一棵樹（不重新打 API：completion 沒變）
  useEffect(() => {
    if (!draft || !rawTree) return;
    const t = applyDraftSelection(rawTree, draftIds);
    setTree(t);
    setCounts(c => ({ ...c, [rawTree.book.id]: countSelected(t) }));
  }, [draft, rawTree, draftIds]);

  // 打開一本教材。還沒確認過內容的，先問一次「這本教材裡有哪些內容」——
  // 那是學生第一次真的要用它的時候，不是另外一個要他自己去找的管理動作。
  const openShelfBook = book => {
    setErr('');
    if (book.requires_content_confirmation) { setPending(book); setView('check'); return; }
    setOpenBook(book.material_book_id);
    setView('book');
    loadTree(book.material_book_id).catch(e => setErr(e.message));
  };

  // 教材剛剛建立或剛確認完內容：重讀書櫃，然後直接打開它。
  // 學生的下一個動作一定是「選這本裡面的內容」，不該再被丟回書單自己找一次。
  const afterCreated = async bookId => {
    const list = await loadShelf().catch(() => []);
    onLibraryChange?.();
    const b = list.find(x => x.material_book_id === bookId);
    setPending(null);
    if (b) openShelfBook(b); else setView('shelf');
  };

  // 沒有指定科目的書：可以看內容，但不能選取（選了也排不進去）
  const locked = openBook != null
    && bookNeedsSubject(books.find(b => b.material_book_id === openBook));

  const total = draft
    ? (draftIds ? draftIds.size : 0)
    : Object.values(counts).reduce((a, b) => a + b, 0);

  if (err && !tree && view === 'shelf' && !books.length) {
    return <div className="mt-err" role="alert">{err}</div>;
  }

  if (view === 'check' && pending) {
    return (
      <div className="mt-selector">
        <MaterialContentCheck book={pending}
          onCancel={() => { setPending(null); setView('shelf'); }}
          onDone={r => afterCreated(r?.book?.id)} />
      </div>
    );
  }

  if (view === 'add') {
    return (
      <div className="mt-selector">
        <AddMaterialFlow lists={lists}
          onCancel={() => setView('shelf')}
          onCreated={r => afterCreated(r?.book?.id)} />
      </div>
    );
  }

  return (
    <div className="mt-selector">
      {blocked && <BlockedNotice data={blocked} onClose={() => setBlocked(null)} />}

      {view === 'shelf' ? (
        <>
          {header}
          {!books.length ? (
            <div className="mt-empty">
              <EmptyState title="還沒有教材"
                description="加入你的第一本教材，就可以選擇要安排的內容。" />
              <Button variant="primary" onClick={() => setView('add')}>＋ 加入教材</Button>
            </div>
          ) : (
            <>
              <div className="mt-section-label">選擇要讀的內容</div>
              <div className="mt-booklist">
                {books.map(b => (
                  <button key={bookKey(b)} type="button" className="mt-book"
                    onClick={() => openShelfBook(b)}>
                    <span className="mt-book-main">
                      <span className="mt-book-title">{b.title}</span>
                      {b.publisher && <span className="mt-book-sub">{b.publisher}</span>}
                      {/* 沒有科目就排不進計畫。在第一層就講，不要等到排程最後才失敗。 */}
                      {bookNeedsSubject(b) && <span className="mt-warn">需要先指定科目</span>}
                    </span>
                    <span className="mt-book-meta">
                      {b.progress && (
                        <span className="mt-progress-text">
                          {b.progress.completed_items}/{b.progress.total_items}
                        </span>
                      )}
                      {bookCount(b, counts, draft) > 0 && (
                        <span className="mt-badge">已選 {bookCount(b, counts, draft)}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
              <button type="button" className="mt-add-book" onClick={() => setView('add')}>
                ＋ 加入教材
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <div className="mt-tree-head">
            <Button size="sm" variant="tertiary"
              onClick={() => { setOpenBook(null); setTree(null); setView('shelf'); }}>
              ← 所有教材
            </Button>
            <span className="mt-tree-title">{tree?.book?.title}</span>
          </div>
          {err && <div className="mt-err" role="alert">{err}</div>}
          {locked && (
            <div className="mt-source-note" role="alert">
              這本教材還沒有指定科目，所以不能加入計畫——排程是以科目分組的。
              請到「更多 → 教材庫」為它設定科目後再回來。
            </div>
          )}
          {!tree ? <div className="mt-loading">載入中…</div>
            : !tree.nodes.length ? (
              <EmptyState title="這本教材還沒有內容"
                description="到「更多 → 教材庫」加入章、節／主題與內容。" />
            ) : (
              <div className="mt-tree">
                {tree.nodes.map(ch => (
                  <ChapterNode key={ch.id} node={ch} busy={busy || locked}
                    open={!!openCh[ch.id]}
                    onOpen={v => setOpenCh(s => ({ ...s, [ch.id]: v }))}
                    onToggleNode={toggleNode} onToggleItem={toggleItem} />
                ))}
              </div>
            )}
        </>
      )}

      <div className="mt-footer">
        <span className="mt-count" aria-live="polite">已選 {total} 項</span>
        {footer}
      </div>
    </div>
  );
}
