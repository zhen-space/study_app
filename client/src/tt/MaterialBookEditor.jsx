import { useState } from 'react';
import {
  updateBook, updateNode, updateContentItem, deleteNode, deleteContentItem,
  ITEM_LABEL, CHAPTER_LEVEL_KINDS,
} from './material';
import { Button } from './ui';

// 「編輯教材」。學生自己建立教材之後一定會打錯字——沒有修正的路，
// 那本教材就永遠壞著。
//
// 這個畫面只做**修正**，不做完成度：完成度在同一頁的閱讀模式，兩件事不混在
// 一起，免得「我只是想改個名字」變成不小心把它標成讀完了。
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

export default function MaterialBookEditor({ book, tree, lists = [], onChanged, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // 打字當下不送出：每敲一個字打一次 API 會讓游標跳掉，也會塞爆網路。
  // 只把改過的值先放在這裡，離開欄位（blur）才存。
  const [draft, setDraft] = useState({});

  const key = (type, id) => `${type}:${id}`;
  const valueOf = (type, id, fallback) => draft[key(type, id)] ?? fallback;
  const setLocal = (type, id, v) => setDraft(d => ({ ...d, [key(type, id)]: v }));

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await onChanged?.(); }
    catch (e) {
      // 後端擋下刪除時會一起回 references，把「為什麼不能刪」講出來。
      const r = e.payload?.references;
      const why = r ? [
        r.progress ? '已經標記完成' : '',
        r.plan_selections ? '正被計畫選取' : '',
        r.tasks ? '已經排進任務' : '',
      ].filter(Boolean).join('、') : '';
      setErr(why ? `${e.message}：${why}。` : e.message);
    } finally { setBusy(false); }
  };

  const saveNode = (node, title) => {
    const t = String(title).trim();
    if (!t || t === node.title) return;
    return run(() => updateNode(node.id, { title: t }));
  };
  const saveItem = (item, patch) => run(() => updateContentItem(item.id, patch));
  const renameItem = (item, title) => {
    const t = String(title).trim();
    if (!t || t === item.title) return;
    return saveItem(item, { title: t });
  };

  const itemProps = item => ({
    item: { ...item, title: valueOf('i', item.id, item.title) },
    busy,
    onRename: v => setLocal('i', item.id, v),
    onKind: v => saveItem(item, { kind: v }),
    onDelete: () => run(() => deleteContentItem(item.id)),
  });
  // blur 才送出：打字中不打 API
  const itemBlur = item => () => renameItem(item, valueOf('i', item.id, item.title));

  const nodeProps = (node, label) => ({
    node, label, busy,
    value: valueOf('n', node.id, node.title),
    onChange: v => setLocal('n', node.id, v),
    onBlur: () => saveNode(node, valueOf('n', node.id, node.title)),
    onDelete: () => run(() => deleteNode(node.id)),
  });

  return (
    <div className="me">
      <div className="me-head">
        <h3 className="me-title">編輯教材</h3>
        <p className="me-lead">改名不會影響完成度或已經排好的任務。</p>
      </div>
      {err && <div className="mt-err" role="alert">{err}</div>}

      <div className="me-book">
        <label className="md-field">
          <span>教材名稱</span>
          <input value={valueOf('b', 'title', book?.title ?? '')} disabled={busy}
            onChange={e => setLocal('b', 'title', e.target.value)}
            onBlur={e => {
              const t = e.target.value.trim();
              if (t && t !== book.title) run(() => updateBook(book.id, { title: t }));
            }} />
        </label>
        <label className="md-field">
          <span>科目</span>
          <select value={book?.subject_list_id ?? ''} disabled={busy}
            onChange={e => run(() => updateBook(book.id, {
              subject_list_id: e.target.value === '' ? null : Number(e.target.value),
            }))}>
            <option value="">未指定</option>
            {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label className="md-field">
          <span>出版社</span>
          <input value={valueOf('b', 'pub', book?.publisher ?? '')} disabled={busy}
            onChange={e => setLocal('b', 'pub', e.target.value)}
            onBlur={e => {
              const v = e.target.value.trim();
              if (v !== (book.publisher || '')) run(() => updateBook(book.id, { publisher: v }));
            }} />
        </label>
      </div>

      {(tree?.nodes || []).map(ch => {
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
              </div>
            ))}
            {chapterLevel.length > 0 && (
              <div className="me-chapter-level">
                <span className="md-chapter-level-label">本章</span>
                {chapterLevel.map(it => (
                  <div key={it.id} onBlur={itemBlur(it)}><ItemRow {...itemProps(it)} /></div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="me-foot">
        <Button variant="primary" onClick={onDone} disabled={busy}>完成編輯</Button>
      </div>
    </div>
  );
}
