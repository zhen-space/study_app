import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listCategories, listBooks, getBookTree, setItemCompletion, createCategory, createBook,
  addBookToCategory, updateBook, bookNeedsSubject, ITEM_LABEL, CHAPTER_LEVEL_KINDS,
  collectBlocked, collectCancelled,
} from './material';
import { Button, EmptyState, PageHeader, SegmentedControl, ProgressBar } from './ui';
import BlockedNotice from './BlockedNotice';
import MaterialBookEditor from './MaterialBookEditor';

// 教材庫：長期教材 identity、目錄與完成度的正式入口。
//
// 這裡是唯一可以改 Material completion 的地方。Plan 的 selection checkbox
// 不在這個頁面，也不會出現在這裡——兩個 domain 不混。
//
// Category 是整理方式，不是 Plan：它只 reference Book。同一本書出現在兩個
// 分類裡永遠是同一本書（同一份 identity、同一份目錄、同一份完成度）。

function CompletionRow({ item, busy, onToggle }) {
  return (
    <div className={'ml-item' + (item.completed ? ' is-done' : '')}>
      <button type="button" role="checkbox" aria-checked={item.completed} disabled={busy}
        aria-label={`${item.title}：${item.completed ? '已完成，點擊改為未完成' : '未完成，點擊標記完成'}`}
        className={'ml-check' + (item.completed ? ' on' : '')}
        onClick={() => onToggle(item)}>
        <span aria-hidden="true">{item.completed ? '✓' : ''}</span>
      </button>
      <div className="ml-item-main">
        <div className="ml-item-title">{item.title}</div>
        <div className="ml-item-meta">
          <span className="mt-kind">{ITEM_LABEL[item.kind] || item.kind}</span>
          {/* 完成狀態不只靠顏色：有勾、有文字 */}
          {item.completed && <span className="mt-done-text">已完成</span>}
        </div>
      </div>
    </div>
  );
}

function ChildNode({ node, busy, onToggle }) {
  return (
    <div className="ml-child">
      <div className="ml-child-head">
        <span className="ml-child-title">{node.title}</span>
        <span className={'mt-tag mt-tag--' + node.kind}>{node.kind === 'section' ? '節' : '主題'}</span>
        <span className="mt-progress-text">
          {node.progress.completed_items}/{node.progress.total_items}
        </span>
      </div>
      {(node.content_items || []).map(it =>
        <CompletionRow key={it.id} item={it} busy={busy} onToggle={onToggle} />)}
    </div>
  );
}

function Chapter({ node, open, onOpen, busy, onToggle }) {
  const own = node.content_items || [];
  const chapterLevel = own.filter(i => CHAPTER_LEVEL_KINDS.includes(i.kind));
  const reading = own.filter(i => !CHAPTER_LEVEL_KINDS.includes(i.kind));
  return (
    <div className="ml-chapter">
      <button type="button" className="ml-chapter-head" aria-expanded={open} onClick={() => onOpen(!open)}>
        <span className="mt-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="ml-chapter-title">{node.title}</span>
        <span className="mt-progress-text">
          {node.progress.completed_items}/{node.progress.total_items}
        </span>
      </button>
      {open && (
        <div className="ml-chapter-body">
          {reading.map(it => <CompletionRow key={it.id} item={it} busy={busy} onToggle={onToggle} />)}
          {(node.children || []).map(c =>
            <ChildNode key={c.id} node={c} busy={busy} onToggle={onToggle} />)}
          {chapterLevel.length > 0 && (
            <div className="mt-chapter-level">
              <div className="mt-chapter-level-label">本章直屬</div>
              {chapterLevel.map(it =>
                <CompletionRow key={it.id} item={it} busy={busy} onToggle={onToggle} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// lists 就是「科目」。教材的科目一律以 lists.id 保存（material_books.subject_list_id），
// UI 只拿名稱來顯示，絕不用名稱當 identity。
export default function MaterialLibraryView({ goPlans = null, lists = [] }) {
  const [categories, setCategories] = useState([]);
  const [books, setBooks] = useState([]);
  const [scope, setScope] = useState('all');
  const [openBook, setOpenBook] = useState(null);
  const [tree, setTree] = useState(null);
  const [openCh, setOpenCh] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState('');
  const [addSubject, setAddSubject] = useState('');

  const load = useCallback(async () => {
    const [c, b] = await Promise.all([listCategories(), listBooks()]);
    setCategories(c); setBooks(b);
  }, []);

  useEffect(() => { load().catch(e => setErr(e.message)); }, [load]);

  const openTree = async bookId => {
    setOpenBook(bookId);
    setEditing(false);
    setTree(null);
    try { setTree(await getBookTree(bookId)); } catch (e) { setErr(e.message); }
  };

  // 手動標記完成／未完成一律走正式 completion endpoint。
  // 完成可能連帶讓其他 Plan 的任務退出排程；被鎖定擋住的必須讓使用者看到。
  const toggle = async item => {
    setBusy(true); setErr('');
    try {
      const r = await setItemCompletion(item.id, !item.completed);
      const b = collectBlocked(r);
      if (b.length) setBlocked({ blocked: b, cancelled: collectCancelled(r) });
      setTree(await getBookTree(openBook));
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // 既有教材補科目的 remediation 入口。null 代表清掉（後端接受 null）。
  const saveSubject = async value => {
    setBusy(true); setErr('');
    try {
      await updateBook(openBook, { subject_list_id: value === '' ? null : Number(value) });
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const visibleBooks = useMemo(() => {
    if (scope === 'all') return books;
    const cat = categories.find(c => String(c.id) === String(scope));
    const ids = new Set((cat?.books || []).map(b => b.id));
    return books.filter(b => ids.has(b.id));
  }, [scope, books, categories]);

  // 這本書出現在哪些分類。用來說明「同一本書可以在多個分類」，
  // 避免學生以為那是兩本不同的教材。
  const catsOf = useCallback(bookId => categories
    .filter(c => (c.books || []).some(b => b.id === bookId))
    .map(c => c.name), [categories]);

  const addBook = async () => {
    const title = adding.trim();
    if (!title) return;
    setBusy(true);
    try {
      // 建立時就把科目一起送出去，不要讓學生在排程最後才發現排不進去。
      const b = await createBook({
        title,
        ...(addSubject ? { subject_list_id: Number(addSubject) } : {}),
      });
      if (scope !== 'all') await addBookToCategory(scope, b.id);
      setAdding(''); setAddSubject('');
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (openBook != null) {
    const book = books.find(b => b.id === openBook);
    const inCats = catsOf(openBook);
    return (
      <div className="main">
        <PageHeader title={tree?.book?.title || book?.title || '教材'}
          subtitle={book?.publisher || ''}
          back={<button className="page-back"
            onClick={() => { setOpenBook(null); setTree(null); setEditing(false); }}>← 教材庫</button>}
          actions={tree ? (
            <Button size="sm" variant="tertiary" onClick={() => setEditing(v => !v)}>
              {editing ? '完成編輯' : '編輯'}
            </Button>
          ) : null} />
        <div className="main-body ml-view">
        {blocked && <BlockedNotice data={blocked} onClose={() => setBlocked(null)} />}
        {err && <div className="mt-err" role="alert">{err}</div>}
        {/* 科目是排程的前提，所以直接放在教材頁最上面，隨時可改。
            存的是 lists.id，不是名稱。
            編輯模式底下有自己的科目欄位，這裡就不再重複一個。 */}
        {!editing && (
        <div className={'ml-subject' + (bookNeedsSubject(book) ? ' needs' : '')}>
          <label htmlFor="ml-subject-select">科目</label>
          <select id="ml-subject-select" value={book?.subject_list_id ?? ''} disabled={busy}
            onChange={e => saveSubject(e.target.value)}>
            <option value="">未指定</option>
            {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {bookNeedsSubject(book) && (
            <span className="mt-warn">未指定科目的教材無法排入計畫</span>
          )}
        </div>
        )}
        {!editing && inCats.length > 1 && (
          <div className="ml-samebook">
            這本教材同時列在 {inCats.map(n => `「${n}」`).join('、')}，
            但只有一份目錄與一份完成度。
          </div>
        )}
        {editing && tree && (
          <MaterialBookEditor book={book} tree={tree} lists={lists}
            onChanged={async () => { setTree(await getBookTree(openBook)); await load(); }}
            onDone={() => setEditing(false)} />
        )}
        {!editing && tree && (
          <div className="ml-bookprog">
            <ProgressBar value={tree.progress.completed_items} max={tree.progress.total_items}
              label="教材完成度" />
            <span className="mt-progress-text">
              {tree.progress.completed_items}/{tree.progress.total_items}（{tree.progress.percent}%）
            </span>
          </div>
        )}
        {editing ? null
          : !tree ? <div className="mt-loading">載入中…</div>
          : !tree.nodes.length
            ? <EmptyState title="這本教材還沒有目錄" description="目前沒有章節內容。" />
            : (
              <div className="ml-tree">
                {tree.nodes.map(ch => (
                  <Chapter key={ch.id} node={ch} busy={busy}
                    open={!!openCh[ch.id]}
                    onOpen={v => setOpenCh(s => ({ ...s, [ch.id]: v }))}
                    onToggle={toggle} />
                ))}
              </div>
            )}
        </div>
      </div>
    );
  }

  return (
    <div className="main">
      <PageHeader title="教材庫" subtitle="長期教材與完成進度"
        actions={goPlans ? <Button size="sm" variant="tertiary" onClick={goPlans}>去計畫</Button> : null} />
      <div className="main-body ml-view">
      {err && <div className="mt-err" role="alert">{err}</div>}
      <SegmentedControl ariaLabel="教材分類" block value={String(scope)} onChange={setScope}
        options={[{ value: 'all', label: '所有教材' },
          ...categories.map(c => ({ value: String(c.id), label: c.name }))]} />

      <div className="ml-addrow ml-addrow--book">
        <input value={adding} onChange={e => setAdding(e.target.value)} placeholder="新增教材名稱"
          aria-label="新增教材名稱" onKeyDown={e => { if (e.key === 'Enter') addBook(); }} />
        <select aria-label="科目" value={addSubject} onChange={e => setAddSubject(e.target.value)}>
          <option value="">選擇科目…</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <Button size="sm" variant="primary" disabled={!adding.trim() || busy} onClick={addBook}>新增</Button>
      </div>
      <div className="ui-meta">沒有指定科目的教材無法排入計畫（排程以科目分組）。</div>

      {!visibleBooks.length ? (
        <EmptyState title="這個分類還沒有教材" description="新增一本教材，或切換到「所有教材」。" />
      ) : (
        <div className="ml-booklist">
          {visibleBooks.map(b => {
            const inCats = catsOf(b.id);
            return (
              <button key={b.id} type="button" className="ml-book" onClick={() => openTree(b.id)}>
                <span className="ml-book-main">
                  <span className="ml-book-title">{b.title}</span>
                  {b.publisher && <span className="ml-book-sub">{b.publisher}</span>}
                  {inCats.length > 1 && (
                    <span className="ml-book-cats">同時列在 {inCats.length} 個分類</span>
                  )}
                  {bookNeedsSubject(b)
                    ? <span className="mt-warn">需要先指定科目，否則無法排入計畫</span>
                    : <span className="ml-book-sub">
                        {lists.find(l => l.id === b.subject_list_id)?.name || '科目已移除'}
                      </span>}
                </span>
                <span className="ml-book-meta">
                  <span className="mt-progress-text">
                    {b.progress.completed_items}/{b.progress.total_items}
                  </span>
                  <span className="ml-book-pct">{b.progress.percent}%</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <CategoryAdder onAdd={async name => { await createCategory(name); await load(); }} />
      </div>
    </div>
  );
}

function CategoryAdder({ onAdd }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await onAdd(name.trim()); setName(''); } finally { setBusy(false); }
  };
  return (
    <div className="ml-addrow ml-addrow--cat">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="新增分類（例：第一次段考）"
        aria-label="新增分類名稱" onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      <Button size="sm" variant="secondary" disabled={!name.trim() || busy} onClick={submit}>新增分類</Button>
    </div>
  );
}
