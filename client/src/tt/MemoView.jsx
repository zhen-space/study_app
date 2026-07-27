import { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// 日期顯示：今天／明天／昨天，其他寫 M/D（週X）；過期的用紅字
const WD = ['日', '一', '二', '三', '四', '五', '六'];
export function dateLabel(ds) {
  if (!ds) return '';
  const t = today();
  const d = new Date(ds + 'T00:00:00');
  const diff = Math.round((d - new Date(t + 'T00:00:00')) / 86400e3);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`;
}
export const isOverdue = ds => !!ds && ds < today();

// 備忘錄：分類記錄要做的事。每筆可勾完成、加/清日期、改分類、改色、編輯、刪除
export default function MemoView() {
  const [memos, setMemos] = useState([]);
  const [cats, setCats] = useState([]);            // 記住的分類（就算目前沒備忘也留著）
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [due, setDue] = useState('');              // 空＝不設日期
  const [openCat, setOpenCat] = useState(() => new Set());
  const [editId, setEditId] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [manageCat, setManageCat] = useState(false);
  const load = () => {
    api('/memos').then(setMemos).catch(() => {});
    api('/memo-cats').then(setCats).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const catNames = cats.map(c => c.name);
  // 分組：記住的分類（依順序）＋ 還沒登記到的舊分類 ＋ 未分類
  const stray = [...new Set(memos.map(m => m.category).filter(c => c && !catNames.includes(c)))].sort();
  const groups = [...catNames, ...stray, ...(memos.some(m => !m.category) ? [''] : [])];

  async function add(e) {
    e.preventDefault();
    if (!content.trim()) return;
    const m = await api('/memos', { method: 'POST', body: { content: content.trim(), category, due_date: due } });
    setMemos(list => [...list, m]);
    setContent('');
    if (category && !catNames.includes(category)) api('/memo-cats').then(setCats).catch(() => {});
  }
  const patch = (id, body) => { setMemos(list => list.map(m => m.id === id ? { ...m, ...body } : m)); api(`/memos/${id}`, { method: 'PATCH', body }).catch(() => {}); };
  async function del(id) { setMemos(list => list.filter(m => m.id !== id)); try { await api(`/memos/${id}`, { method: 'DELETE' }); } catch {} }
  async function newCat() {
    const n = prompt('新分類名稱：', '');
    if (!n || !n.trim()) return;
    const c = await api('/memo-cats', { method: 'POST', body: { name: n.trim() } }).catch(() => null);
    if (c) { setCats(l => [...l, c]); setCategory(c.name); }
  }
  async function renameCat(c) {
    const n = prompt('改分類名稱：', c.name);
    if (n === null || !n.trim() || n.trim() === c.name) return;
    await api(`/memo-cats/${c.id}`, { method: 'PATCH', body: { name: n.trim() } }).catch(() => {});
    load();
  }
  async function delCat(c) {
    await api(`/memo-cats/${c.id}`, { method: 'DELETE' }).catch(() => {});
    if (category === c.name) setCategory('');
    load();
  }
  const toggleCat = c => setOpenCat(s => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; });

  // 分類選擇列：直接點選，不用打字
  const CatPicker = ({ value, onPick }) => (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
      <span className={'chip' + (!value ? ' on' : '')} onClick={() => onPick('')}>未分類</span>
      {catNames.map(c => (
        <span key={c} className={'chip' + (value === c ? ' on' : '')} onClick={() => onPick(c)}>{c}</span>
      ))}
      {stray.map(c => (
        <span key={c} className={'chip' + (value === c ? ' on' : '')} onClick={() => onPick(c)}>{c}</span>
      ))}
      <span className="chip" onClick={newCat}>＋新分類</span>
    </div>
  );

  const Row = m => (
    <div key={m.id}>
      <div className="trow" style={{ borderLeft: `3px solid ${m.color || 'transparent'}`, paddingLeft: m.color ? 8 : 0 }}>
        <input type="checkbox" checked={!!m.done} onChange={() => patch(m.id, { done: !m.done })} />
        <span className="title" style={m.done ? { textDecoration: 'line-through', color: 'var(--muted)' } : { cursor: 'pointer' }}
          onClick={() => setEditId(editId === m.id ? null : m.id)}>{m.content}</span>
        {m.due_date && (
          <span style={{ fontSize: 12, marginLeft: 6, whiteSpace: 'nowrap', color: isOverdue(m.due_date) && !m.done ? 'var(--red)' : 'var(--muted)' }}>
            {dateLabel(m.due_date)}
          </span>
        )}
        <button className="icon-btn" style={{ padding: 2 }} onClick={() => del(m.id)}><Icon name="x" size={14} /></button>
      </div>
      {editId === m.id && (
        <div style={{ padding: '4px 2px 10px' }}>
          <textarea value={m.content} rows={2} style={{ width: '100%' }}
            onChange={e => setMemos(list => list.map(x => x.id === m.id ? { ...x, content: e.target.value } : x))}
            onBlur={e => api(`/memos/${m.id}`, { method: 'PATCH', body: { content: e.target.value } }).catch(() => {})} />
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">日期</span>
            <input type="date" value={m.due_date || ''} onChange={e => patch(m.id, { due_date: e.target.value })} style={{ flex: 1 }} />
            {m.due_date
              ? <button className="btn sm ghost" onClick={() => patch(m.id, { due_date: '' })}>不用日期</button>
              : <button className="btn sm ghost" onClick={() => patch(m.id, { due_date: today() })}>設今天</button>}
          </div>
          <div style={{ marginTop: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>分類</span>
            <CatPicker value={m.category || ''} onPick={c => patch(m.id, { category: c })} />
          </div>
          <div className="swatches" style={{ marginTop: 6 }}>
            <span className={'swatch' + (!m.color ? ' on' : '')} style={{ background: '#fff', border: '1px solid var(--border)' }} onClick={() => patch(m.id, { color: '' })} />
            {['#0086CC', '#8AC4DE', '#CB1B45', '#E98B2A', '#00896C', '#66327C', '#005B98'].map(c => (
              <span key={c} className={'swatch' + (m.color === c ? ' on' : '')} style={{ background: c }} onClick={() => patch(m.id, { color: c })} />
            ))}
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setEditId(null)}>完成</button>
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
          <div style={{ marginTop: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>分類</span>
            <CatPicker value={category} onPick={setCategory} />
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">日期</span>
            <input type="date" value={due} onChange={e => setDue(e.target.value)} style={{ flex: 1 }} />
            {due
              ? <button type="button" className="btn sm ghost" onClick={() => setDue('')}>不用日期</button>
              : <button type="button" className="btn sm ghost" onClick={() => setDue(today())}>今天</button>}
            <button className="btn sm">加入</button>
          </div>
        </form>

        {groups.map(cat => {
          const list = memos.filter(m => (m.category || '') === cat && (showDone || !m.done));
          const undone = memos.filter(m => (m.category || '') === cat && !m.done).length;
          if (!list.length && cat && !catNames.includes(cat)) return null;   // 記住的分類就算空的也顯示
          const open = !openCat.has(cat); // 預設展開，點了收合
          return (
            <div key={cat || '__none'} className="tgroup">
              <div className="glabel" style={{ cursor: 'pointer' }} onClick={() => toggleCat(cat)}>
                {open ? '▾' : '▸'} {cat || '未分類'} <span className="muted" style={{ fontWeight: 400 }}>{undone} 項</span>
              </div>
              {open && (list.length
                ? list.map(Row)
                : <div className="muted" style={{ fontSize: 12, padding: '2px 0 6px' }}>（這個分類目前是空的）</div>)}
            </div>
          );
        })}
        {!memos.length && !cats.length && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>還沒有備忘——在上面記一件要做的事吧</div>}

        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          {memos.some(m => m.done) && (
            <button className="btn sm ghost" onClick={() => setShowDone(s => !s)}>
              {showDone ? '隱藏已完成' : `顯示已完成（${memos.filter(m => m.done).length}）`}
            </button>
          )}
          {cats.length > 0 && <button className="btn sm ghost" onClick={() => setManageCat(v => !v)}>{manageCat ? '完成' : '管理分類'}</button>}
        </div>
        {manageCat && (
          <div className="tgroup" style={{ marginTop: 8 }}>
            {cats.map(c => (
              <div key={c.id} className="trow">
                <span className="title">{c.name}</span>
                <button className="btn sm ghost" onClick={() => renameCat(c)}>改名</button>
                <button className="btn sm ghost" onClick={() => delCat(c)}>刪除</button>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>刪除分類不會刪掉備忘，底下的會變成未分類</div>
          </div>
        )}
      </div>
    </div>
  );
}
