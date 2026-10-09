import { useRef, useState } from 'react';
import {
  updateBook, updateNode, updateContentItem, deleteNode, deleteContentItem,
  createNode, createContentItem, ITEM_LABEL, CHAPTER_LEVEL_KINDS,
} from './material';
import { Button } from './ui';

// 「編輯教材」。學生自己建立教材之後一定會打錯字——沒有修正的路，
// 那本教材就永遠壞著。
//
// 這個畫面只做**結構**：這本教材裡有哪些章、節／主題、內容。
// 它不做完成度，也不做「這次要讀哪些」——那兩件事各自有自己的畫面。
// 第一次確認完內容之後結構不會就此鎖死：漏掉的節、漏掉的例題，之後補得回來。
//
// 兩條線：
//   ① 改名不換 identity。改的是同一筆東西的名字，完成度、計畫選取、
//      既有任務的關聯全部原樣留著。
//   ② 已經被用過的東西不刪。有完成度／被計畫選到／有任務指著，就明確擋下來
//      並說出原因，而不是靜默失敗，也不是硬刪掉留下一段假裝沒發生過的歷史。

// 節與主題底下可以放的內容；章底下是另外兩種。改種類時只在同一層裡換，
// 換到另一層是非法擺放（後端也會再擋一次）。
const CHILD_KINDS = ['reading', 'example', 'example_problem'];

function ItemRow({ item, busy, onRename, onKind, onDelete }) {
  const kinds = CHAPTER_LEVEL_KINDS.includes(item.kind) ? CHAPTER_LEVEL_KINDS : CHILD_KINDS;
  return (
    <div className="me-row me-row--item">
      <input value={item.title} disabled={busy} aria-label={`${item.title} 的名稱`}
        onChange={e => onRename(e.target.value)} />
      <select value={item.kind} disabled={busy} aria-label={`${item.title} 的內容種類`}
        onChange={e => onKind(e.target.value)}>
        {kinds.map(k => <option key={k} value={k}>{ITEM_LABEL[k]}</option>)}
      </select>
      <button type="button" className="me-x" disabled={busy}
        aria-label={`刪除 ${item.title}`} onClick={onDelete}>✕</button>
    </div>
  );
}

// 定義在元件外面：元件內部宣告的元件每次 render 都是**新的型別**，
// React 會把底下的 input 整個重新掛載——打一個字焦點就掉一次，根本沒辦法改名。
function NodeRow({ node, label, value, busy, onChange, onBlur, onDelete }) {
  return (
    <div className="me-row">
      <span className="me-tag">{label}</span>
      <input value={value} disabled={busy} aria-label={`${node.title} 的名稱`}
        onChange={e => onChange(e.target.value)} onBlur={onBlur} />
      <button type="button" className="me-x" disabled={busy}
        aria-label={`刪除 ${node.title}`} onClick={onDelete}>✕</button>
    </div>
  );
}

// 寫入 API 已經會回傳正式資料，不必每改一個字就重新下載整本教材與整個書櫃。
// 這些小函式只把「剛剛成功的那一筆」合併回目前畫面；完成編輯後，外層仍會在
// 背景重讀一次 server-authoritative 資料，但不再讓使用者卡在載入畫面。
const mapNodes = (nodes, fn) => (nodes || []).map(node => {
  const changed = fn(node);
  if (changed !== node) return changed;
  const children = mapNodes(node.children, fn);
  return children.some((child, i) => child !== (node.children || [])[i])
    ? { ...node, children }
    : node;
});

const patchNode = (tree, saved) => ({
  ...tree,
  nodes: mapNodes(tree?.nodes, node => node.id === saved.id ? { ...node, ...saved } : node),
});

const patchItem = (tree, saved) => ({
  ...tree,
  nodes: mapNodes(tree?.nodes, node => {
    const items = node.content_items || [];
    return items.some(item => item.id === saved.id)
      ? { ...node, content_items: items.map(item => item.id === saved.id ? { ...item, ...saved } : item) }
      : node;
  }),
});

const addNode = (tree, saved) => saved.parent_id == null
  ? { ...tree, nodes: [...(tree?.nodes || []), { ...saved, content_items: [], children: [] }] }
  : {
      ...tree,
      nodes: mapNodes(tree?.nodes, node => node.id === saved.parent_id
        ? { ...node, children: [...(node.children || []), { ...saved, content_items: [], children: [] }] }
        : node),
    };

const addItemToTree = (tree, saved) => ({
  ...tree,
  nodes: mapNodes(tree?.nodes, node => node.id === saved.node_id
    ? { ...node, content_items: [...(node.content_items || []), saved] }
    : node),
});

const removeNode = (tree, id) => {
  const prune = nodes => (nodes || [])
    .filter(node => node.id !== id)
    .map(node => ({ ...node, children: prune(node.children) }));
  return { ...tree, nodes: prune(tree?.nodes) };
};

const removeItem = (tree, id) => ({
  ...tree,
  nodes: mapNodes(tree?.nodes, node => ({
    ...node,
    content_items: (node.content_items || []).filter(item => item.id !== id),
  })),
});

export default function MaterialBookEditor({ book, tree, lists = [], onChanged, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [refreshStale, setRefreshStale] = useState(false);
  const mutationBusy = useRef(false);
  const bookRef = useRef(book);
  const treeRef = useRef(tree);
  const [, renderLocal] = useState(0);
  // 打字當下不送出：每敲一個字打一次 API 會讓游標跳掉，也會塞爆網路。
  // 只把改過的值先放在這裡，離開欄位（blur）才存。
  const [draft, setDraft] = useState({});

  const key = (type, id) => `${type}:${id}`;
  const valueOf = (type, id, fallback) => draft[key(type, id)] ?? fallback;
  const setLocal = (type, id, v) => setDraft(d => ({ ...d, [key(type, id)]: v }));

  const snapshot = () => ({ book: bookRef.current, tree: treeRef.current });
  const applyLocal = (saved, reducer) => {
    if (reducer) treeRef.current = reducer(treeRef.current, saved);
    renderLocal(n => n + 1);
    return snapshot();
  };

  const run = async (fn, reducer = null) => {
    if (mutationBusy.current || refreshStale) return;
    mutationBusy.current = true;
    setBusy(true); setErr('');
    let saved;
    try { saved = await fn(); }
    catch (e) {
      // 後端擋下刪除時會一起回 references，把「為什麼不能刪」講出來。
      const r = e.payload?.references;
      const why = r ? [
        r.progress ? '已經標記完成' : '',
        r.plan_selections ? '正被計畫選取' : '',
        r.tasks ? '已經排進任務' : '',
      ].filter(Boolean).join('、') : '';
      setErr(why ? `${e.message}：${why}。` : e.message);
      mutationBusy.current = false;
      setBusy(false);
      return;
    }
    const next = applyLocal(saved, reducer);
    try {
      const background = onChanged?.(saved, next);
      // 舊呼叫端若仍回 Promise，也只把它當背景同步；寫入已成功，不能再讓按鈕
      // 因為第二輪整頁載入而維持 disabled。
      if (background?.catch) background.catch(() => {
        setRefreshStale(true);
        setErr('變更已儲存。請完成編輯後重新開啟教材，以載入最新內容。');
      });
    } catch {
      // 外層只做本地同步，不應阻擋已成功的寫入；真正的權威重讀在離開後背景進行。
      setRefreshStale(true);
      setErr('變更已儲存。請完成編輯後重新開啟教材，以載入最新內容。');
    } finally {
      mutationBusy.current = false;
      setBusy(false);
    }
  };

  const locked = busy || refreshStale;

  const saveNode = (node, title) => {
    const t = String(title).trim();
    if (!t || t === node.title) return;
    return run(() => updateNode(node.id, { title: t }), patchNode);
  };
  const saveItem = (item, patch) => run(() => updateContentItem(item.id, patch), patchItem);
  const renameItem = (item, title) => {
    const t = String(title).trim();
    if (!t || t === item.title) return;
    return saveItem(item, { title: t });
  };

  const itemProps = item => ({
    item: { ...item, title: valueOf('i', item.id, item.title) },
    busy: locked,
    onRename: v => setLocal('i', item.id, v),
    onKind: v => saveItem(item, { kind: v }),
    onDelete: () => run(() => deleteContentItem(item.id), current => removeItem(current, item.id)),
  });
  // blur 才送出：打字中不打 API
  const itemBlur = item => () => renameItem(item, valueOf('i', item.id, item.title));

  // 補一個之後才發現漏掉的東西。只是新增：既有的完成度、計畫選取、任務關聯
  // 完全不受影響，新增的預設未完成。
  const addChild = (chapter, kind) => run(() => createNode({
    book_id: book.id, parent_id: chapter.id, kind, title: kind === 'section' ? '新的節' : '新的主題',
  }), addNode);
  const addItem = (node, kind) => run(() => createContentItem({
    node_id: node.id, kind, title: ITEM_LABEL[kind],
  }), addItemToTree);

  const nodeProps = (node, label) => ({
    node, label, busy: locked,
    value: valueOf('n', node.id, node.title),
    onChange: v => setLocal('n', node.id, v),
    onBlur: () => saveNode(node, valueOf('n', node.id, node.title)),
    onDelete: () => run(() => deleteNode(node.id), current => removeNode(current, node.id)),
  });

  return (
    <div className="me">
      <div className="me-head">
        <h3 className="me-title">編輯教材內容</h3>
        <p className="me-lead">補內容或改名都不會影響已完成的部分，也不會動到任何計畫。</p>
      </div>
      {err && <div className="mt-err" role="alert">{err}</div>}

      <div className="me-book">
        <label className="md-field">
          <span>教材名稱</span>
          <input value={valueOf('b', 'title', bookRef.current?.title ?? '')} disabled={locked}
            onChange={e => setLocal('b', 'title', e.target.value)}
            onBlur={e => {
              const t = e.target.value.trim();
              if (t && t !== bookRef.current.title) run(() => updateBook(book.id, { title: t }), (current, saved) => {
                bookRef.current = saved;
                return { ...current, book: saved };
              });
            }} />
        </label>
        <label className="md-field">
          <span>科目</span>
          <select value={bookRef.current?.subject_list_id ?? ''} disabled={locked}
            onChange={e => run(() => updateBook(book.id, {
              subject_list_id: e.target.value === '' ? null : Number(e.target.value),
            }), (current, saved) => { bookRef.current = saved; return { ...current, book: saved }; })}>
            <option value="">未指定</option>
            {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label className="md-field">
          <span>出版社</span>
          <input value={valueOf('b', 'pub', bookRef.current?.publisher ?? '')} disabled={locked}
            onChange={e => setLocal('b', 'pub', e.target.value)}
            onBlur={e => {
              const v = e.target.value.trim();
              if (v !== (bookRef.current.publisher || '')) run(() => updateBook(book.id, { publisher: v }), (current, saved) => {
                bookRef.current = saved;
                return { ...current, book: saved };
              });
            }} />
        </label>
        <label className="md-field">
          <span>教材類型</span>
          <select value={bookRef.current?.book_type ?? ''} disabled={locked}
            onChange={e => run(() => updateBook(book.id, { book_type: e.target.value }), (current, saved) => {
              bookRef.current = saved;
              return { ...current, book: saved };
            })}>
            <option value="">未分類</option>
            {['課本', '講義', '測驗卷', '參考書', '自訂'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>

      {(treeRef.current?.nodes || []).map(ch => {
        const own = ch.content_items || [];
        const chapterLevel = own.filter(i => CHAPTER_LEVEL_KINDS.includes(i.kind));
        const reading = own.filter(i => !CHAPTER_LEVEL_KINDS.includes(i.kind));
        return (
          <div key={ch.id} className="me-chapter">
            <NodeRow {...nodeProps(ch, '章')} />
            {reading.map(it => (
              <div key={it.id} onBlur={itemBlur(it)}><ItemRow {...itemProps(it)} /></div>
            ))}
            {(ch.children || []).map(c => (
              <div key={c.id} className="me-child">
                <NodeRow {...nodeProps(c, c.kind === 'section' ? '節' : '主題')} />
                {(c.content_items || []).map(it => (
                  <div key={it.id} onBlur={itemBlur(it)}><ItemRow {...itemProps(it)} /></div>
                ))}
                <div className="me-add-row">
                  {CHILD_KINDS.map(k => (
                    <button key={k} type="button" className="md-add-pill" disabled={locked}
                      aria-label={`${c.title}：加入${ITEM_LABEL[k]}`}
                      onClick={() => addItem(c, k)}>＋{ITEM_LABEL[k]}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className="me-add-row">
              <button type="button" className="md-add-pill" disabled={locked}
                aria-label={`${ch.title}：加一節`} onClick={() => addChild(ch, 'section')}>＋ 加一節</button>
              <button type="button" className="md-add-pill" disabled={locked}
                aria-label={`${ch.title}：加一主題`} onClick={() => addChild(ch, 'topic')}>＋ 加一主題</button>
            </div>
            {/* 單元練習與歷屆試題直接屬於這一章，不為它們造一個假的節 */}
            <div className="me-chapter-level">
              <span className="md-chapter-level-label">本章</span>
              {chapterLevel.map(it => (
                <div key={it.id} onBlur={itemBlur(it)}><ItemRow {...itemProps(it)} /></div>
              ))}
              <div className="me-add-row">
                {CHAPTER_LEVEL_KINDS.map(k => (
                  <button key={k} type="button" className="md-add-pill" disabled={locked}
                    aria-label={`${ch.title}：加入${ITEM_LABEL[k]}`}
                    onClick={() => addItem(ch, k)}>＋{ITEM_LABEL[k]}</button>
                ))}
              </div>
            </div>
          </div>
        );
      })}

      <div className="me-foot">
        <Button variant="primary" onClick={() => onDone?.(snapshot())} disabled={busy}>
          {busy ? '儲存中…' : '完成編輯'}
        </Button>
      </div>
    </div>
  );
}
