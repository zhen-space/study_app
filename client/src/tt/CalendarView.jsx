import { useEffect, useState } from 'react';
import { api } from '../api';
import { today, addDays, localISO } from './helpers';
import { LIST_COLORS } from './Icons';

const WD = ['一', '二', '三', '四', '五', '六', '日'];
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 06:00–23:00
const ROW = 44;
const H0 = 6;                                       // 時間軸起點小時
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const yOf = m => (m - H0 * 60) / 60 * ROW;          // 分鐘 → 垂直位置
// 依背景色自動選黑/白字，確保看得清楚
const textOn = hex => {
  if (!hex) return '#111';
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff';
};

export default function CalendarView({ tasks, reload }) {
  const [view, setView] = useState('week'); // day | week | month
  const [anchor, setAnchor] = useState(today());
  const [events, setEvents] = useState([]);           // 匯入/新增的既定行程（課表、補習等）
  const loadEvents = () => api('/events').then(setEvents).catch(() => {});
  useEffect(() => { loadEvents(); setAnchor(today()); }, []); // 每次打開都回到今天那一週

  // 直接在日曆匯入課表/行程（AI 解析 → 勾選 → 加入）
  const [aiBusy, setAiBusy] = useState(false);
  const [aiList, setAiList] = useState(null);
  async function importFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setAiBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const { events: parsed } = await api('/import/parse', {
        method: 'POST', body: { filename: file.name, mime: file.type, data: btoa(bin) },
      });
      if (!parsed.length) alert('AI 沒有在檔案中找到行程');
      else setAiList(parsed.map(p => ({ ...p, checked: true })));
    } catch (err) { alert(err.message); }
    setAiBusy(false);
    e.target.value = '';
  }
  async function confirmImport() {
    const chosen = aiList.filter(x => x.checked);
    try {
      for (const ev of chosen) {
        const { checked, ...body } = ev;
        await api('/events', { method: 'POST', body });
      }
    } catch (err) { alert('加入失敗：' + err.message); return; }
    setAiList(null);
    loadEvents();
    // 跳到第一筆行程那一週，不然加在未來看不到、像沒加成功
    const first = chosen.map(x => x.date).sort()[0];
    if (first && first > today()) { setAnchor(first); }
    alert(`已加入 ${chosen.length} 筆行程${first && first > today() ? `（已跳到 ${first.slice(5).replace('-', '/')} 那週）` : ''}`);
  }
  // 某天有哪些既定行程（含每週重複）
  const eventsOn = d => {
    const dow = new Date(d + 'T00:00:00').getDay();
    return events.filter(e => e.recurring === 'weekly'
      ? new Date(e.date + 'T00:00:00').getDay() === dow && e.date <= d
      : e.date === d)
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
  };

  // 點行程 → 改顏色（每個行程一種顏色，預設白底黑字）
  const [colorEv, setColorEv] = useState(null);
  async function setEventColor(ev, color) {
    setColorEv(null);
    await api(`/events/${ev.id}`, { method: 'PATCH', body: { color, applyAll: !!ev.recurring } });
    loadEvents();
  }
  async function deleteEvent(ev) {
    setColorEv(null);
    if (!window.confirm(`刪除行程「${ev.title}」？`)) return;
    if (ev.recurring) {
      // 每週重複：刪掉同名同時段的所有筆
      for (const e of events.filter(x => x.title === ev.title && x.start_time === ev.start_time && x.recurring)) {
        await api(`/events/${e.id}`, { method: 'DELETE' });
      }
    } else await api(`/events/${ev.id}`, { method: 'DELETE' });
    loadEvents();
  }

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

  const monday = (() => { const d = new Date(anchor + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localISO(d); })();
  const weekDays = [...Array(7)].map((_, i) => addDays(monday, i));
  const shift = n => setAnchor(addDays(anchor, view === 'day' ? n : view === '3day' ? n * 3 : view === 'week' ? n * 7 : 0));

  /* ---- 清單視圖（List）：未來 60 天的行程依日期列出（含既定行程） ---- */
  const ListView = () => {
    const upcoming = tasks.filter(t => t.due_date && t.due_date >= today() && t.due_date <= addDays(today(), 60))
      .sort((a, b) => a.due_date === b.due_date ? (a.due_time || '99').localeCompare(b.due_time || '99') : a.due_date.localeCompare(b.due_date));
    const byDate = {};
    upcoming.forEach(t => (byDate[t.due_date] = byDate[t.due_date] || []).push(t));
    const dates = new Set(Object.keys(byDate));
    for (let i = 0; i <= 60; i++) { const d = addDays(today(), i); if (eventsOn(d).length) dates.add(d); }
    const sorted = [...dates].sort();
    return (
      <div>
        {sorted.map(d => (
          <div key={d} className="tgroup">
            <div className="glabel">{`${+d.slice(5, 7)}/${+d.slice(8)}`} 週{WD[(new Date(d + 'T00:00:00').getDay() + 6) % 7]}{d === today() ? '（今天）' : ''}</div>
            {eventsOn(d).map(e => (
              <div key={'e' + e.id} className="trow" style={{ cursor: 'pointer' }} onClick={() => setColorEv(e)}>
                <span className="cal-ev-dot" style={{ background: e.color || '#c7c7cc' }} />
                <span className="title">{e.title}{e.location ? <span className="muted">（{e.location}）</span> : null}</span>
                <span className="muted">{e.start_time.slice(0, 5)}–{e.end_time.slice(0, 5)}</span>
              </div>
            ))}
            {(byDate[d] || []).map(t => (
              <div key={t.id} className={'trow' + (t.completed ? ' done' : '')} style={{ cursor: 'default' }}>
                <input type="checkbox" checked={!!t.completed} onChange={() => toggle(t)} />
                <span className="title">{t.title}</span>
                {t.due_time && <span className="muted">{t.due_time.slice(0, 5)}</span>}
              </div>
            ))}
          </div>
        ))}
        {!sorted.length && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>未來 60 天沒有行程</div>}
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

  /* ---- 小時制時間軸（日/週共用）：行程照開始–結束時間拉出高度的區塊 ---- */
  const HourGrid = ({ days }) => {
    const totalH = HOURS.length * ROW;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `44px repeat(${days.length}, 1fr)`, borderTop: '1px solid var(--border)' }}>
        {/* 表頭 */}
        <div />
        {days.map(d => (
          <div key={d} style={{ textAlign: 'center', padding: 4, fontSize: 12, fontWeight: d === today() ? 700 : 400, color: d === today() ? 'var(--primary)' : 'var(--muted)' }}>
            {`${+d.slice(5, 7)}/${+d.slice(8)}`}<br />週{WD[(new Date(d + 'T00:00:00').getDay() + 6) % 7]}
          </div>
        ))}
        {/* 時間刻度 */}
        <div style={{ position: 'relative', height: totalH }}>
          {HOURS.map((h, i) => (
            <div key={h} style={{ position: 'absolute', top: i * ROW - 6, right: 4, fontSize: 11, color: 'var(--muted)' }}>{String(h).padStart(2, '0')}:00</div>
          ))}
        </div>
        {/* 每一天一欄：格線 + 絕對定位的行程/任務區塊 */}
        {days.map(d => (
          <div key={d} style={{ position: 'relative', height: totalH, borderLeft: '1px solid var(--border)', background: d === today() ? 'rgba(0,122,255,.03)' : undefined }}>
            {HOURS.map((h, i) => (
              <div key={h} onClick={() => quickCreate(d, h)} title="點一下新增行程"
                style={{ position: 'absolute', top: i * ROW, left: 0, right: 0, height: ROW, borderTop: '1px solid var(--border)', cursor: 'pointer' }} />
            ))}
            {/* 既定行程：白底黑字，可點擊改色，高度＝時長 */}
            {eventsOn(d).map(e => {
              const top = yOf(toMin(e.start_time));
              const height = Math.max(16, yOf(toMin(e.end_time)) - top);
              const bg = e.color || '#ffffff';
              return (
                <div key={'e' + e.id} onClick={ev => { ev.stopPropagation(); setColorEv(e); }} title="點一下改顏色"
                  style={{
                    position: 'absolute', top, height, left: 2, right: 2, zIndex: 2,
                    background: bg, color: textOn(e.color), border: `1px solid ${e.color || 'var(--border)'}`,
                    borderLeft: `3px solid ${e.color || '#c7c7cc'}`, borderRadius: 6, padding: '2px 5px',
                    fontSize: 11, lineHeight: 1.15, overflow: 'hidden', cursor: 'pointer',
                  }}>
                  {e.title}{e.location ? <span style={{ opacity: .7 }}> ＠{e.location}</span> : null}
                </div>
              );
            })}
            {/* 有時間的任務 */}
            {tasks.filter(t => t.due_date === d && t.due_time).map(t => {
              const top = yOf(toMin(t.due_time));
              return (
                <div key={t.id} className={'cal-task' + (t.completed ? ' done' : '')} onClick={ev => { ev.stopPropagation(); toggle(t); }}
                  style={{ position: 'absolute', top, height: ROW - 4, left: 2, right: 2, zIndex: 3, fontSize: 11, lineHeight: 1.15, overflow: 'hidden' }}>
                  {t.due_time.slice(0, 5)} {t.title}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

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
              {eventsOn(c.ds).slice(0, 2).map(e => (
                <div key={'e' + e.id} className="cal-ev" title={e.title}
                  style={e.color ? { background: e.color, color: textOn(e.color) } : { background: '#fff', color: '#111', border: '1px solid var(--border)' }}
                  onClick={ev => { ev.stopPropagation(); setColorEv(e); }}>
                  {e.title}
                </div>
              ))}
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
        <label className="btn sm ghost" style={{ cursor: 'pointer' }}>
          {aiBusy ? 'AI 解析中…' : '📷 匯入'}
          <input type="file" accept="image/*,.pdf,.ics" style={{ display: 'none' }} onChange={importFile} disabled={aiBusy} />
        </label>
      </div>
      <div className="main-body">
        {aiList && (
          <div className="tile" style={{ margin: '8px 0' }}>
            <b>AI 讀到 {aiList.length} 筆行程，勾選要加入的：</b>
            {aiList.map((ev, i) => (
              <div key={i} className="row" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={ev.checked} onChange={() => setAiList(a => a.map((x, j) => j === i ? { ...x, checked: !x.checked } : x))} />
                <span style={{ flex: 1 }}>{ev.title}{ev.location ? `＠${ev.location}` : ''}</span>
                <span className="muted">{ev.recurring ? '每週' : ev.date?.slice(5)} {ev.start_time}–{ev.end_time}</span>
              </div>
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn sm" onClick={confirmImport}>加入日曆</button>
              <button className="btn sm ghost" onClick={() => setAiList(null)}>取消</button>
            </div>
          </div>
        )}
        {['day', '3day', 'week'].includes(view) && <div className="muted" style={{ margin: '6px 0' }}>點空格可直接新增該時段的行程</div>}
        {view === 'list' && <ListView />}
        {view === 'year' && <YearView />}
        {view === 'day' && <HourGrid days={[anchor]} />}
        {view === '3day' && <HourGrid days={[anchor, addDays(anchor, 1), addDays(anchor, 2)]} />}
        {view === 'week' && <HourGrid days={weekDays} />}
        {view === 'month' && <MonthGrid />}
      </div>

      {/* 行程改色 / 刪除 */}
      {colorEv && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setColorEv(null)}>
          <div className="tile" style={{ width: 300, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
            <b>{colorEv.title}</b>
            <div className="muted" style={{ margin: '2px 0 10px' }}>{colorEv.start_time.slice(0, 5)}–{colorEv.end_time.slice(0, 5)}{colorEv.recurring ? '・每週' : ''}</div>
            <div className="swatches">
              <span className="swatch" style={{ background: '#fff', border: '1px solid var(--border)' }} title="白底黑字" onClick={() => setEventColor(colorEv, '')} />
              {LIST_COLORS.map(c => (
                <span key={c} className={'swatch' + (colorEv.color === c ? ' on' : '')} style={{ background: c }} onClick={() => setEventColor(colorEv, c)} />
              ))}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn sm ghost" style={{ color: 'var(--red)' }} onClick={() => deleteEvent(colorEv)}>刪除行程</button>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setColorEv(null)}>完成</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
