import { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';

// 備忘錄：分類記錄要做的事。每筆可勾完成、改分類、改色、編輯、刪除
export default function MemoView() {
  const [memos, setMemos] = useState([]);
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [openCat, setOpenCat] = useState(() => new Set());
  const [editId, setEditId] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const load = () => api('/memos').then(setMemos).catch(() => {});
  useEffect(() => { load(); }, []);

  const cats = [...new Set(memos.map(m => m.category).filter(Boolean))].sort();
  const groups = [...cats, ...(memos.some(m => !m.category) ? [''] : [])];

  async function add(e) {
    e.preventDefault();
    if (!content.trim()) return;
    const m = await api('/memos', { method: 'POST', body: { content: content.trim(), category: category.trim() } });
    setMemos(list => [...list, m]);
    setContent('');
  }
  const patch = (id, body) => { setMemos(list => list.map(m => m.id === id ? { ...m, ...body } : m)); api(`/memos/${id}`, { method: 'PATCH', body }).catch(() => {}); };
  async function del(id) { setMemos(list => list.filter(m => m.id !== id)); try { await api(`/memos/${id}`, { method: 'DELETE' }); } catch {} }
  async function moveCat(m) {
    const c = prompt('分類（留空＝不分類）：', m.category || '');
    if (c === null) return;
    patch(m.id, { category: c.trim() });
  }
  const toggleCat = c => setOpenCat(s => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; });

  const Row = m => (
    <div key={m.id}>
      <div className="trow" style={{ borderLeft: `3px solid ${m.color || 'transparent'}`, paddingLeft: m.color ? 8 : 0 }}>
        <input type="checkbox" checked={!!m.done} onChange={() => patch(m.id, { done: !m.done })} />
        <span className="title" style={m.done ? { textDecoration: 'line-through', color: 'var(--muted)' } : { cursor: 'pointer' }}
          onClick={() => setEditId(editId === m.id ? null : m.id)}>{m.content}</span>
        <button className="icon-btn" style={{ padding: 2 }} onClick={() => del(m.id)}><Icon name="x" size={14} /></button>
      </div>
      {editId === m.id && (
        <div style={{ padding: '4px 2px 10px' }}>
          <textarea value={m.content} rows={2} style={{ width: '100%' }}
            onChange={e => setMemos(list => list.map(x => x.id === m.id ? { ...x, content: e.target.value } : x))}
            onBlur={e => api(`/memos/${m.id}`, { method: 'PATCH', body: { content: e.target.value } }).catch(() => {})} />
          <div className="swatches" style={{ marginTop: 6 }}>
            <span className={'swatch' + (!m.color ? ' on' : '')} style={{ background: '#fff', border: '1px solid var(--border)' }} onClick={() => patch(m.id, { color: '' })} />
            {['#0086CC', '#8AC4DE', '#CB1B45', '#E98B2A', '#00896C', '#66327C', '#005B98'].map(c => (
              <span key={c} className={'swatch' + (m.color === c ? ' on' : '')} style={{ background: c }} onClick={() => patch(m.id, { color: c })} />
            ))}
            <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => moveCat(m)}>改分類</button>
            <button className="btn sm" onClick={() => setEditId(null)}>完成</button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="main">
      <div className="main-head"><h2>備忘錄</h2><span className="muted">{memos.filter(m => !m.done).length} 項待辦</span></div>
      <div className="main-body">
        <form onSubmit={add} style={{ margin: '6px 0' }}>
          <input placeholder="要記下什麼？" value={content} onChange={e => setContent(e.target.value)} style={{ width: '100%' }} />
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">分類</span>
            <input list="memo-cats" placeholder="輸入或選現有（可留空）" value={category} onChange={e => setCategory(e.target.value)} style={{ flex: 1 }} />
            <datalist id="memo-cats">{cats.map(c => <option key={c} value={c} />)}</datalist>
            <button className="btn sm">加入</button>
          </div>
        </form>

        {groups.map(cat => {
          const list = memos.filter(m => (m.category || '') === cat && (showDone || !m.done));
          if (!list.length && cat) return null;
          const undone = memos.filter(m => (m.category || '') === cat && !m.done).length;
          const open = !openCat.has(cat); // 預設展開，點了收合
          return (
            <div key={cat || '__none'} className="tgroup">
              <div className="glabel" style={{ cursor: 'pointer' }} onClick={() => toggleCat(cat)}>
                {open ? '▾' : '▸'} {cat || '未分類'} <span className="muted" style={{ fontWeight: 400 }}>{undone} 項</span>
              </div>
              {open && list.map(Row)}
            </div>
          );
        })}
        {!memos.length && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>還沒有備忘——在上面記一件要做的事吧</div>}
        {memos.some(m => m.done) && (
          <button className="btn sm ghost" style={{ marginTop: 14 }} onClick={() => setShowDone(s => !s)}>
            {showDone ? '隱藏已完成' : `顯示已完成（${memos.filter(m => m.done).length}）`}
          </button>
        )}
      </div>
    </div>
  );
}
