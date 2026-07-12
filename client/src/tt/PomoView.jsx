import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export default function PomoView({ tasks }) {
  const [mins, setMins] = useState(25);
  const [left, setLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [log, setLog] = useState([]);
  const timer = useRef();

  const loadLog = () => api('/pomo').then(setLog);
  useEffect(() => { loadLog(); }, []);

  useEffect(() => {
    if (!running) return;
    timer.current = setInterval(() => setLeft(l => l - 1), 1000);
    return () => clearInterval(timer.current);
  }, [running]);

  useEffect(() => {
    if (left <= 0 && running) {
      setRunning(false);
      api('/pomo', { method: 'POST', body: { task_id: taskId ? +taskId : null, minutes: mins } }).then(loadLog);
      try { new Notification('番茄鐘完成！', { body: '休息一下吧 🍅' }); } catch {}
      alert('🍅 番茄鐘完成！休息一下吧');
      setLeft(mins * 60);
    }
  }, [left, running]);

  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const start = () => {
    if (Notification?.permission === 'default') Notification.requestPermission();
    setRunning(true);
  };

  // 白噪音（WebAudio 直接產生，離線可用）：white=均勻沙沙、rain=低通像下雨、brown=深沉海浪
  const [noise, setNoise] = useState('off');
  const audio = useRef(null);
  useEffect(() => {
    if (audio.current) { try { audio.current.src.stop(); audio.current.ctx.close(); } catch {} audio.current = null; }
    if (noise === 'off') return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const size = 2 * ctx.sampleRate;
    const buf = ctx.createBuffer(1, size, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < size; i++) {
      const w = Math.random() * 2 - 1;
      if (noise === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    let node = src;
    if (noise === 'rain') { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; src.connect(f); node = f; }
    const g = ctx.createGain(); g.gain.value = noise === 'white' ? 0.06 : 0.12;
    node.connect(g); g.connect(ctx.destination);
    src.start();
    audio.current = { ctx, src };
    return () => { try { src.stop(); ctx.close(); } catch {} };
  }, [noise]);

  return (
    <div className="main">
      <div className="main-head"><h2>番茄專注</h2></div>
      <div className="main-body">
        <div className="pomo">
          <div className="pomo-ring"><div className="time">{fmt(left)}</div></div>
          <div className="drow">
            <select value={taskId} onChange={e => setTaskId(e.target.value)}>
              <option value="">不綁定任務</option>
              {tasks.filter(t => !t.completed).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <select value={mins} disabled={running} onChange={e => { setMins(+e.target.value); setLeft(+e.target.value * 60); }}>
              {[5, 15, 25, 45, 60].map(m => <option key={m} value={m}>{m} 分鐘</option>)}
            </select>
          </div>
          <div className="drow">
            {!running
              ? <button className="btn" onClick={start}>開始專注</button>
              : <button className="btn" style={{ background: 'var(--red)' }} onClick={() => { setRunning(false); setLeft(mins * 60); }}>放棄</button>}
          </div>
          <div className="drow">
            <span className="muted">背景音：</span>
            {[['off', '🔇 無'], ['white', '📻 白噪音'], ['rain', '🌧️ 雨聲'], ['brown', '🌊 深沉']].map(([v, l]) => (
              <span key={v} className={'tag-pill' + (noise === v ? ' on' : '')} style={{ cursor: 'pointer' }} onClick={() => setNoise(v)}>{l}</span>
            ))}
          </div>
          <div style={{ width: '100%', maxWidth: 480 }}>
            <h4 style={{ margin: '10px 0 6px' }}>專注紀錄</h4>
            {log.map(s => (
              <div key={s.id} className="trow" style={{ cursor: 'default' }}>
                <span>🍅</span>
                <span className="title">{s.task_title || '專注'}</span>
                <span className="muted">{s.date}・{s.minutes} 分鐘</span>
              </div>
            ))}
            {log.length === 0 && <div className="muted">還沒有專注紀錄</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
