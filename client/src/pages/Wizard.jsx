import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

const COLORS = ['#4f46e5', '#dc2626', '#16a34a', '#d97706', '#0891b2', '#9333ea', '#db2777'];
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export default function Wizard() {
  const [step, setStep] = useState(0);
  const [subjects, setSubjects] = useState([]);
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [followRoutine, setFollowRoutine] = useState(true);
  const [routineShift, setRoutineShift] = useState({ sleep_start: '', sleep_end: '' });
  const [newSubject, setNewSubject] = useState('');
  // items: {key, subject_id, subject_name, color, title, minutes}
  const [items, setItems] = useState([]);
  const [rangeInput, setRangeInput] = useState({});
  const [mode, setMode] = useState('spread');
  const [dates, setDates] = useState({ start: today(), end: plusDays(6) });
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const nav = useNavigate();

  useEffect(() => {
    api('/subjects').then(setSubjects);
    api('/events').then(setEvents);
    api('/settings').then(s => { setSettings(s); setRoutineShift({ sleep_start: s.sleep_start, sleep_end: s.sleep_end }); });
  }, []);

  async function addSubject() {
    if (!newSubject.trim()) return;
    await api('/subjects', { method: 'POST', body: { name: newSubject.trim(), color: COLORS[subjects.length % COLORS.length] } });
    setNewSubject('');
    api('/subjects').then(setSubjects);
  }

  function addRange(s) {
    const title = (rangeInput[s.id] || '').trim();
    if (!title) return;
    setItems(it => [...it, { key: Date.now() + Math.random(), subject_id: s.id, subject_name: s.name, color: s.color, title, minutes: 120 }]);
    setRangeInput(r => ({ ...r, [s.id]: '' }));
  }

  function move(i, dir) {
    setItems(it => {
      const a = [...it];
      const j = i + dir;
      if (j < 0 || j >= a.length) return a;
      [a[i], a[j]] = [a[j], a[i]];
      return a;
    });
  }

  async function genPreview() {
    setErr('');
    try {
      const body = {
        startDate: dates.start, endDate: dates.end, mode,
        items: items.map(({ subject_id, title, minutes }) => ({ subject_id, title, minutes })),
      };
      if (!followRoutine) { body.sleep_start = routineShift.sleep_start; body.sleep_end = routineShift.sleep_end; }
      const p = await api('/schedule/preview', { method: 'POST', body });
      setPreview(p);
      setStep(4);
    } catch (e) { setErr(e.message); }
  }

  async function confirm() {
    await api('/schedule/confirm', { method: 'POST', body: { blocks: preview.blocks, clearRange: { from: dates.start, to: dates.end } } });
    nav('/');
  }

  const steps = ['確認行程與作息', '選科目與範圍', '偏好設定', '日期範圍', '確認排程'];

  return (
    <div className="page">
      <h2>排程精靈</h2>
      <div className="steps">{steps.map((_, i) => <div key={i} className={'step-dot' + (i <= step ? ' on' : '')} />)}</div>
      <div className="muted">步驟 {step + 1}／5：{steps[step]}</div>

      {step === 0 && settings && (
        <div className="card">
          <p>排程會避開你的<b>固定行程</b>（目前 {events.length} 筆）與睡覺、吃飯時間。</p>
          <p className="muted" style={{ margin: '8px 0' }}>還有行程沒放進行事曆？先到「固定行程」頁補齊再回來。</p>
          <div className="row" style={{ margin: '12px 0' }}>
            <label><input type="radio" checked={followRoutine} onChange={() => setFollowRoutine(true)} /> 遵循原作息（睡 {settings.sleep_start}–{settings.sleep_end}）</label>
            <label><input type="radio" checked={!followRoutine} onChange={() => setFollowRoutine(false)} /> 這次要調整（可前後 1–2 小時）</label>
          </div>
          {!followRoutine && (
            <div className="row">
              <label>這次睡覺時間</label>
              <input type="time" value={routineShift.sleep_start} onChange={e => setRoutineShift(r => ({ ...r, sleep_start: e.target.value }))} />
              <span>–</span>
              <input type="time" value={routineShift.sleep_end} onChange={e => setRoutineShift(r => ({ ...r, sleep_end: e.target.value }))} />
            </div>
          )}
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setStep(1)}>下一步</button>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <div className="row">
            <input placeholder="新增科目（如：數學）" value={newSubject} onChange={e => setNewSubject(e.target.value)} />
            <button className="btn sm" onClick={addSubject}>＋科目</button>
          </div>
          {subjects.map(s => (
            <div key={s.id} style={{ marginTop: 14 }}>
              <span className="tag" style={{ background: s.color }}>{s.name}</span>
              <div className="row" style={{ marginTop: 6 }}>
                <input placeholder="讀書範圍（如：第三章）" value={rangeInput[s.id] || ''} onChange={e => setRangeInput(r => ({ ...r, [s.id]: e.target.value }))} />
                <button className="btn sm ghost" onClick={() => addRange(s)}>＋範圍</button>
              </div>
              {items.filter(it => it.subject_id === s.id).map(it => (
                <div key={it.key} className="row" style={{ marginTop: 6, marginLeft: 12 }}>
                  <span>• {it.title}</span>
                  <input type="number" min="30" step="30" value={it.minutes} style={{ width: 80 }}
                    onChange={e => setItems(list => list.map(x => x.key === it.key ? { ...x, minutes: +e.target.value } : x))} />
                  <span className="muted">分鐘</span>
                  <button className="btn sm danger" onClick={() => setItems(list => list.filter(x => x.key !== it.key))}>✕</button>
                </div>
              ))}
            </div>
          ))}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn ghost" onClick={() => setStep(0)}>上一步</button>
            <button className="btn" disabled={!items.length} onClick={() => setStep(2)}>下一步</button>
          </div>
          {!items.length && <div className="muted" style={{ marginTop: 8 }}>至少加入一個讀書範圍（預設每個範圍 120 分鐘，可修改）</div>}
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <label><input type="radio" checked={mode === 'order'} onChange={() => setMode('order')} /> 按照科目順序讀</label>
            <label><input type="radio" checked={mode === 'spread'} onChange={() => setMode('spread')} /> 打散平均分配</label>
          </div>
          {mode === 'order' && (
            <div>
              <p className="muted">調整順序（由上到下依序安排）：</p>
              {items.map((it, i) => (
                <div key={it.key} className="row" style={{ marginTop: 6 }}>
                  <span className="tag" style={{ background: it.color }}>{it.subject_name}</span>
                  <span>{it.title}</span>
                  <button className="btn sm ghost" onClick={() => move(i, -1)}>↑</button>
                  <button className="btn sm ghost" onClick={() => move(i, 1)}>↓</button>
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn ghost" onClick={() => setStep(1)}>上一步</button>
            <button className="btn" onClick={() => setStep(3)}>下一步</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <div className="row">
            <label>從</label><input type="date" value={dates.start} onChange={e => setDates(d => ({ ...d, start: e.target.value }))} />
            <label>到</label><input type="date" value={dates.end} onChange={e => setDates(d => ({ ...d, end: e.target.value }))} />
          </div>
          {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn ghost" onClick={() => setStep(2)}>上一步</button>
            <button className="btn" onClick={genPreview}>產生排程</button>
          </div>
        </div>
      )}

      {step === 4 && preview && (
        <div className="card">
          {preview.unplaced && <div className="error">{preview.message}</div>}
          {Object.entries(preview.blocks.reduce((acc, b) => { (acc[b.date] = acc[b.date] || []).push(b); return acc; }, {})).map(([d, list]) => (
            <div key={d} className="preview-day">
              <h4>{d}</h4>
              {list.map((b, i) => {
                const s = subjects.find(x => x.id === b.subject_id);
                return <div key={i} className="row" style={{ marginTop: 4 }}>
                  <span className="muted">{b.start_time}–{b.end_time}</span>
                  <span className="tag" style={{ background: s?.color }}>{s?.name}</span>
                  <span>{b.title}</span>
                </div>;
              })}
            </div>
          ))}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn ghost" onClick={() => setStep(3)}>不滿意，重新調整</button>
            <button className="btn" onClick={confirm}>滿意，確認排程！</button>
          </div>
        </div>
      )}
    </div>
  );
}
