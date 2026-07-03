import { useState } from 'react';
import { api } from '../api';
import { today } from './helpers';

export default function CalendarView({ tasks, reload }) {
  const [cur, setCur] = useState(today().slice(0, 7)); // YYYY-MM

  const [y, m] = cur.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon=0
  const cells = [];
  const start = new Date(first); start.setDate(1 - startDow);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    cells.push({ ds, day: d.getDate(), dim: d.getMonth() !== m - 1 });
  }
  const nav = n => {
    const d = new Date(y, m - 1 + n, 1);
    setCur(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const toggle = async t => {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: !t.completed } });
    reload();
  };

  return (
    <div className="main">
      <div className="main-head">
        <h2>日曆</h2>
        <button className="icon-btn" onClick={() => nav(-1)}>◀</button>
        <b>{y} 年 {m} 月</b>
        <button className="icon-btn" onClick={() => nav(1)}>▶</button>
        <button className="btn sm ghost" onClick={() => setCur(today().slice(0, 7))}>今天</button>
      </div>
      <div className="main-body">
        <div className="cal-grid" style={{ borderBottom: 'none' }}>
          {['一', '二', '三', '四', '五', '六', '日'].map(d =>
            <div key={d} style={{ padding: 6, textAlign: 'center' }} className="muted">{d}</div>)}
        </div>
        <div className="cal-grid">
          {cells.map(c => (
            <div key={c.ds} className={'cal-cell' + (c.dim ? ' dim' : '') + (c.ds === today() ? ' today' : '')}>
              <span className="dnum">{c.day}</span>
              {tasks.filter(t => t.due_date === c.ds).map(t => (
                <div key={t.id} className={'cal-task' + (t.completed ? ' done' : '')} title={t.title} onClick={() => toggle(t)}>
                  {t.due_time ? t.due_time + ' ' : ''}{t.title}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
