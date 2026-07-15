import { useEffect, useState } from 'react';
import { api } from '../api';
import { today, addDays, localISO } from './helpers';
import { PALETTE } from './Icons';
import Icon from './Icons';

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

// 顏色選擇：白底 + 鮮明 / 莫蘭迪 / 日系 三組色盤
function ColorPicker({ value, onPick }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="muted" style={{ marginBottom: 4 }}>顏色</div>
      <div className="swatches" style={{ marginBottom: 8 }}>
        <span className={'swatch' + (!value ? ' on' : '')} style={{ background: '#fff', border: '1px solid var(--border)' }} title="白底黑字" onClick={() => onPick('')} />
      </div>
      {PALETTE.map(g => (
        <div key={g.name} style={{ marginBottom: 6 }}>
          <div className="muted" style={{ fontSize: 11 }}>{g.name}</div>
          <div className="swatches">
            {g.colors.map(([c, n]) => (
              <span key={c} title={n} className={'swatch' + (value === c ? ' on' : '')} style={{ background: c }} onClick={() => onPick(c)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CalendarView({ tasks, reload }) {
  const [view, setView] = useState('week'); // day | week | month
  const [anchor, setAnchor] = useState(today());
  const [events, setEvents] = useState([]);           // 匯入/新增的既定行程（課表、補習等）
  const loadEvents = () => api('/events').then(setEvents).catch(() => {});
  useEffect(() => { loadEvents(); setAnchor(today()); }, []); // 每次打開都回到今天那一週

  // 直接在日曆匯入課表/行程（AI 解析 → 編輯 → 加入）
  const [aiBusy, setAiBusy] = useState(false);
  // 匯入預覽存 localStorage：解析完可以退出 app、回來繼續編輯匯入
  const [aiList, setAiListRaw] = useState(() => {
    try { const s = localStorage.getItem('calImport'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const setAiList = v => {
    setAiListRaw(v);
    try { v ? localStorage.setItem('calImport', JSON.stringify(v)) : localStorage.removeItem('calImport'); } catch {}
  };
  // 解析中的檔案也存起來：解析途中退出 app，重開會自動接著解析
  async function doParse(payload) {
    setAiBusy(true);
    try {
      const { events: parsed } = await api('/import/parse', { method: 'POST', body: payload });
      localStorage.removeItem('calImportPending');
      if (!parsed.length) alert('AI 沒有在檔案中找到行程');
      else setAiListRaw(prev => {
        const next = [...(prev || []), ...parsed.map(p => ({ ...p, checked: true, date: p.date || today() }))];
        try { localStorage.setItem('calImport', JSON.stringify(next)); } catch {}
        return next;
      });
    } catch (err) {
      alert('解析失敗：' + err.message + '（可稍後重試，檔案已保留）');
    }
    setAiBusy(false);
  }
  async function importFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const payload = { filename: file.name, mime: file.type, data: btoa(bin) };
    try { localStorage.setItem('calImportPending', JSON.stringify(payload)); } catch {} // 太大就不存，仍可即時解析
    doParse(payload);
  }
  // 開啟頁面時：若有「解析到一半」的檔案且還沒結果，自動接著解析
  useEffect(() => {
    if (aiBusy) return;
    try {
      const p = localStorage.getItem('calImportPending');
      if (p) doParse(JSON.parse(p));
    } catch {}
  }, []);
  const updAi = (i, patch) => setAiList(aiList.map((x, j) => j === i ? { ...x, ...patch } : x));
  const addAiRow = () => setAiList([...(aiList || []), { title: '', date: anchor, start_time: '08:00', end_time: '09:00', location: '', recurring: null, checked: true }]);
  async function confirmImport() {
    const picked = aiList.filter(x => x.checked);
    // 手打的日期/時間格式檢查，格式不對就明確指出哪一筆
    const timeRe = /^([01]?\d|2[0-3]):[0-5]\d$/, dateRe = /^\d{4}-\d{2}-\d{2}$/;
    for (const x of picked) {
      if (!(x.title || '').trim()) { alert('有一筆行程沒有名稱，請補上或取消勾選'); return; }
      if (!timeRe.test(x.start_time || '') || !timeRe.test(x.end_time || '')) { alert(`「${x.title}」的時間格式要像 08:00`); return; }
      if (!x.recurring && !dateRe.test(x.date || '')) { alert(`「${x.title}」的日期格式要像 2026-08-31`); return; }
    }
    const chosen = picked.map(x => ({ ...x, start_time: x.start_time.length === 4 ? '0' + x.start_time : x.start_time }));
    if (!chosen.length) { alert('沒有可加入的行程（請確認有勾選、且填了名稱與時間）'); return; }
    // 一個請求打包送出（取代日期的刪除＋全部新增都在伺服器端做），不再逐筆等待
    setAiBusy(true);
    try {
      await api('/events/bulk', {
        method: 'POST',
        body: {
          events: chosen.map(({ checked, ...body }) => body),
          replaceDates: [...new Set(chosen.filter(x => !x.recurring).map(x => x.date))],
          replaceWeekdays: [...new Set(chosen.filter(x => x.recurring).map(x => new Date(x.date + 'T00:00:00').getDay()))],
        },
      });
    } catch (err) { setAiBusy(false); alert('加入失敗：' + err.message); return; }
    setAiBusy(false);
    setAiList(null);
    loadEvents();
    const first = chosen.map(x => x.date).sort()[0];
    if (first && first > today()) setAnchor(first);
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

  // 點行程 → 開編輯（名稱、時間、顏色、刪除）；預設白底黑字
  const [editEv, setEditEv] = useState(null);
  async function saveEvent() {
    const ev = editEv;
    if (!ev.title.trim()) { alert('請輸入行程名稱'); return; }
    // #4 顏色有改，且有其他同名行程 → 詢問是否一起變色
    const orig = events.find(x => x.id === ev.id);
    const colorChanged = orig && (orig.color || '') !== (ev.color || '');
    const sameName = events.filter(x => x.title === orig?.title && x.id !== ev.id);
    let applySameName = false;
    if (colorChanged && sameName.length) {
      applySameName = window.confirm(`要把所有「${orig.title}」的行程都改成同一個顏色嗎？（共 ${sameName.length + 1} 筆）\n\n確定＝全部一起變　取消＝只改這一筆`);
    }
    await api(`/events/${ev.id}`, {
      method: 'PATCH',
      body: { title: ev.title.trim(), location: ev.location || '', color: ev.color || '', date: ev.date, start_time: ev.start_time, end_time: ev.end_time, applyAll: !!ev.recurring },
    });
    if (applySameName) {
      for (const x of sameName) await api(`/events/${x.id}`, { method: 'PATCH', body: { color: ev.color || '' } });
    }
    setEditEv(null);
    loadEvents();
  }
  // 拖曳行程到別天（像 Excel 一樣）：放開就改日期
  async function dropEvent(dragEv, d) {
    dragEv.preventDefault();
    const id = dragEv.dataTransfer.getData('text/ev-id');
    if (!id) return;
    const e = events.find(x => String(x.id) === id);
    if (!e || e.date === d) return;
    await api(`/events/${id}`, { method: 'PATCH', body: { date: d } });
    loadEvents();
  }
  async function deleteEvent(ev) {
    if (!window.confirm(`刪除行程「${ev.title}」？`)) return;
    setEditEv(null);
    if (ev.recurring) {
      for (const e of events.filter(x => x.title === ev.title && x.start_time === ev.start_time && x.recurring)) {
        await api(`/events/${e.id}`, { method: 'DELETE' });
      }
    } else await api(`/events/${ev.id}`, { method: 'DELETE' });
    loadEvents();
  }

  // 手動新增行程
  const [addMenu, setAddMenu] = useState(false);
  const [addForm, setAddForm] = useState(null);
  function openAdd(date = anchor) {
    setAddMenu(false);
    setAddForm({ title: '', date, start_time: '08:00', end_time: '09:00', location: '', color: '', recurring: '' });
  }
  async function submitAdd() {
    if (!addForm.title.trim()) { alert('請輸入行程名稱'); return; }
    await api('/events', { method: 'POST', body: { ...addForm, title: addForm.title.trim(), recurring: addForm.recurring || null } });
    setAddForm(null);
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
              <div key={'e' + e.id} className="trow" style={{ cursor: 'pointer' }} onClick={() => setEditEv({ ...e })}>
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
          <div key={d} style={{ position: 'relative', height: totalH, borderLeft: '1px solid var(--border)', background: d === today() ? 'rgba(0,122,255,.03)' : undefined }}
            onDragOver={ev => ev.preventDefault()} onDrop={ev => dropEvent(ev, d)}>
            {HOURS.map((h, i) => (
              <div key={h} style={{ position: 'absolute', top: i * ROW, left: 0, right: 0, height: ROW }}>
                <div onClick={() => openAdd(d)} title="點一下新增行程" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW / 2, borderTop: '1px solid var(--border)', cursor: 'pointer' }} />
                <div onClick={() => openAdd(d)} style={{ position: 'absolute', top: ROW / 2, left: 0, right: 0, height: ROW / 2, borderTop: '1px dashed rgba(120,120,128,.18)', cursor: 'pointer' }} />
              </div>
            ))}
            {/* 既定行程：白底黑字，可點擊編輯、可拖曳到別天，高度＝時長 */}
            {eventsOn(d).map(e => {
              const top = yOf(toMin(e.start_time));
              const height = Math.max(16, yOf(toMin(e.end_time)) - top);
              const bg = e.color || '#ffffff';
              const dark = textOn(e.color) === '#fff';
              return (
                <div key={'e' + e.id} onClick={ev => { ev.stopPropagation(); setEditEv({ ...e }); }} title="點一下編輯，拖曳可換天"
                  draggable onDragStart={ev => { ev.dataTransfer.setData('text/ev-id', String(e.id)); ev.dataTransfer.effectAllowed = 'move'; }}
                  style={{
                    position: 'absolute', top, height, left: 2, right: 2, zIndex: 2,
                    background: bg, color: textOn(e.color), border: `1px solid ${e.color || 'var(--border)'}`,
                    borderLeft: `3px solid ${e.color || '#c7c7cc'}`, borderRadius: 6, padding: '2px 5px',
                    fontSize: 11, lineHeight: 1.15, overflow: 'hidden', cursor: 'pointer', textAlign: 'center',
                  }}>
                  <div style={{ fontWeight: 600 }}>{e.title}</div>
                  {e.location ? <div style={{ fontSize: 10, color: dark ? 'rgba(255,255,255,.75)' : '#8e8e93' }}>{e.location}</div> : null}
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
                  onClick={ev => { ev.stopPropagation(); setEditEv({ ...e }); }}>
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
      <div className="main-head cal-head">
        <h2>日曆</h2>
        <select value={view} onChange={e => setView(e.target.value)} className="cal-view-sel">
          <option value="list">清單</option>
          <option value="year">年</option>
          <option value="month">月</option>
          <option value="week">週</option>
          <option value="3day">3日</option>
          <option value="day">日</option>
        </select>
        {view !== 'list' && view !== 'year' && <>
          <button className="icon-btn" onClick={() => view === 'month' ? navMonth(-1) : shift(-1)}>◀</button>
          <b style={{ fontSize: 14, whiteSpace: 'nowrap' }}>{view === 'month' ? `${+anchor.slice(0, 4)}年${+anchor.slice(5, 7)}月` : view === 'week' ? `${+monday.slice(5, 7)}/${+monday.slice(8)} 起` : `${+anchor.slice(5, 7)}/${+anchor.slice(8)}`}</b>
          <button className="icon-btn" onClick={() => view === 'month' ? navMonth(1) : shift(1)}>▶</button>
        </>}
        <button className="btn sm ghost" onClick={() => setAnchor(today())}>今天</button>
        <div style={{ position: 'relative' }}>
          <button className="icon-btn" title="新增" onClick={() => setAddMenu(m => !m)}><Icon name="plus" size={18} /></button>
          {addMenu && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 20 }} onClick={() => setAddMenu(false)} />
              <div className="add-menu">
                <div onClick={() => openAdd()}><Icon name="pencil" size={15} /> 手動新增行程</div>
                <label style={{ cursor: 'pointer' }}>
                  <Icon name="calendar" size={15} /> {aiBusy ? 'AI 解析中…' : '匯入課表照片'}
                  <input type="file" accept="image/*,.pdf,.ics" style={{ display: 'none' }} onChange={e => { setAddMenu(false); importFile(e); }} disabled={aiBusy} />
                </label>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="main-body">
        {aiList && (
          <div className="tile" style={{ margin: '8px 0' }}>
            <b>共 {aiList.length} 筆行程，加入前可修改：</b>
            <div className="muted" style={{ margin: '2px 0 8px' }}>加入時，這些日期原有的行程會被取代（可繼續匯入更多、離開再回來也還在）</div>
            {aiList.map((ev, i) => {
              const mdVal = ev.recurring ? '每週' : (ev.date && /^\d{4}-\d{2}-\d{2}$/.test(ev.date) ? `${+ev.date.slice(5, 7)}/${+ev.date.slice(8)}` : ev.date || '');
              const onMd = v => {
                if (ev.recurring) return;
                const m = v.match(/(\d{1,2})\s*[\/／.\-]\s*(\d{1,2})/);
                const yr = (ev.date || today()).slice(0, 4);
                updAi(i, { date: m ? `${yr}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}` : v });
              };
              return (
                <div key={i} className="imp-row">
                  <input type="checkbox" checked={ev.checked} onChange={() => updAi(i, { checked: !ev.checked })} />
                  <input className="imp-date" value={mdVal} placeholder="7/12" disabled={!!ev.recurring} onChange={e => onMd(e.target.value)} />
                  <input className="imp-title" value={ev.title || ''} placeholder="行程名稱" onChange={e => updAi(i, { title: e.target.value })} />
                  <input className="imp-time" value={ev.start_time || ''} placeholder="10:00" onChange={e => updAi(i, { start_time: e.target.value })} />
                  <span className="muted">–</span>
                  <input className="imp-time" value={ev.end_time || ''} placeholder="12:00" onChange={e => updAi(i, { end_time: e.target.value })} />
                  <button className="icon-btn" title="刪除" onClick={() => setAiList(aiList.filter((_, j) => j !== i))}><Icon name="x" size={13} /></button>
                </div>
              );
            })}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn sm ghost" onClick={addAiRow}>＋ 加一筆</button>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={confirmImport}>加入日曆</button>
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

      {/* 編輯行程：名稱、時間、顏色、刪除 */}
      {editEv && (
        <div className="cal-modal-back" onClick={() => setEditEv(null)}>
          <div className="tile cal-modal" onClick={e => e.stopPropagation()}>
            <input className="title" value={editEv.title} placeholder="行程名稱"
              onChange={e => setEditEv(v => ({ ...v, title: e.target.value }))} style={{ fontSize: 17, fontWeight: 700, width: '100%' }} />
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">日期</span>
              <input type="date" value={editEv.date || ''} onChange={e => setEditEv(v => ({ ...v, date: e.target.value }))} />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">時間</span>
              <input type="time" value={editEv.start_time?.slice(0, 5)} onChange={e => setEditEv(v => ({ ...v, start_time: e.target.value }))} />
              <span>–</span>
              <input type="time" value={editEv.end_time?.slice(0, 5)} onChange={e => setEditEv(v => ({ ...v, end_time: e.target.value }))} />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">地點</span>
              <input value={editEv.location || ''} placeholder="（選填）" onChange={e => setEditEv(v => ({ ...v, location: e.target.value }))} style={{ flex: 1 }} />
            </div>
            {editEv.recurring && <div className="muted" style={{ marginTop: 6 }}>每週重複・改動會套用到每一週</div>}
            <ColorPicker value={editEv.color} onPick={c => setEditEv(v => ({ ...v, color: c }))} />
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn sm ghost" style={{ color: 'var(--red)' }} onClick={() => deleteEvent(editEv)}>刪除</button>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={saveEvent}>儲存</button>
            </div>
          </div>
        </div>
      )}

      {/* 手動新增行程 */}
      {addForm && (
        <div className="cal-modal-back" onClick={() => setAddForm(null)}>
          <div className="tile cal-modal" onClick={e => e.stopPropagation()}>
            <b>新增行程</b>
            <input value={addForm.title} placeholder="行程名稱（如：數學課、補習）" autoFocus
              onChange={e => setAddForm(v => ({ ...v, title: e.target.value }))} style={{ width: '100%', marginTop: 8 }} />
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">日期</span>
              <input type="date" value={addForm.date} onChange={e => setAddForm(v => ({ ...v, date: e.target.value }))} />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">時間</span>
              <input type="time" value={addForm.start_time} onChange={e => setAddForm(v => ({ ...v, start_time: e.target.value }))} />
              <span>–</span>
              <input type="time" value={addForm.end_time} onChange={e => setAddForm(v => ({ ...v, end_time: e.target.value }))} />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">地點</span>
              <input value={addForm.location} placeholder="（選填）" onChange={e => setAddForm(v => ({ ...v, location: e.target.value }))} style={{ flex: 1 }} />
            </div>
            <label className="row" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={addForm.recurring === 'weekly'} onChange={e => setAddForm(v => ({ ...v, recurring: e.target.checked ? 'weekly' : '' }))} />
              <span>每週重複（固定課表）</span>
            </label>
            <ColorPicker value={addForm.color} onPick={c => setAddForm(v => ({ ...v, color: c }))} />
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn sm ghost" onClick={() => setAddForm(null)}>取消</button>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={submitAdd}>新增</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
