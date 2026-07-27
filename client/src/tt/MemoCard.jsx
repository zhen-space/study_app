import { useEffect, useState } from 'react';
import { api } from '../api';
import { dateLabel, isOverdue } from './MemoView';

// 首頁最上面的備忘錄：未完成的隨手記，可勾掉；管理在「備忘錄」頁
export default function MemoCard({ goMemo }) {
  const [memos, setMemos] = useState(() => {
    try { return JSON.parse(localStorage.getItem('memoCache') || '[]'); } catch { return []; }
  });
  const [quick, setQuick] = useState('');
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
  async function add(e) {
    e.preventDefault();
    if (!quick.trim()) return;
    const m = await api('/memos', { method: 'POST', body: { content: quick.trim() } });
    setMemos(list => [...list, m]);
    setQuick('');
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
      <form onSubmit={add} style={{ marginTop: 6 }}>
        <input placeholder="＋ 隨手記一件事…" value={quick} onChange={e => setQuick(e.target.value)}
          style={{ width: '100%', background: 'var(--bg)', border: '1px dashed var(--border)' }} />
      </form>
    </div>
  );
}
