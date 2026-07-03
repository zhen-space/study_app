import { useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';

const ICONS = ['⭐', '💧', '🏃', '📖', '🧘', '💪', '🌙', '🍎'];

export default function HabitsView({ habits, reload }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('⭐');

  const week = [...Array(7)].map((_, i) => addDays(today(), i - 6));

  const streak = h => {
    let s = 0, d = today();
    if (!h.checkins.includes(d)) d = addDays(d, -1);
    while (h.checkins.includes(d)) { s++; d = addDays(d, -1); }
    return s;
  };
  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await api('/habits', { method: 'POST', body: { name: name.trim(), icon } });
    setName('');
    reload();
  }
  async function check(h, date) {
    await api(`/habits/${h.id}/checkin`, { method: 'POST', body: { date, undo: h.checkins.includes(date) } });
    reload();
  }

  return (
    <div className="main">
      <div className="main-head"><h2>習慣打卡</h2></div>
      <div className="main-body">
        <form className="quick-add" style={{ margin: '6px 0' }} onSubmit={add}>
          <select value={icon} onChange={e => setIcon(e.target.value)}>{ICONS.map(i => <option key={i}>{i}</option>)}</select>
          <input placeholder="＋ 新增習慣（如：背 10 個單字）" value={name} onChange={e => setName(e.target.value)} />
          <button className="btn sm">新增</button>
        </form>
        {habits.map(h => (
          <div className="habit-row" key={h.id}>
            <span className="habit-icon">{h.icon}</span>
            <div>
              <div>{h.name}</div>
              <div className="streak">🔥 連續 {streak(h)} 天・共 {h.checkins.length} 次</div>
            </div>
            <div className="week-dots">
              {week.map(d => (
                <div key={d} className={'wdot' + (h.checkins.includes(d) ? ' on' : '')}
                  style={h.checkins.includes(d) ? { background: h.color } : {}}
                  title={d} onClick={() => check(h, d)}>
                  {d === today() ? '今' : +d.slice(8)}
                </div>
              ))}
            </div>
            <button className="icon-btn" onClick={() => api(`/habits/${h.id}`, { method: 'DELETE' }).then(reload)}>✕</button>
          </div>
        ))}
        {habits.length === 0 && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>還沒有習慣，新增一個開始打卡吧</div>}
      </div>
    </div>
  );
}
