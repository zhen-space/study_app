import { useEffect, useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';
import { parseICS } from './ics';

const LIST_COLORS = ['#4772fa', '#e03131', '#16a34a', '#f59f00', '#9333ea', '#0891b2'];

export default function WizardView({ lists, reload, goTasks }) {
  const [step, setStep] = useState(0);
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [follow, setFollow] = useState(true);
  const [shift, setShift] = useState({ sleep_start: '', sleep_end: '' });
  const [evForm, setEvForm] = useState({ title: '', date: today(), start_time: '08:00', end_time: '09:00', recurring: '' });
  const [items, setItems] = useState([]);
  const [rangeInput, setRangeInput] = useState({});
  const [mode, setMode] = useState('spread');
  const [dates, setDates] = useState({ start: today(), end: addDays(today(), 6) });
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const loadEv = () => api('/events').then(setEvents);
  useEffect(() => {
    loadEv();
    api('/settings').then(s => { setSettings(s); setShift({ sleep_start: s.sleep_start, sleep_end: s.sleep_end }); });
  }, []);

  const [importMsg, setImportMsg] = useState('');
  async function importICS(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportMsg('讀取中…');
    try {
      const parsed = parseICS(await file.text());
      const horizon = addDays(today(), 60);
      const wanted = parsed.filter(ev => ev.recurring || (ev.date >= today() && ev.date <= horizon));
      const existing = await api('/events');
      const dup = ev => existing.some(x => x.title === ev.title && x.date === ev.date && x.start_time === ev.start_time);
      let n = 0;
      for (const ev of wanted.slice(0, 200)) {
        if (dup(ev)) continue;
        await api('/events', { method: 'POST', body: ev });
        n++;
      }
      setImportMsg(`匯入完成：新增 ${n} 筆行程${wanted.length > 200 ? '（超過 200 筆已截斷）' : ''}`);
      loadEv();
    } catch {
      setImportMsg('讀取失敗，請確認是 .ics 行事曆檔');
    }
    e.target.value = '';
  }

  async function addEvent(e) {
    e.preventDefault();
    if (!evForm.title.trim()) return;
    await api('/events', { method: 'POST', body: { ...evForm, recurring: evForm.recurring || null } });
    setEvForm(f => ({ ...f, title: '' }));
    loadEv();
  }
  async function addSubject() {
    const name = prompt('科目名稱（如：數學）：');
    if (!name?.trim()) return;
    await api('/lists', { method: 'POST', body: { name: name.trim(), color: LIST_COLORS[lists.length % LIST_COLORS.length] } });
    reload();
  }
  function addRange(l) {
    const title = (rangeInput[l.id] || '').trim();
    if (!title) return;
    setItems(it => [...it, { key: Date.now() + Math.random(), subject_id: l.id, name: l.name, color: l.color, title, minutes: 120 }]);
    setRangeInput(r => ({ ...r, [l.id]: '' }));
  }
  const move = (i, dir) => setItems(a => {
    const b = [...a], j = i + dir;
    if (j < 0 || j >= b.length) return b;
    [b[i], b[j]] = [b[j], b[i]];
    return b;
  });

  async function genPreview() {
    setErr('');
    try {
      const body = { startDate: dates.start, endDate: dates.end, mode, items: items.map(({ subject_id, title, minutes }) => ({ subject_id, title, minutes })) };
      if (!follow) { body.sleep_start = shift.sleep_start; body.sleep_end = shift.sleep_end; }
      setPreview(await api('/schedule/preview', { method: 'POST', body }));
      setStep(4);
    } catch (e) { setErr(e.message); }
  }
  async function confirm() {
    setSaving(true);
    for (const b of preview.blocks) {
      await api('/tasks', { method: 'POST', body: {
        title: b.title, list_id: b.subject_id, due_date: b.date, due_time: b.start_time,
        notes: `讀書時段 ${b.start_time}–${b.end_time}`, tags: ['讀書計劃'],
      } });
    }
    setSaving(false);
    reload();
    goTasks();
  }

  const steps = ['行程與作息', '科目與範圍', '分配偏好', '日期', '確認'];

  return (
    <div className="main">
      <div className="main-head"><h2>🪄 排程精靈</h2></div>
      <div className="main-body">
        <div className="steps" style={{ marginTop: 8 }}>{steps.map((_, i) => <div key={i} className={'step-dot' + (i <= step ? ' on' : '')} />)}</div>
        <div className="muted" style={{ marginBottom: 10 }}>步驟 {step + 1}／5：{steps[step]}</div>

        {step === 0 && settings && (
          <div className="tile">
            <p>排程會自動避開<b>既定行程</b>與睡覺、吃飯時間。先把上課、補習等行程放進來：</p>
            <label className="btn sm ghost" style={{ display: 'inline-block', marginTop: 10 }}>
              📅 匯入行事曆檔（.ics）
              <input type="file" accept=".ics,text/calendar" style={{ display: 'none' }} onChange={importICS} />
            </label>
            {importMsg && <div className="muted" style={{ marginTop: 4 }}>{importMsg}</div>}
            <form className="row" style={{ marginTop: 10 }} onSubmit={addEvent}>
              <input placeholder="行程名稱" value={evForm.title} onChange={e => setEvForm(f => ({ ...f, title: e.target.value }))} style={{ flex: 1, minWidth: 130 }} />
              <input type="date" value={evForm.date} onChange={e => setEvForm(f => ({ ...f, date: e.target.value }))} />
              <input type="time" value={evForm.start_time} onChange={e => setEvForm(f => ({ ...f, start_time: e.target.value }))} />
              <input type="time" value={evForm.end_time} onChange={e => setEvForm(f => ({ ...f, end_time: e.target.value }))} />
              <select value={evForm.recurring} onChange={e => setEvForm(f => ({ ...f, recurring: e.target.value }))}>
                <option value="">單次</option><option value="weekly">每週</option>
              </select>
              <button className="btn sm">＋</button>
            </form>
            {events.map(e => (
              <div key={e.id} className="row" style={{ marginTop: 6 }}>
                <span>📌 {e.title}</span><span className="muted">{e.date} {e.start_time}–{e.end_time}{e.recurring ? '（每週）' : ''}</span>
                <button className="icon-btn" onClick={() => api(`/events/${e.id}`, { method: 'DELETE' }).then(loadEv)}>✕</button>
              </div>
            ))}
            <div style={{ marginTop: 14 }}>
              <label style={{ display: 'block' }}><input type="radio" checked={follow} onChange={() => setFollow(true)} /> 遵循平常作息（睡 {settings.sleep_start}–{settings.sleep_end}）</label>
              <label style={{ display: 'block', marginTop: 4 }}><input type="radio" checked={!follow} onChange={() => setFollow(false)} /> 這次調整（可前後 1–2 小時）</label>
              {!follow && (
                <div className="row" style={{ marginTop: 6 }}>
                  <input type="time" value={shift.sleep_start} onChange={e => setShift(s => ({ ...s, sleep_start: e.target.value }))} />
                  <span>–</span>
                  <input type="time" value={shift.sleep_end} onChange={e => setShift(s => ({ ...s, sleep_end: e.target.value }))} />
                </div>
              )}
            </div>
            <button className="btn" style={{ marginTop: 14 }} onClick={() => setStep(1)}>下一步</button>
          </div>
        )}

        {step === 1 && (
          <div className="tile">
            <p className="muted">科目＝你的清單。每個範圍預設 120 分鐘，可修改。</p>
            <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={addSubject}>＋新增科目</button>
            {lists.map(l => (
              <div key={l.id} style={{ marginTop: 12 }}>
                <span className="tag" style={{ background: l.color, color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>{l.name}</span>
                <div className="row" style={{ marginTop: 6 }}>
                  <input placeholder="讀書範圍（如：第三章）" value={rangeInput[l.id] || ''} onChange={e => setRangeInput(r => ({ ...r, [l.id]: e.target.value }))} style={{ flex: 1 }} />
                  <button className="btn sm ghost" onClick={() => addRange(l)}>＋</button>
                </div>
                {items.filter(it => it.subject_id === l.id).map(it => (
                  <div key={it.key} className="row" style={{ marginTop: 6, marginLeft: 10 }}>
                    <span>• {it.title}</span>
                    <input type="number" min="30" step="30" value={it.minutes} style={{ width: 76 }}
                      onChange={e => setItems(a => a.map(x => x.key === it.key ? { ...x, minutes: +e.target.value } : x))} />
                    <span className="muted">分</span>
                    <button className="icon-btn" onClick={() => setItems(a => a.filter(x => x.key !== it.key))}>✕</button>
                  </div>
                ))}
              </div>
            ))}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setStep(0)}>上一步</button>
              <button className="btn" disabled={!items.length} onClick={() => setStep(2)}>下一步</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="tile">
            <label style={{ display: 'block' }}><input type="radio" checked={mode === 'order'} onChange={() => setMode('order')} /> 按照科目順序讀（可調整順序）</label>
            <label style={{ display: 'block', marginTop: 4 }}><input type="radio" checked={mode === 'spread'} onChange={() => setMode('spread')} /> 打散平均分配</label>
            {mode === 'order' && items.map((it, i) => (
              <div key={it.key} className="row" style={{ marginTop: 6 }}>
                <span style={{ color: it.color }}>■</span><span>{it.name}｜{it.title}</span>
                <button className="icon-btn" onClick={() => move(i, -1)}>↑</button>
                <button className="icon-btn" onClick={() => move(i, 1)}>↓</button>
              </div>
            ))}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setStep(1)}>上一步</button>
              <button className="btn" onClick={() => setStep(3)}>下一步</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="tile">
            <div className="row">
              <label>從</label><input type="date" value={dates.start} onChange={e => setDates(d => ({ ...d, start: e.target.value }))} />
              <label>到</label><input type="date" value={dates.end} onChange={e => setDates(d => ({ ...d, end: e.target.value }))} />
            </div>
            {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setStep(2)}>上一步</button>
              <button className="btn" onClick={genPreview}>產生排程</button>
            </div>
          </div>
        )}

        {step === 4 && preview && (
          <div className="tile">
            {preview.unplaced && <div className="error">{preview.message}</div>}
            {Object.entries(preview.blocks.reduce((a, b) => { (a[b.date] = a[b.date] || []).push(b); return a; }, {})).map(([d, list]) => (
              <div key={d} style={{ marginBottom: 10 }}>
                <b>{d}</b>
                {list.map((b, i) => {
                  const l = lists.find(x => x.id === b.subject_id);
                  return <div key={i} className="row" style={{ marginTop: 4 }}>
                    <span className="muted">{b.start_time}–{b.end_time}</span>
                    <span style={{ color: l?.color }}>■</span><span>{l?.name}｜{b.title}</span>
                  </div>;
                })}
              </div>
            ))}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setStep(3)}>不滿意，重新調整</button>
              <button className="btn" disabled={saving} onClick={confirm}>{saving ? '建立中…' : '滿意，加入待辦！'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
