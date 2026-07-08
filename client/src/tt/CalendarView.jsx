import { useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';

const WD = ['一', '二', '三', '四', '五', '六', '日'];
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 06:00–23:00
const ROW = 44;

export default function CalendarView({ tasks, reload }) {
  const [view, setView] = useState('week'); // day | week | month
  const [anchor, setAnchor] = useState(today());

  const toggle = async t => {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: !t.completed } });
    reload();
  };
  async function quickCreate(date, hour) {
    const title = prompt(`${date} ${String(hour).padStart(2, '0')}:00 新增行程：`);
    if (!title?.trim()) return;
    await api('/tasks', { method: 'POST', body: { title: title.trim(), due_date: date, due_time: `${String(hour).padStart(2, '0')}:00` } });
    reload();
  }

  const monday = (() => { const d = new Date(anchor + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const weekDays = [...Array(7)].map((_, i) => addDays(monday, i));
  const shift = n => setAnchor(addDays(anchor, view === 'day' ? n : view === '3day' ? n * 3 : view === 'week' ? n * 7 : 0));

  /* ---- 清單視圖（List）：未來 60 天的行程依日期列出 ---- */
  const ListView = () => {
    const upcoming = tasks.filter(t => t.due_date && t.due_date >= today() && t.due_date <= addDays(today(), 60))
      .sort((a, b) => a.due_date === b.due_date ? (a.due_time || '99').localeCompare(b.due_time || '99') : a.due_date.localeCompare(b.due_date));
    const byDate = {};
    upcoming.forEach(t => (byDate[t.due_date] = byDate[t.due_date] || []).push(t));
    return (
      <div>
        {Object.entries(byDate).map(([d, list]) => (
          <div key={d} className="tgroup">
            <div className="glabel">{`${+d.slice(5, 7)}/${+d.slice(8)}`} 週{WD[(new Date(d + 'T00:00:00').getDay() + 6) % 7]}{d === today() ? '（今天）' : ''}</div>
            {list.map(t => (
              <div key={t.id} className={'trow' + (t.completed ? ' done' : '')} style={{ cursor: 'default' }}>
                <input type="checkbox" checked={!!t.completed} onChange={() => toggle(t)} />
                <span className="title">{t.title}</span>
                {t.due_time && <span className="muted">{t.due_time.slice(0, 5)}</span>}
              </div>
            ))}
          </div>
        ))}
        {!upcoming.length && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>未來 60 天沒有行程</div>}
      </div>
    );
  };

  /* ---- 年視圖：12 個月卡片，點了跳該月 ---- */
  const YearView = () => {
    const y = +anchor.slice(0, 4);
    return (
      <div>
        <div className="row" style={{ justifyContent: 'center', margin: '8px 0' }}>
          <button className="icon-btn" onClick={() => setAnchor(`${y - 1}-01-01`)}>◀</button>
          <b>{y} 年</b>
          <button className="icon-btn" onClick={() => setAnchor(`${y + 1}-01-01`)}>▶</button>
        </div>
        <div className="stat-tiles">
          {[...Array(12)].map((_, i) => {
            const m = String(i + 1).padStart(2, '0');
            const n = tasks.filter(t => t.due_date?.startsWith(`${y}-${m}`)).length;
            return (
              <button key={m} className="tile" style={{ cursor: 'pointer', textAlign: 'center' }}
                onClick={() => { setAnchor(`${y}-${m}-01`); setView('month'); }}>
                <div style={{ fontWeight: 700 }}>{i + 1} 月</div>
                <div className="muted">{n ? `${n} 項` : '—'}</div>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  /* ---- 小時制格線（日/週共用） ---- */
  const HourGrid = ({ days }) => (
    <div style={{ display: 'grid', gridTemplateColumns: `44px repeat(${days.length}, 1fr)`, borderTop: '1px solid var(--border)' }}>
      <div />
      {days.map(d => (
        <div key={d} style={{ textAlign: 'center', padding: 4, fontSize: 12, fontWeight: d === today() ? 700 : 400, color: d === today() ? 'var(--primary)' : 'var(--muted)' }}>
          {`${+d.slice(5, 7)}/${+d.slice(8)}`}<br />週{WD[(new Date(d + 'T00:00:00').getDay() + 6) % 7]}
        </div>
      ))}
      {HOURS.map(h => (
        <div key={h} style={{ display: 'contents' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right', paddingRight: 4, height: ROW, borderTop: '1px solid var(--border)' }}>{String(h).padStart(2, '0')}:00</div>
          {days.map(d => {
            const cell = tasks.filter(t => t.due_date === d && t.due_time && +t.due_time.slice(0, 2) === h);
            return (
              <div key={d + h} onClick={() => !cell.length && quickCreate(d, h)}
                style={{ height: ROW, borderTop: '1px solid var(--border)', borderLeft: '1px solid var(--border)', position: 'relative', overflow: 'hidden', cursor: 'pointer', background: d === today() ? 'rgba(71,114,250,.04)' : undefined }}>
                {cell.map(t => (
                  <div key={t.id} className={'cal-task' + (t.completed ? ' done' : '')} onClick={e => { e.stopPropagation(); toggle(t); }}
                    style={{ position: 'absolute', inset: 1, fontSize: 11, lineHeight: 1.2, whiteSpace: 'normal', overflow: 'hidden' }}>
                    {t.due_time.slice(0, 5)} {t.title}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  /* ---- 月視圖 ---- */
  const MonthGrid = () => {
    const [y, m] = [+anchor.slice(0, 4), +anchor.slice(5, 7)];
    const first = new Date(y, m - 1, 1);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    const cells = [...Array(42)].map((_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { ds, day: d.getDate(), dim: d.getMonth() !== m - 1 };
    });
    return (
      <>
        <div className="cal-grid" style={{ borderBottom: 'none' }}>
          {WD.map(d => <div key={d} style={{ padding: 6, textAlign: 'center' }} className="muted">{d}</div>)}
        </div>
        <div className="cal-grid">
          {cells.map(c => (
            <div key={c.ds} className={'cal-cell' + (c.dim ? ' dim' : '') + (c.ds === today() ? ' today' : '')}
              onClick={() => { setAnchor(c.ds); setView('day'); }} style={{ cursor: 'pointer' }}>
              <span className="dnum">{c.day}</span>
              {tasks.filter(t => t.due_date === c.ds).slice(0, 3).map(t => (
                <div key={t.id} className={'cal-task' + (t.completed ? ' done' : '')} title={t.title}
                  onClick={e => { e.stopPropagation(); toggle(t); }}>{t.title}</div>
              ))}
              {tasks.filter(t => t.due_date === c.ds).length > 3 && <div className="muted" style={{ fontSize: 10 }}>+{tasks.filter(t => t.due_date === c.ds).length - 3}</div>}
            </div>
          ))}
        </div>
      </>
    );
  };

  const navMonth = n => {
    const d = new Date(+anchor.slice(0, 4), +anchor.slice(5, 7) - 1 + n, 1);
    setAnchor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
  };

  return (
    <div className="main">
      <div className="main-head">
        <h2>日曆</h2>
        <select value={view} onChange={e => setView(e.target.value)}>
          <option value="list">☰ 清單</option>
          <option value="year">年</option>
          <option value="month">月</option>
          <option value="week">週</option>
          <option value="3day">3 日</option>
          <option value="day">日</option>
        </select>
        {view !== 'list' && view !== 'year' && <>
          <button className="icon-btn" onClick={() => view === 'month' ? navMonth(-1) : shift(-1)}>◀</button>
          <b style={{ fontSize: 14 }}>{view === 'month' ? `${+anchor.slice(0, 4)}年${+anchor.slice(5, 7)}月` : view === 'week' ? `${monday.slice(5)} 起` : anchor.slice(5)}</b>
          <button className="icon-btn" onClick={() => view === 'month' ? navMonth(1) : shift(1)}>▶</button>
        </>}
        <button className="btn sm ghost" onClick={() => setAnchor(today())}>今天</button>
      </div>
      <div className="main-body">
        {['day', '3day', 'week'].includes(view) && <div className="muted" style={{ margin: '6px 0' }}>點空格可直接新增該時段的行程</div>}
        {view === 'list' && <ListView />}
        {view === 'year' && <YearView />}
        {view === 'day' && <HourGrid days={[anchor]} />}
        {view === '3day' && <HourGrid days={[anchor, addDays(anchor, 1), addDays(anchor, 2)]} />}
        {view === 'week' && <HourGrid days={weekDays} />}
        {view === 'month' && <MonthGrid />}
      </div>
    </div>
  );
}
