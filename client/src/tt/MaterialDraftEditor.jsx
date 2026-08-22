import { useMemo, useState } from 'react';
import { ITEM_LABEL } from './material';
import { Button } from './ui';

// 一份教材在寫進資料庫**之前**的樣子，可以直接編輯。
//
// 拍照匯入與自己建立共用這一個編輯器：兩邊都只是在組同一份 draft，
// 最後交給同一支寫入 API。前端不維護第二套「建立整本教材」的路徑，
// 否則遲早會變成一邊擋得住、另一邊繞得過。
//
// 正式結構在這裡就是實際的畫面結構：
//   章 →（節｜主題，同層）→ 課本內容／範例／例題
//   章底下另外直接掛 單元練習／歷屆試題
// 沒有「其他」、沒有「練習區」，也不為章層內容造一個假的節。

const CHILD_KINDS = ['reading', 'example', 'example_problem'];
const CHAPTER_KINDS = ['unit_exercise', 'past_exam'];

export const emptyDraft = () => ({
  book: { title: '', publisher: '', subject_list_id: null },
  chapters: [{ title: '', content_items: [], children: [] }],
});

// 同一種內容加第二筆時自動編號：範例、範例 2、範例 3…
// 名稱只是給學生看的，identity 一律由建立當下決定。
const nextTitle = (list, kind) => {
  const n = list.filter(i => i.kind === kind).length;
  return n ? `${ITEM_LABEL[kind]} ${n + 1}` : ITEM_LABEL[kind];
};

function ItemPills({ items, kinds, onAdd, onRemove, label }) {
  return (
    <div className="md-items">
      {items.map((it, i) => (
        <span key={i} className="md-pill">
          {it.title}
          <button type="button" className="md-pill-x" aria-label={`移除 ${it.title}`}
            onClick={() => onRemove(i)}>✕</button>
        </span>
      ))}
      {kinds.map(k => (
        <button key={k} type="button" className="md-add-pill"
          aria-label={`${label}：加入${ITEM_LABEL[k]}`} onClick={() => onAdd(k)}>
          ＋{ITEM_LABEL[k]}
        </button>
      ))}
    </div>
  );
}

export default function MaterialDraftEditor({
  value, onChange, lists = [], busy = false, error = '', problems = [],
  submitLabel = '建立教材', onSubmit, onCancel, onAddSubject = null,
}) {
  const d = value;
  // 剛註冊的帳號一個科目都沒有。沒有科目就選不了科目，選不了科目就排不進計畫——
  // 如果只能「請到別的頁面新增」，第一次使用的人就走進死路了。所以就地能加。
  const [newSubject, setNewSubject] = useState(null);   // null＝沒在新增
  const set = patch => onChange({ ...d, ...patch });
  const setBook = patch => onChange({ ...d, book: { ...d.book, ...patch } });
  const setChapters = fn => onChange({ ...d, chapters: fn(d.chapters) });
  const at = (ci, patch) => setChapters(cs => cs.map((c, i) => (i === ci ? { ...c, ...patch } : c)));
  const atChild = (ci, si, patch) => at(ci, {
    children: d.chapters[ci].children.map((c, i) => (i === si ? { ...c, ...patch } : c)),
  });

  const total = useMemo(() => d.chapters.reduce(
    (n, c) => n + c.content_items.length + c.children.reduce((m, s) => m + s.content_items.length, 0),
    0), [d]);

  const ready = d.book.title.trim() && d.chapters.some(c => c.title.trim()) && total > 0;

  // 建好之後直接選起來：學生要的是「這本書是數學」，不是「我新增了一個科目」。
  const addSubject = async () => {
    const name = newSubject.trim();
    if (!name) return;
    const created = await onAddSubject(name);
    setNewSubject(null);
    if (created?.id != null) setBook({ subject_list_id: Number(created.id) });
  };

  return (
    <div className="md">
      <div className="md-book">
        <label className="md-field">
          <span>教材名稱</span>
          <input value={d.book.title} placeholder="例如：新大滿貫數學 2"
            onChange={e => setBook({ title: e.target.value })} />
        </label>
        <label className="md-field">
          <span>科目</span>
          {/* 科目用的是既有科目的 id。名稱可以重複、可以改，不是身分。 */}
          <select value={d.book.subject_list_id ?? ''} disabled={busy}
            onChange={e => {
              if (e.target.value === '__new') { setNewSubject(''); return; }
              setBook({ subject_list_id: e.target.value === '' ? null : Number(e.target.value) });
            }}>
            <option value="">請選擇</option>
            {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            {onAddSubject && <option value="__new">＋ 新增科目…</option>}
          </select>
        </label>
        {newSubject != null && (
          <div className="md-newsubject">
            <input autoFocus value={newSubject} placeholder="科目名稱，例如：數學"
              aria-label="新科目名稱" disabled={busy}
              onChange={e => setNewSubject(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSubject(); } }} />
            <Button size="sm" onClick={addSubject} disabled={busy || !newSubject.trim()}>新增</Button>
            <Button size="sm" variant="tertiary" onClick={() => setNewSubject(null)} disabled={busy}>取消</Button>
          </div>
        )}
        <label className="md-field">
          <span>出版社</span>
          <input value={d.book.publisher || ''} placeholder="可以不填"
            onChange={e => setBook({ publisher: e.target.value })} />
        </label>
        {d.book.subject_list_id == null && (
          <p className="md-hint">選了科目才排得進計畫。之後也可以再補。</p>
        )}
      </div>

      {error && <div className="mt-err" role="alert">{error}</div>}
      {problems.length > 0 && (
        <ul className="md-problems" role="alert">
          {problems.map((p, i) => <li key={i}>{p.message}</li>)}
        </ul>
      )}

      {d.chapters.map((ch, ci) => (
        <div key={ci} className="md-chapter">
          <div className="md-chapter-head">
            <input className="md-chapter-title" value={ch.title} placeholder={`第 ${ci + 1} 章`}
              aria-label={`第 ${ci + 1} 章名稱`}
              onChange={e => at(ci, { title: e.target.value })} />
            {d.chapters.length > 1 && (
              <button type="button" className="md-x" aria-label={`刪除第 ${ci + 1} 章`}
                onClick={() => setChapters(cs => cs.filter((_, i) => i !== ci))}>✕</button>
            )}
          </div>

          {ch.children.map((c, si) => (
            <div key={si} className="md-node">
              <div className="md-node-head">
                {/* 節與主題是同層的兩種東西，不是上下層 */}
                <select value={c.kind} aria-label={`第 ${si + 1} 項是節還是主題`}
                  onChange={e => atChild(ci, si, { kind: e.target.value })}>
                  <option value="section">節</option>
                  <option value="topic">主題</option>
                </select>
                <input value={c.title} placeholder="名稱" aria-label={`第 ${si + 1} 項名稱`}
                  onChange={e => atChild(ci, si, { title: e.target.value })} />
                <button type="button" className="md-x" aria-label={`刪除 ${c.title || '這一項'}`}
                  onClick={() => at(ci, { children: ch.children.filter((_, i) => i !== si) })}>✕</button>
              </div>
              <ItemPills items={c.content_items} kinds={CHILD_KINDS} label={c.title || '這一節'}
                onAdd={k => atChild(ci, si, {
                  content_items: [...c.content_items, { kind: k, title: nextTitle(c.content_items, k) }],
                })}
                onRemove={i => atChild(ci, si, {
                  content_items: c.content_items.filter((_, x) => x !== i),
                })} />
            </div>
          ))}

          <button type="button" className="md-add" onClick={() => at(ci, {
            children: [...ch.children, { kind: 'section', title: '', content_items: [] }],
          })}>＋ 加一節／主題</button>

          {/* 單元練習與歷屆試題直接屬於這一章，不放進任何一節 */}
          <div className="md-chapter-level">
            <span className="md-chapter-level-label">本章</span>
            <ItemPills items={ch.content_items} kinds={CHAPTER_KINDS} label={`第 ${ci + 1} 章`}
              onAdd={k => at(ci, {
                content_items: [...ch.content_items, { kind: k, title: nextTitle(ch.content_items, k) }],
              })}
              onRemove={i => at(ci, { content_items: ch.content_items.filter((_, x) => x !== i) })} />
          </div>
        </div>
      ))}

      <button type="button" className="md-add md-add--chapter" onClick={() => set({
        chapters: [...d.chapters, { title: '', content_items: [], children: [] }],
      })}>＋ 加一章</button>

      <div className="md-foot">
        <span className="md-total" aria-live="polite">共 {total} 項內容</span>
        {onCancel && <Button variant="tertiary" onClick={onCancel} disabled={busy}>取消</Button>}
        <Button variant="primary" disabled={busy || !ready} onClick={onSubmit}>
          {busy ? '處理中…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
