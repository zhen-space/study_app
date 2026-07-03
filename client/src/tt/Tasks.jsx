import { useState } from 'react';
import { api } from '../api';
import { matchView, groupTasks, PRI, today } from './helpers';

function TaskRow({ t, lists, sel, onSel, onToggle }) {
  const list = lists.find(l => l.id === t.list_id);
  const overdue = t.due_date && t.due_date < today() && !t.completed;
  return (
    <div className={'trow' + (t.completed ? ' done' : '') + (sel ? ' sel' : '')} onClick={() => onSel(t)}>
      <input type="checkbox" checked={!!t.completed} onClick={e => e.stopPropagation()} onChange={() => onToggle(t)} />
      {t.priority > 0 && <span className={PRI[t.priority][1]}>⚑</span>}
      <span className="title">{t.title}</span>
      {t.subtasks.length > 0 && <span className="chip">{t.subtasks.filter(s => s.done).length}/{t.subtasks.length}</span>}
      {t.tags.map(tag => <span key={tag} className="chip">#{tag}</span>)}
      {t.due_date && <span className="muted" style={overdue ? { color: 'var(--red)' } : {}}>{t.due_date.slice(5)}{t.due_time ? ' ' + t.due_time : ''}</span>}
      {list && <span className="dot" style={{ background: list.color }} title={list.name} />}
    </div>
  );
}

export function Detail({ task, lists, onSave, onDelete, onClose }) {
  const [t, setT] = useState(task);
  const up = patch => { const nt = { ...t, ...patch }; setT(nt); onSave(nt); };
  const [newSub, setNewSub] = useState('');

  return (
    <div className="detail">
      <div className="drow" style={{ justifyContent: 'space-between' }}>
        <select value={t.list_id || ''} onChange={e => up({ list_id: e.target.value ? +e.target.value : null })}>
          <option value="">收集箱</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button className="icon-btn" onClick={onClose}>✕</button>
      </div>
      <input className="title" value={t.title} onChange={e => up({ title: e.target.value })} />
      <div className="drow">
        <label>日期</label>
        <input type="date" value={t.due_date || ''} onChange={e => up({ due_date: e.target.value || null })} />
        <input type="time" value={t.due_time || ''} onChange={e => up({ due_time: e.target.value || null })} />
      </div>
      <div className="drow">
        <label>優先級</label>
        <select value={t.priority} onChange={e => up({ priority: +e.target.value })}>
          {[0, 1, 2, 3].map(p => <option key={p} value={p}>{PRI[p][0]}</option>)}
        </select>
        <label>重複</label>
        <select value={t.recurring || ''} onChange={e => up({ recurring: e.target.value || null })}>
          <option value="">不重複</option><option value="daily">每天</option>
          <option value="weekly">每週</option><option value="monthly">每月</option><option value="yearly">每年</option>
        </select>
      </div>
      <div className="drow">
        <label>標籤</label>
        <input placeholder="用逗號分隔" value={t.tags.join(',')}
          onChange={e => up({ tags: e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) })} style={{ flex: 1 }} />
      </div>
      <div>
        <label className="muted">子任務</label>
        {t.subtasks.map((s, i) => (
          <div key={i} className={'subtask' + (s.done ? ' done' : '')}>
            <input type="checkbox" checked={s.done} onChange={() => up({ subtasks: t.subtasks.map((x, j) => j === i ? { ...x, done: !x.done } : x) })} />
            <input type="text" value={s.title} onChange={e => up({ subtasks: t.subtasks.map((x, j) => j === i ? { ...x, title: e.target.value } : x) })} />
            <button className="icon-btn" onClick={() => up({ subtasks: t.subtasks.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <form onSubmit={e => { e.preventDefault(); if (newSub.trim()) { up({ subtasks: [...t.subtasks, { title: newSub.trim(), done: false }] }); setNewSub(''); } }}>
          <input placeholder="＋新增子任務" value={newSub} onChange={e => setNewSub(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
        </form>
      </div>
      <textarea placeholder="備註..." value={t.notes} onChange={e => up({ notes: e.target.value })} />
      <button className="btn sm" style={{ background: 'var(--red)', alignSelf: 'flex-start' }} onClick={() => onDelete(t)}>刪除任務</button>
    </div>
  );
}

export default function Tasks({ view, tasks, lists, filters, reload, title }) {
  const [selId, setSelId] = useState(null);
  const [quick, setQuick] = useState('');

  const shown = tasks.filter(t => matchView(t, view, { filters }));
  const sel = tasks.find(t => t.id === selId);

  async function toggle(t) {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: !t.completed } });
    reload();
  }
  async function quickAdd(e) {
    e.preventDefault();
    if (!quick.trim()) return;
    const body = { title: quick.trim() };
    if (view.type === 'list') body.list_id = view.id;
    if (view.type === 'today') body.due_date = today();
    if (view.type === 'tag') body.tags = [view.tag];
    await api('/tasks', { method: 'POST', body });
    setQuick('');
    reload();
  }
  async function save(t) {
    const { id, title, notes, due_date, due_time, priority, tags, subtasks, recurring, list_id } = t;
    await api(`/tasks/${id}`, { method: 'PATCH', body: { title, notes, due_date, due_time, priority, tags, subtasks, recurring, list_id } });
    reload();
  }
  async function del(t) {
    await api(`/tasks/${t.id}`, { method: 'DELETE' });
    setSelId(null);
    reload();
  }

  return (
    <>
      <div className="main">
        <div className="main-head"><h2>{title}</h2><span className="muted">{shown.length} 項</span></div>
        {view.type !== 'completed' && (
          <form className="quick-add" onSubmit={quickAdd}>
            <input placeholder="＋ 新增任務，按 Enter 儲存" value={quick} onChange={e => setQuick(e.target.value)} />
          </form>
        )}
        <div className="main-body">
          {groupTasks(shown, view.type).map(([label, list]) => (
            <div className="tgroup" key={label}>
              <div className="glabel">{label}</div>
              {list.map(t => <TaskRow key={t.id} t={t} lists={lists} sel={t.id === selId} onSel={x => setSelId(x.id)} onToggle={toggle} />)}
            </div>
          ))}
          {shown.length === 0 && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>沒有任務</div>}
        </div>
      </div>
      {sel && <Detail key={sel.id} task={sel} lists={lists} onSave={save} onDelete={del} onClose={() => setSelId(null)} />}
    </>
  );
}
