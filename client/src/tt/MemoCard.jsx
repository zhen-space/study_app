import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { dateLabel, isOverdue } from './MemoView';

// 首頁最上面的備忘錄：未完成的隨手記，可勾掉；管理在「備忘錄」頁
export default function MemoCard({ goMemo }) {
  const [memos, setMemos] = useState(() => {
    try { return JSON.parse(localStorage.getItem('memoCache') || '[]'); } catch { return []; }
  });
  // 打到一半的字存起來：切到別頁、關掉 app 再回來都還在
  const [quick, setQuick] = useState(() => { try { return localStorage.getItem('memoDraft') || ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const setDraft = v => { setQuick(v); try { localStorage.setItem('memoDraft', v); } catch {} };
  const load = () => api('/memos').then(list => {
    setMemos(list);
    try { localStorage.setItem('memoCache', JSON.stringify(list)); } catch {}
  }).catch(() => {});
  useEffect(() => { load(); }, []);

  const undone = memos.filter(m => !m.done);
  const done = m => {
    setMemos(list => list.map(x => x.id === m.id ? { ...x, done: 1 } : x));   // 立刻消失
    api(`/memos/${m.id}`, { method: 'PATCH', body: { done: true } }).catch(() => {});
  };
  // 一次可以加很多項：貼上或打了換行就一行一件，分別建立
  async function add(e) {
    e?.preventDefault?.();
    const lines = quick.split('\n').map(x => x.trim()).filter(Boolean);
    if (!lines.length || busy) return;
    setBusy(true);
    const added = [];
    try {
      for (const line of lines) added.push(await api('/memos', { method: 'POST', body: { content: line } }));
    } catch {
      // 送不出去（沒網路等）就把還沒建立的留在輸入框，不要默默弄丟
      const left = lines.slice(added.length).join('\n');
      setMemos(list => [...list, ...added]);
      setDraft(left);
      setBusy(false);
      return;
    }
    setMemos(list => [...list, ...added]);
    setDraft('');
    setBusy(false);
    inputRef.current?.focus();          // 保持游標，接著就能記下一件
  }

  // 依分類分組（未分類放最後）；每組內：過期→今天→有日期的照日期→沒日期的
  const cats = [...new Set(undone.map(m => m.category).filter(Boolean))].sort();
  const groups = [...cats, ...(undone.some(m => !m.category) ? [''] : [])];
  const byDue = (a, b) => (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1) || (a.due_date || '').localeCompare(b.due_date || '');

  return (
    <div className="tgroup" style={{ marginBottom: 18, paddingBottom: 12, borderBottom: '2px dashed var(--border)' }}>
      <div className="glabel" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        📝 備忘錄{undone.length ? `（${undone.length}）` : ''}
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={goMemo}>全部</button>
      </div>
      {groups.map(cat => (
        <div key={cat || '__none'}>
          {cats.length > 0 && <div className="muted" style={{ margin: '6px 0 2px', fontSize: 12 }}>{cat || '未分類'}</div>}
          {undone.filter(m => (m.category || '') === cat).sort(byDue).map(m => (
            <div key={m.id} className="trow" style={{ borderLeft: `3px solid ${m.color || 'transparent'}`, paddingLeft: m.color ? 8 : 0 }}>
              <input type="checkbox" checked={false} onChange={() => done(m)} />
              <span className="title">{m.content}</span>
              {m.due_date && (
                <span style={{ fontSize: 12, marginLeft: 6, whiteSpace: 'nowrap', color: isOverdue(m.due_date) ? 'var(--red)' : 'var(--muted)' }}>
                  {dateLabel(m.due_date)}
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
      <form onSubmit={add} className="row" style={{ marginTop: 6, gap: 6, alignItems: 'flex-start' }}>
        {/* textarea 而非 input：貼上一串清單時換行才留得住，一行就是一件 */}
        <textarea ref={inputRef} placeholder="＋ 隨手記…（一行一件）" value={quick}
          rows={Math.min(4, quick.split('\n').length)} enterKeyHint="done"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }}
          style={{ flex: 1, minWidth: 0, resize: 'none', background: 'var(--bg)', border: '1px dashed var(--border)' }} />
        {quick.trim() && <button className="btn sm" disabled={busy}>加入</button>}
      </form>
    </div>
  );
}
