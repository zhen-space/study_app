import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listShelf, getBookTree, getPlanSelection, selectItems, selectNode, selectBookNodes,
  ITEM_LABEL, CHAPTER_LEVEL_KINDS, countSelected, collectBlocked, collectCancelled,
  applyDraftSelection, openItemIdsUnder, flattenItems, bookNeedsSubject,
} from './material';
import { Button, EmptyState } from './ui';
import BlockedNotice from './BlockedNotice';
import MaterialContentCheck from './MaterialContentCheck';
import AddMaterialFlow from './AddMaterialFlow';
import MaterialBookEditor from './MaterialBookEditor';

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

// 完成度只在真的有進度時才寫出來。「已完成 0／3」對學生沒有任何用處，
// 只是每一列都多一組看不懂的數字。
const doneText = p =>
  (p && p.completed_items > 0 ? `已完成 ${p.completed_items}／${p.total_items}` : '');

// memo：教材大一點就是兩百多列，動一個 checkbox 不該把每一列都重畫一次。
// props 都是 stable 的（callback 都包過 useCallback），所以擋得住。
const ItemRow = memo(function ItemRow({ item, locked, onToggle }) {
  const state = item.completed ? 'completed' : item.selected ? 'checked' : 'unchecked';
  const label = ITEM_LABEL[item.kind] || item.kind;
  // 標題本來就是「課本內容」時，底下再掛一個「課本內容」標籤是純噪音。
  // 只有標題與種類講的不是同一件事才需要標出來。
  const showKind = !String(item.title).startsWith(label);
  return (
    <div className={'mt-item' + (item.completed ? ' is-done' : '')}>
      <SelectBox state={state} disabled={locked || item.completed} label={item.title}
        onToggle={() => onToggle(item)} />
      <div className="mt-item-main">
        <div className="mt-item-title">{item.title}</div>
        {(showKind || item.completed) && (
          <div className="mt-item-meta">
            {showKind && <span className="mt-kind">{label}</span>}
            {item.completed && <span className="mt-done-text">已完成</span>}
          </div>
        )}
      </div>
    </div>
  );
});

/* ---------- Section / Topic（Chapter 的同層子節點） ---------- */

const ChildNode = memo(function ChildNode({ node, locked, onToggleNode, onToggleItem }) {
  const items = node.content_items || [];
  const selectable = items.some(i => !i.completed);
  return (
    <div className="mt-child">
      <div className="mt-child-head">
        <SelectBox state={selectable ? node.selection : 'completed'} disabled={locked || !selectable}
          label={`${node.title}（整組）`} onToggle={() => onToggleNode(node)} />
        <div className="mt-child-main">
          <span className="mt-child-title">{node.title}</span>
          {/* Section 與 Topic 是同層。標籤要寫出來，學生才不會以為主題被包在節底下 */}
          <span className={'mt-tag mt-tag--' + node.kind}>{node.kind === 'section' ? '節' : '主題'}</span>
        </div>
        <span className="mt-progress-text">{doneText(node.progress)}</span>
      </div>
      <div className="mt-child-items">
        {items.map(it => <ItemRow key={it.id} item={it} locked={locked} onToggle={onToggleItem} />)}
      </div>
    </div>
  );
});

/* ---------- Chapter ---------- */

const ChapterNode = memo(function ChapterNode({ node, open, onOpen, locked, onToggleNode, onToggleItem }) {
  const own = node.content_items || [];
  // 章自己直接掛的單元練習／歷屆試題。它們**不屬於任何 Section**，
  // 所以畫在與 Section / Topic 同一層，而且標明「本章」。
  const chapterLevel = own.filter(i => CHAPTER_LEVEL_KINDS.includes(i.kind));
  const chapterReading = own.filter(i => !CHAPTER_LEVEL_KINDS.includes(i.kind));
  const selectable = node.progress.completed_items < node.progress.total_items;
  return (
    <div className="mt-chapter">
      <div className="mt-chapter-head">
        <SelectBox state={selectable ? node.selection : 'completed'} disabled={locked || !selectable}
          label={`${node.title}（整章）`} onToggle={() => onToggleNode(node)} />
        <button type="button" className="mt-chapter-btn" aria-expanded={open}
          onClick={() => onOpen(!open)}>
          <span className="mt-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="mt-chapter-title">{node.title}</span>
          <span className="mt-progress-text">{doneText(node.progress)}</span>
        </button>
      </div>
      {open && (
        <div className="mt-chapter-body">
          {chapterReading.map(it => <ItemRow key={it.id} item={it} locked={locked} onToggle={onToggleItem} />)}
          {(node.children || []).map(c => (
            <ChildNode key={c.id} node={c} locked={locked}
              onToggleNode={onToggleNode} onToggleItem={onToggleItem} />
          ))}
          {chapterLevel.length > 0 && (
            <div className="mt-chapter-level">
              <div className="mt-chapter-level-label">本章直屬</div>
              {chapterLevel.map(it => <ItemRow key={it.id} item={it} locked={locked} onToggle={onToggleItem} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

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
  onAddSubject = null,
}) {
  const draft = planId == null;
  const [books, setBooks] = useState([]);
  // 'shelf' 書櫃｜'book' 打開一本｜'check' 確認教材內容｜'add' 加入教材
  const [view, setView] = useState('shelf');
  const [pending, setPending] = useState(null);  // 正在確認內容的那一本
  const [openBook, setOpenBook] = useState(null);
  const [rawTree, setRawTree] = useState(null);  // 後端給的樹：completion 的來源
  const [openCh, setOpenCh] = useState({});
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState(null);
  const [counts, setCounts] = useState({});      // book_id → 這個 Plan 已選幾項

  // 「這次要讀哪些」的**唯一**一份狀態，兩個模式共用。
  //
  // 之前 Create 用草稿集合、Edit 用書櫃回來的 selected_count，而「下一步」
  // 又是看第三個東西（能不能排程）。三份數字只要有一份對不上，就會出現
  // 「已選 6 項，但下一步是灰的」這種說不通的畫面。現在只有這一份。
  //
  // completion 仍然完全以後端為準（在 rawTree 裡），這裡只管 selection。
  const [sel, setSel] = useState(() => new Set(draftIds || []));
  const selRef = useRef(sel);
  selRef.current = sel;

  // 書櫃只讀一份統一的清單。前端不需要知道每一本從哪裡來，
  // 也不做任何「這兩本是不是同一本」的比對——書名不是身分。
  const loadShelf = useCallback(async () => {
    const r = await listShelf({ planId: draft ? null : planId });
    setBooks(r.books || []);
    return r.books || [];
  }, [planId, draft]);

  useEffect(() => { loadShelf().catch(e => setErr(e.message)); }, [loadShelf]);

  // Edit：這個 Plan 目前選了哪些，一次讀回來當初始狀態。
  // 之後畫面就以本地這一份為準，每次點擊不再重新跟後端要一次。
  useEffect(() => {
    if (draft || planId == null) return;
    let alive = true;
    getPlanSelection(planId)
      .then(rows => {
        if (!alive) return;
        setSel(new Set(rows
          .filter(r => r.selected && !r.material_completed)
          .map(r => r.content_item_id)));
      })
      .catch(e => setErr(e.message));   // 讀不到就說出來，不要靜靜地顯示 0
    return () => { alive = false; };
  }, [draft, planId]);

  // Create：外面的草稿集合是同一份東西，跟著它走。
  useEffect(() => { if (draft) setSel(new Set(draftIds || [])); }, [draft, draftIds]);

  // 只在「打開一本教材」時抓樹。選取不再重抓——樹裡跟選取有關的部分
  // 本來就能用同一組規則在本地算出來（applyDraftSelection 與後端 buildTree 一致），
  // completion 則完全沒有被 selection 改變過。
  const loadTree = useCallback(async bookId => {
    const raw = await getBookTree(bookId, { planId: draft ? null : planId });
    setRawTree(raw);
    return raw;
  }, [planId, draft]);

  // 樹載入時（帶 plan_id）本身就帶著後端對這本書的答案。把它合併進本地那一份，
  // 這本書就以剛拿到的伺服器狀態為準；其他書維持原樣。
  //
  // 只在 rawTree 換掉時跑——樂觀更新不會重抓樹，所以不會把剛點的那一下蓋回去。
  useEffect(() => {
    if (draft || !rawTree) return;
    const items = flattenItems(rawTree);
    setSel(prev => {
      const next = new Set(prev);
      for (const i of items) {
        if (i.completed || !i.selected) next.delete(i.id);
        else next.add(i.id);
      }
      return next;
    });
  }, [draft, rawTree]);

  // 畫面上的樹＝後端的 completion ＋ 本地的 selection。
  const tree = useMemo(
    () => (rawTree ? applyDraftSelection(rawTree, sel) : null), [rawTree, sel]);

  // 這本書選了幾項，跟著本地選取即時更新。
  useEffect(() => {
    if (!tree?.book) return;
    setCounts(c => ({ ...c, [tree.book.id]: countSelected(tree) }));
  }, [tree]);

  // 把選取的變化往上送。identity 永遠是 content_item_id，不用 title 當 key。
  const reportPicked = useCallback((items, selected) => {
    if (!onPickedChange || !items.length) return;
    onPickedChange(items.map(i => ({
      id: i.id,
      title: i.title,
      kind: i.kind,
      estimated_minutes: i.estimated_minutes ?? null,
      book_id: rawTree?.book?.id ?? null,
      book_title: rawTree?.book?.title ?? '',
      path: i.path || [],
    })), selected);
  }, [onPickedChange, rawTree]);

  // 先改畫面，再送出去。
  //
  // 之前每點一下都是「POST → 等 → 重抓整棵樹 → 等 → 才更新畫面」，而且整棵樹
  // 在等待期間全部 disabled。在本機看起來還好，在真的網路上就是每按一次卡一下。
  //
  // 現在畫面立刻反應，請求在背景走。失敗就把剛才那一步收回來並說明——
  // 不會留下「畫面說選了、後端其實沒有」的假象。
  const applyLocal = useCallback((ids, selected) => {
    if (!ids.length) return;
    setSel(prev => {
      const next = new Set(prev);
      for (const id of ids) { if (selected) next.add(id); else next.delete(id); }
      return next;
    });
  }, []);

  const rollback = useCallback((ids, selected) => {
    applyLocal(ids, !selected);
    if (draft) onDraftChange?.(toggleDraft(selRef.current, ids, !selected));
  }, [applyLocal, draft, onDraftChange]);

  // 背景同步。回應裡的 blocked / task_exits 一定要浮出來，不能靜默吞掉。
  const sync = useCallback(async (ids, selected, send) => {
    if (draft) return;                       // Plan 還不存在，沒有東西可以同步
    try {
      const r = await send();
      const bl = collectBlocked(r);
      if (bl.length) setBlocked({ blocked: bl, cancelled: collectCancelled(r) });
      // 後端回報有東西被擋住時，以後端為準重新對一次——那是本地算不出來的狀態
      if (bl.length && openBook != null) await loadTree(openBook).catch(() => {});
    } catch (e) {
      setErr(e.message);
      rollback(ids, selected);
    }
  }, [draft, openBook, loadTree, rollback]);

  const toggleItem = useCallback(item => {
    if (item.completed) return;                 // 已完成的教材不參與 selection
    const want = !sel.has(item.id);
    applyLocal([item.id], want);
    reportPicked([item], want);
    if (draft) { onDraftChange?.(toggleDraft(sel, [item.id], want)); return; }
    sync([item.id], want, () => selectItems(planId, [item.id], want));
  }, [sel, applyLocal, reportPicked, draft, onDraftChange, sync, planId]);

  // 節點 checkbox 永遠只做批次選取。partial 與 none 都往「全選」走，
  // all 才是取消——這是最不會讓人意外的方向。
  //
  // **一次一個請求**：後端的 node 端點自己會展開底下所有未完成的 ContentItem。
  // 前端絕對不在這裡跑迴圈逐項送。
  const toggleNode = useCallback(node => {
    const want = node.selection !== 'all';
    const ids = openItemIdsUnder(node);          // 只動尚未完成的，與後端一致
    if (!ids.length) return;
    applyLocal(ids, want);
    reportPicked(flattenItems({ nodes: [node] }).filter(i => ids.includes(i.id)), want);
    if (draft) { onDraftChange?.(toggleDraft(sel, ids, want)); return; }
    sync(ids, want, () => selectNode(planId, node.id, want));
  }, [sel, applyLocal, reportPicked, draft, onDraftChange, sync, planId]);

  // 整本教材的快速選取（全選章／全選節／全選主題／清除）。
  // 同樣是一個請求：後端一次算完，不是每一章各打一次。
  // 這一層有哪些「可以被選」的內容（已完成的永遠不算——它是教材的長期完成
  // 狀態，不是這次要不要排）。
  const eligibleIds = useCallback(nodeKinds => {
    if (!tree) return [];
    const all = flattenItems(tree);
    const scoped = nodeKinds == null ? all : all.filter(i => nodeKinds.includes(i.node?.kind));
    return scoped.filter(i => !i.completed);
  }, [tree]);

  // 快速選取是 toggle：還沒全選就全選，已經全選就整層取消。
  // 按同一顆按鈕兩次要回到原點，這是按鈕最基本的預期。
  const quickSelect = useCallback(nodeKinds => {
    const items = eligibleIds(nodeKinds);
    if (!items.length) return;
    const ids = items.map(i => i.id);
    const want = !ids.every(id => sel.has(id));   // 全選了才是取消
    applyLocal(ids, want);
    reportPicked(items, want);
    if (draft) { onDraftChange?.(toggleDraft(sel, ids, want)); return; }
    sync(ids, want, () => selectBookNodes(planId, tree.book.id, { selected: want, nodeKinds }));
  }, [tree, sel, eligibleIds, applyLocal, reportPicked, draft, onDraftChange, sync, planId]);

  // 打開一本教材。還沒確認過內容的，先問一次「這本教材裡有哪些內容」——
  // 那是學生第一次真的要用它的時候，不是另外一個要他自己去找的管理動作。
  const openShelfBook = book => {
    setErr('');
    if (book.requires_content_confirmation) { setPending(book); setView('check'); return; }
    setOpenBook(book.material_book_id);
    setRawTree(null);
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

  // 書櫃依科目分堆。只有一個科目時不畫分組標題——一個標題底下放全部，
  // 那只是多一行字。沒有指定科目的排在最後，並在列上直接標示。
  const grouped = useMemo(() => {
    const byId = new Map(lists.map(l => [String(l.id), l.name]));
    const m = new Map();
    for (const b of books) {
      const k = b.subject_list_id == null ? '' : String(b.subject_list_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(b);
    }
    const named = [...m.entries()].filter(([k]) => k !== '');
    const none = m.get('') || [];
    const single = named.length <= 1 && !none.length;
    const out = named
      .sort((a, b2) => (byId.get(a[0]) || '').localeCompare(byId.get(b2[0]) || '', 'zh-Hant'))
      .map(([k, bs]) => ({ key: k, name: single ? '' : (byId.get(k) || '其他'), books: bs }));
    if (none.length) out.push({ key: 'none', name: '還沒指定科目', books: none });
    return out;
  }, [books, lists]);

  // 這本教材實際上有哪幾層。沒有主題的書就不該出現「全選主題」——
  // 按了什麼都不會發生的按鈕比沒有按鈕更糟。
  const quickKinds = useMemo(() => {
    if (!tree) return [];
    const kinds = new Set();
    for (const ch of tree.nodes || []) {
      if ((ch.content_items || []).some(i => !i.completed)) kinds.add('chapter');
      for (const c of ch.children || []) {
        if ((c.content_items || []).some(i => !i.completed)) kinds.add(c.kind);
      }
    }
    const out = [];
    if (kinds.size > 1) out.push({ key: 'all', label: '全選', kinds: null });
    if (kinds.has('chapter')) out.push({ key: 'chapter', label: '全選章', kinds: ['chapter'] });
    if (kinds.has('section')) out.push({ key: 'section', label: '全選節', kinds: ['section'] });
    if (kinds.has('topic')) out.push({ key: 'topic', label: '全選主題', kinds: ['topic'] });
    return out;
  }, [tree]);

  // 這一層已經全選了嗎——決定按鈕現在該說「全選節」還是「取消全選節」。
  const quickOn = useCallback(nodeKinds => {
    const items = eligibleIds(nodeKinds);
    return items.length > 0 && items.every(i => sel.has(i.id));
  }, [eligibleIds, sel]);

  // 沒有指定科目的書：可以看內容，但不能選取（選了也排不進去）
  const locked = openBook != null
    && bookNeedsSubject(books.find(b => b.material_book_id === openBook));

  // 「已選 N 項」與「下一步」用的是同一個數字，而且就是畫面上那些勾的數量。
  // 這是整個第 1 步唯一的 selection source of truth。
  const total = sel.size;
  useEffect(() => { onSelectionChange?.(total); }, [total, onSelectionChange]);

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

  // 「編輯教材內容」是**另一個畫面**，不是把結構編輯塞進勾選畫面裡。
  // 這本教材有哪些內容，跟這次要讀哪些，是兩件事。
  if (view === 'edit' && tree) {
    return (
      <div className="mt-selector">
        <MaterialBookEditor book={tree.book} tree={tree} lists={lists}
          onChanged={async () => { await loadTree(openBook).catch(() => {}); await loadShelf().catch(() => {}); }}
          onDone={() => setView('book')} />
      </div>
    );
  }

  if (view === 'add') {
    return (
      <div className="mt-selector">
        <AddMaterialFlow lists={lists} onAddSubject={onAddSubject}
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
              {/* 依科目分組。科目是教材已經有的正式欄位（material_books.subject_list_id
                  → lists.id），這裡只是照它分堆——不是另一套要學生自己維護的分類。 */}
              {grouped.map(g => (
                <div key={g.key} className="mt-subject-group">
                  <div className="mt-subject-name">{g.name}</div>
                  <div className="mt-booklist">
                    {g.books.map(b => (
                      <button key={bookKey(b)} type="button" className="mt-book"
                        onClick={() => openShelfBook(b)}>
                        <span className="mt-book-main">
                          <span className="mt-book-title">{b.title}</span>
                          {b.publisher && <span className="mt-book-sub">{b.publisher}</span>}
                          {/* 沒有科目就排不進計畫。在第一層就講，不要等到排程最後才失敗。 */}
                          {bookNeedsSubject(b) && <span className="mt-warn">需要先指定科目</span>}
                        </span>
                        <span className="mt-book-meta">
                          {doneText(b.progress) && (
                            <span className="mt-progress-text">{doneText(b.progress)}</span>
                          )}
                          {bookCount(b, counts, draft) > 0 && (
                            <span className="mt-badge">已選 {bookCount(b, counts, draft)}</span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
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
              onClick={() => { setOpenBook(null); setRawTree(null); setView('shelf'); }}>
              ← 所有教材
            </Button>
            <span className="mt-tree-title">{tree?.book?.title}</span>
            {tree && (
              <button type="button" className="mt-edit-link" onClick={() => setView('edit')}>
                編輯教材內容
              </button>
            )}
          </div>
          {err && <div className="mt-err" role="alert">{err}</div>}
          {locked && (
            <div className="mt-source-note" role="alert">
              這本教材還沒有指定科目，所以不能加入計畫——排程是以科目分組的。
              請到「更多 → 教材庫」為它設定科目後再回來。
            </div>
          )}
          {tree && tree.nodes.length > 0 && !locked && (
            <div className="mt-quick">
              {/* 快速選取：只動「尚未完成」的內容，一次一個請求。
                  教材裡沒有那一層時整顆按鈕就不出現，按了不會出錯。 */}
              <span className="mt-quick-label">快速選取</span>
              {quickKinds.map(q => {
                const on = quickOn(q.kinds);
                return (
                  <button key={q.key} type="button"
                    className={'mt-quick-btn' + (on ? ' on' : '')}
                    aria-pressed={on}
                    onClick={() => quickSelect(q.kinds)}>
                    {on ? `取消${q.label}` : q.label}
                  </button>
                );
              })}
            </div>
          )}
          {!tree ? <div className="mt-loading">載入中…</div>
            : !tree.nodes.length ? (
              <EmptyState title="這本教材還沒有內容"
                description="到「更多 → 教材庫」加入章、節／主題與內容。" />
            ) : (
              <div className="mt-tree">
                {tree.nodes.map(ch => (
                  <ChapterNode key={ch.id} node={ch} locked={locked}
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
        {/* 打開一本教材時只給「完成選擇」——它只是回到書櫃。
            真正的「下一步」只存在書櫃，因為那裡才看得到所有教材的選取結果。
            兩者放在同一個位置會讓人在還沒挑完就離開第 1 步。 */}
        {view === 'book'
          ? (
            <Button variant="primary" style={{ marginLeft: 'auto' }}
              onClick={() => { setOpenBook(null); setRawTree(null); setView('shelf'); }}>
              完成選擇
            </Button>
          )
          : footer}
      </div>
    </div>
  );
}
