import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Calendar() {
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState({ title: '', date: new Date().toISOString().slice(0, 10), start_time: '08:00', end_time: '09:00', recurring: '' });
  const [settings, setSettings] = useState(null);
  const [err, setErr] = useState('');

  const load = () => api('/events').then(setEvents);
  useEffect(() => { load(); api('/settings').then(setSettings); }, []);

  async function add(e) {
    e.preventDefault();
    setErr('');
    try {
      await api('/events', { method: 'POST', body: { ...form, recurring: form.recurring || null } });
      setForm(f => ({ ...f, title: '' }));
      load();
    } catch (e) { setErr(e.message); }
  }

  async function saveSettings() {
    await api('/settings', { method: 'PUT', body: settings });
    alert('已儲存');
  }

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="page">
      <h2>固定行程</h2>
      <p className="muted">先把上課、社團等既定行程放進來，排程精靈會自動避開這些時間。</p>
      <form className="card row" onSubmit={add}>
        <input placeholder="行程名稱（如：數學課）" value={form.title} onChange={set('title')} required style={{ flex: 1, minWidth: 160 }} />
        <input type="date" value={form.date} onChange={set('date')} />
        <input type="time" value={form.start_time} onChange={set('start_time')} />
        <span>–</span>
        <input type="time" value={form.end_time} onChange={set('end_time')} />
        <select value={form.recurring} onChange={set('recurring')}>
          <option value="">單次</option>
          <option value="weekly">每週重複</option>
        </select>
        <button className="btn">新增</button>
        {err && <div className="error">{err}</div>}
      </form>

      <div>
        {events.map(e => (
          <div key={e.id} className="event-item">
            <span><b>{e.title}</b> <span className="muted">{e.date} {e.start_time}–{e.end_time}{e.recurring === 'weekly' ? '（每週）' : ''}</span></span>
            <button className="btn sm danger" onClick={() => api(`/events/${e.id}`, { method: 'DELETE' }).then(load)}>刪除</button>
          </div>
        ))}
        {events.length === 0 && <div className="muted">尚無固定行程</div>}
      </div>

      {settings && (
        <div className="card">
          <h3>作息設定</h3>
          <div className="row" style={{ marginTop: 10 }}>
            <label>睡覺</label>
            <input type="time" value={settings.sleep_start} onChange={e => setSettings(s => ({ ...s, sleep_start: e.target.value }))} />
            <span>–</span>
            <input type="time" value={settings.sleep_end} onChange={e => setSettings(s => ({ ...s, sleep_end: e.target.value }))} />
          </div>
          <div style={{ marginTop: 10 }}>
            <label>吃飯時段</label>
            {settings.meal_windows.map((w, i) => (
              <div className="row" key={i} style={{ marginTop: 6 }}>
                <input type="time" value={w[0]} onChange={e => setSettings(s => { const m = [...s.meal_windows]; m[i] = [e.target.value, m[i][1]]; return { ...s, meal_windows: m }; })} />
                <span>–</span>
                <input type="time" value={w[1]} onChange={e => setSettings(s => { const m = [...s.meal_windows]; m[i] = [m[i][0], e.target.value]; return { ...s, meal_windows: m }; })} />
                <button type="button" className="btn sm danger" onClick={() => setSettings(s => ({ ...s, meal_windows: s.meal_windows.filter((_, j) => j !== i) }))}>移除</button>
              </div>
            ))}
            <button type="button" className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setSettings(s => ({ ...s, meal_windows: [...s.meal_windows, ['12:00', '12:30']] }))}>＋新增時段</button>
          </div>
          <button className="btn" style={{ marginTop: 12 }} onClick={saveSettings}>儲存作息</button>
        </div>
      )}
    </div>
  );
}
