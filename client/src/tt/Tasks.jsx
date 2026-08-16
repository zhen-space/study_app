import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { matchView, groupTasks, defaultSort, PRI, today, addDays } from './helpers';
import VocabCard from './VocabCard';
import MemoCard from './MemoCard';

const WDC = '日一二三四五六';
export function repeatLabel(r, dueDate) {
  if (!r) return '不重複';
  if (r === 'daily') return '每天';
  if (r === 'weekly') return dueDate ? `每週${WDC[new Date(dueDate + 'T00:00:00').getDay()]}` : '每週';
  if (r === 'monthly') return dueDate ? `每月${+dueDate.slice(8)}日` : '每月';
  if (r === 'yearly') return dueDate ? `每年${+dueDate.slice(5, 7)}/${+dueDate.slice(8)}` : '每年';
  if (r === 'weekdays') return '週一至週五';
  try {
    const c = JSON.parse(r);
    let s;
    if (c.type === 'ebbinghaus') {
      s = `記憶曲線（1/2/4/7/15/30 天複習，第 ${(c.step || 0) + 1} 階）`;
    } else {
      const u = { day: '天', week: '週', month: '個月', year: '年' }[c.unit] || c.unit;
      s = `每${c.every > 1 ? ` ${c.every} ` : ''}${u}`;
      if (c.unit === 'week' && c.days?.length) s += `（${c.days.map(d => '週' + WDC[d]).join('、')}）`;
      if (c.unit === 'month' && c.monthDays?.length) s += `（${c.monthDays.map(d => d === -1 ? '最後一天' : d + ' 號').join('、')}）`;
      if (c.unit === 'month' && c.monthWeek) s += `（${c.monthWeek.nth === -1 ? '最後一個' : `第 ${c.monthWeek.nth} 個`}週${WDC[c.monthWeek.day]}）`;
    }
    if (c.fromDone) s += '・完成後起算';
    if (c.end?.count != null) s += `・再重複 ${c.end.count} 次`;
    if (c.end?.date) s += `・到 ${+c.end.date.slice(5, 7)}/${+c.end.date.slice(8)} 為止`;
    return s;
  } catch { return r; }
}

// v1 學生端先不露出「重複任務」：只隱藏 UI 入口。
// RepeatPicker、repeatLabel、以及後端的 nextDate()／recurring 欄位全部保留，
// 既有的重複任務照常運作，之後要放回來把這個改成 true 就好。
const RECURRING_UI = false;

// 詳細重複設定（完整 TickTick 式）：每天/週/月/年/平日/記憶曲線/自訂；
// 月可「按日期多選＋最後一天」或「第 N 個星期 X」；可設結束條件與完成後起算
function RepeatPicker({ value, dueDate, missPolicy, onChange }) {
  const isCustom = value?.startsWith('{');
  const cfg = isCustom ? JSON.parse(value) : { every: 1, unit: 'week', days: [] };
  const isEbb = cfg.type === 'ebbinghaus';
  const setCustom = patch => onChange(JSON.stringify({ ...cfg, ...patch }), missPolicy);
  const mode = isEbb ? 'ebbinghaus' : isCustom ? 'custom' : (value || '');
  // 簡單規則 → JSON（要加結束條件/完成後起算時自動轉換，行為不變）
  const toCfg = v => v === 'daily' ? { every: 1, unit: 'day' }
    : v === 'weekly' ? { every: 1, unit: 'week', days: dueDate ? [new Date(dueDate + 'T00:00:00').getDay()] : [] }
    : v === 'monthly' ? { every: 1, unit: 'month' }
    : v === 'yearly' ? { every: 1, unit: 'year' }
    : v === 'weekdays' ? { every: 1, unit: 'week', days: [1, 2, 3, 4, 5] }
    : { every: 1, unit: 'week', days: [] };
  const withCfg = patch => {
    const base = isCustom ? cfg : toCfg(mode);
    onChange(JSON.stringify({ ...base, ...patch }), missPolicy);
  };
  const endMode = cfg.end?.count != null ? 'count' : cfg.end?.date ? 'date' : '';
  const monthMode = cfg.monthWeek ? 'week' : 'date';

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <div className="drow">
        <label>重複</label>
        <select value={mode} onChange={e => {
          const v = e.target.value;
          if (v === 'custom') onChange(JSON.stringify({ every: 1, unit: 'week', days: dueDate ? [new Date(dueDate + 'T00:00:00').getDay()] : [] }), missPolicy);
          else if (v === 'ebbinghaus') onChange(JSON.stringify({ type: 'ebbinghaus', step: 0, fromDone: true }), missPolicy);
          else onChange(v || null, missPolicy);
        }}>
          <option value="">不重複</option>
          <option value="daily">每天</option>
          <option value="weekly">每週{dueDate ? `（${WDC[new Date(dueDate + 'T00:00:00').getDay()]}）` : ''}</option>
          <option value="monthly">每月{dueDate ? `（${+dueDate.slice(8)}日）` : ''}</option>
          <option value="yearly">每年{dueDate ? `（${+dueDate.slice(5, 7)}/${+dueDate.slice(8)}）` : ''}</option>
          <option value="weekdays">每個平日（週一至週五）</option>
          <option value="ebbinghaus">艾賓浩斯記憶曲線（1/2/4/7/15/30 天）</option>
          <option value="custom">自訂…</option>
        </select>
      </div>

      {isCustom && !isEbb && (
        <div style={{ marginTop: 8 }}>
          <div className="drow">
            <label>每</label>
            <input type="number" min="1" max="99" value={cfg.every} style={{ width: 58 }}
              onChange={e => setCustom({ every: Math.max(1, +e.target.value || 1) })} />
            <select value={cfg.unit} onChange={e => setCustom({ unit: e.target.value, monthDays: undefined, monthWeek: undefined, days: undefined })}>
              <option value="day">天</option><option value="week">週</option>
              <option value="month">個月</option><option value="year">年</option>
            </select>
          </div>
          {cfg.unit === 'week' && (
            <div className="drow" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              {[1, 2, 3, 4, 5, 6, 0].map(d => (
                <span key={d} className={'tag-pill' + (cfg.days?.includes(d) ? ' on' : '')} style={{ cursor: 'pointer' }}
                  onClick={() => setCustom({ days: cfg.days?.includes(d) ? cfg.days.filter(x => x !== d) : [...(cfg.days || []), d] })}>
                  {WDC[d]}
                </span>
              ))}
            </div>
          )}
          {cfg.unit === 'month' && (
            <div style={{ marginTop: 6 }}>
              <div className="drow">
                <label style={{ display: 'inline-flex', gap: 4 }}><input type="radio" checked={monthMode === 'date'} onChange={() => setCustom({ monthWeek: undefined })} /> 按日期</label>
                <label style={{ display: 'inline-flex', gap: 4 }}><input type="radio" checked={monthMode === 'week'} onChange={() => setCustom({ monthDays: undefined, monthWeek: { nth: 1, day: dueDate ? new Date(dueDate + 'T00:00:00').getDay() : 1 } })} /> 按星期</label>
              </div>
              {monthMode === 'date' && (
                <div className="drow" style={{ marginTop: 4, flexWrap: 'wrap', gap: 4 }}>
                  {[...Array(31)].map((_, i) => (
                    <span key={i} className={'tag-pill' + (cfg.monthDays?.includes(i + 1) ? ' on' : '')} style={{ cursor: 'pointer', padding: '2px 7px', fontSize: 12 }}
                      onClick={() => setCustom({ monthDays: cfg.monthDays?.includes(i + 1) ? cfg.monthDays.filter(x => x !== i + 1) : [...(cfg.monthDays || []), i + 1] })}>{i + 1}</span>
                  ))}
                  <span className={'tag-pill' + (cfg.monthDays?.includes(-1) ? ' on' : '')} style={{ cursor: 'pointer', padding: '2px 7px', fontSize: 12 }}
                    onClick={() => setCustom({ monthDays: cfg.monthDays?.includes(-1) ? cfg.monthDays.filter(x => x !== -1) : [...(cfg.monthDays || []), -1] })}>最後一天</span>
                </div>
              )}
              {monthMode === 'week' && (
                <div className="drow" style={{ marginTop: 4 }}>
                  <select value={cfg.monthWeek?.nth ?? 1} onChange={e => setCustom({ monthWeek: { ...cfg.monthWeek, nth: +e.target.value } })}>
                    {[1, 2, 3, 4].map(n => <option key={n} value={n}>第 {n} 個</option>)}
                    <option value={-1}>最後一個</option>
                  </select>
                  <select value={cfg.monthWeek?.day ?? 1} onChange={e => setCustom({ monthWeek: { ...cfg.monthWeek, day: +e.target.value } })}>
                    {[1, 2, 3, 4, 5, 6, 0].map(d => <option key={d} value={d}>週{WDC[d]}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {isEbb && <div className="muted" style={{ marginTop: 6 }}>完成後 1、2、4、7、15、30、60 天各複習一次（每完成一次進下一階）</div>}

      {mode && (
        <>
          <div className="drow" style={{ marginTop: 8 }}>
            <label style={{ width: 'auto' }}>結束</label>
            <select value={endMode} onChange={e => {
              const v = e.target.value;
              withCfg({ end: v === 'count' ? { count: 10 } : v === 'date' ? { date: dueDate || '' } : undefined });
            }}>
              <option value="">永不結束</option>
              <option value="count">重複 N 次後</option>
              <option value="date">到某天為止</option>
            </select>
            {endMode === 'count' && <input type="number" min="1" max="999" value={cfg.end.count} style={{ width: 62 }}
              onChange={e => withCfg({ end: { count: Math.max(1, +e.target.value || 1) } })} />}
            {endMode === 'date' && <input type="date" value={cfg.end.date || ''}
              onChange={e => withCfg({ end: { date: e.target.value } })} />}
          </div>
          {!isEbb && (
            <label className="drow" style={{ marginTop: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!cfg.fromDone} onChange={e => withCfg({ fromDone: e.target.checked || undefined })} />
              <span>完成後才起算下一次（按完成日推，不是按到期日）</span>
            </label>
          )}
          <div className="muted" style={{ marginTop: 6 }}>{repeatLabel(isCustom ? value : value, dueDate)}</div>
          <div className="drow" style={{ marginTop: 8 }}>
            <label style={{ width: 'auto' }}>沒做到時</label>
            <select value={missPolicy || 'keep'} onChange={e => onChange(value, e.target.value)}>
              <option value="keep">保留在那一天，直到做完</option>
              <option value="drop">當天沒做就跳過，自動移到下一次</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}

function TaskRow({ t, lists, sel, onSel, onToggle, onDragStart, onDropOn, onSwipeDelete }) {
  const list = lists.find(l => l.id === t.list_id);
  const overdue = t.due_date && t.due_date < today() && !t.completed;
  // 右滑刪除：滑超過 90px 放開就刪（可用底部的「復原」救回）
  const sw = useRef(null);
  const [dx, setDx] = useState(0);
  const rowRef = useRef(null);
  const start = e => { if (!onSwipeDelete) return; const p = e.touches[0]; sw.current = { x: p.clientX, y: p.clientY, on: false }; };
  const move = e => {
    const s = sw.current; if (!s) return;
    const p = e.touches[0];
    const ax = p.clientX - s.x, ay = p.clientY - s.y;
    if (!s.on) { if (Math.abs(ax) > 12 && Math.abs(ax) > Math.abs(ay) * 1.5) s.on = true; else if (Math.abs(ay) > 12) { sw.current = null; return; } }
    if (s.on) { e.preventDefault(); setDx(Math.max(0, ax)); }   // 只往右滑
  };
  const end = () => {
    const s = sw.current; sw.current = null;
    if (s?.on && dx > 90) { setDx(0); onSwipeDelete(t); return; }
    setDx(0);
  };
  return (
    <div style={{ position: 'relative', overflow: 'hidden' }}>
      {dx > 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', paddingLeft: 14, borderRadius: 10, background: dx > 90 ? 'var(--red)' : 'var(--fill-strong)', color: dx > 90 ? '#fff' : 'var(--muted)', fontSize: 13, fontWeight: 600 }}>
          🗑 {dx > 90 ? '放開就刪除' : '再滑一點'}
        </div>
      )}
      <div ref={rowRef} className={'trow' + (t.completed ? ' done' : '') + (sel ? ' sel' : '')} onClick={() => { if (dx < 6) onSel(t); }}
        draggable={!!onDragStart}
        onDragStart={onDragStart ? () => onDragStart(t) : undefined}
        onDragOver={onDropOn ? e => e.preventDefault() : undefined}
        onDrop={onDropOn ? () => onDropOn(t) : undefined}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end} onTouchCancel={end}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : 'transform .18s', position: 'relative', background: 'var(--card)' }}>
        <input type="checkbox" checked={!!t.completed} onClick={e => e.stopPropagation()} onChange={() => onToggle(t)} />
        {t.priority > 0 && <span className={PRI[t.priority][1]}>⚑</span>}
        <span className="title">{t.title}</span>
        {t.subtasks.length > 0 && <span className="chip">{t.subtasks.filter(s => s.done).length}/{t.subtasks.length}</span>}
        {t.tags.map(tag => <span key={tag} className="chip">#{tag}</span>)}
        {t.due_date && <span className="muted" style={overdue ? { color: 'var(--red)' } : {}}>{t.due_date.slice(5)}{t.due_time ? ' ' + t.due_time : ''}</span>}
        {list && <span className="dot" style={{ background: list.color }} title={list.name} />}
      </div>
    </div>
  );
}

export function Detail({ task, lists, onSave, onDelete, onClose }) {
  const [t, setT] = useState(task);
  const up = patch => { const nt = { ...t, ...patch }; setT(nt); onSave(nt); };
  const [newSub, setNewSub] = useState('');

  // 附件
  const [atts, setAtts] = useState([]);
  const loadAtts = () => api(`/tasks/${task.id}/attachments`).then(setAtts).catch(() => {});
  // 一定要包成 { }：箭頭函式直接回傳 Promise 的話，React 會把那個 Promise 當成
  // 清理函式，關掉任務時就會 destroy() → 「l is not a function」整頁掛掉
  useEffect(() => { loadAtts(); }, [task.id]);
  async function addAtt(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { alert('檔案太大（上限 3MB）'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await api(`/tasks/${task.id}/attachments`, { method: 'POST', body: { name: file.name, mime: file.type, data: btoa(bin) } });
    e.target.value = '';
    loadAtts();
  }
  async function openAtt(a) {
    const full = await api(`/attachments/${a.id}`);
    const bin = atob(full.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: full.mime || 'application/octet-stream' }));
    const aEl = document.createElement('a');
    aEl.href = url; aEl.download = full.name; aEl.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return (
    <div className="detail">
      <div className="drow" style={{ justifyContent: 'space-between' }}>
        <select value={t.list_id || ''} onChange={e => up({ list_id: e.target.value ? +e.target.value : null })}>
          <option value="">願望清單</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button className="btn sm" onClick={onClose} title="完成編輯">✓ 完成</button>
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
      </div>
      {RECURRING_UI && (
        <RepeatPicker value={t.recurring} dueDate={t.due_date} missPolicy={t.miss_policy}
          onChange={(recurring, miss_policy) => up({ recurring, miss_policy })} />
      )}
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
      <div>
        <label className="muted">📎 附件</label>
        {atts.map(a => (
          <div key={a.id} className="subtask">
            <span style={{ flex: 1, cursor: 'pointer', color: 'var(--primary)' }} onClick={() => openAtt(a)}>{a.name}</span>
            <span className="muted">{Math.round(a.size * 0.75 / 1024)}KB</span>
            <button className="icon-btn" onClick={() => api(`/attachments/${a.id}`, { method: 'DELETE' }).then(loadAtts)}>✕</button>
          </div>
        ))}
        <input type="file" onChange={addAtt} style={{ marginTop: 4, width: '100%' }} />
      </div>
      <button className="btn sm" style={{ background: 'var(--red)', alignSelf: 'flex-start' }} onClick={() => onDelete(t)}>刪除任務</button>
    </div>
  );
}

function AddSheet({ view, lists, onDone, onClose }) {
  const td = today();
  const tm = addDays(today(), 1);
  const [f, setF] = useState({
    title: '',
    due_date: view.type === 'today' ? td : '',
    priority: 0,
    list_id: view.type === 'list' ? view.id : '',
    recurring: null,
    miss_policy: 'keep',
  });
  const [showRepeat, setShowRepeat] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!f.title.trim()) return;
    const body = { title: f.title.trim(), priority: f.priority };
    if (f.due_date) body.due_date = f.due_date;
    if (f.list_id) body.list_id = +f.list_id;
    if (f.recurring) { body.recurring = f.recurring; body.miss_policy = f.miss_policy; }
    if (view.type === 'tag') body.tags = [view.tag];
    await api('/tasks', { method: 'POST', body });
    onDone();
  }
  return (
    <div className="sheet-back" onClick={onClose}>
      <form className="sheet" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <input type="text" autoFocus placeholder="準備做什麼？" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
        <div className="opts">
          <button type="button" className={'tag-pill' + (f.due_date === td ? ' on' : '')} onClick={() => setF({ ...f, due_date: f.due_date === td ? '' : td })}>今天</button>
          <button type="button" className={'tag-pill' + (f.due_date === tm ? ' on' : '')} onClick={() => setF({ ...f, due_date: f.due_date === tm ? '' : tm })}>明天</button>
          <input type="date" value={f.due_date} onChange={e => setF({ ...f, due_date: e.target.value })} style={{ padding: '2px 6px' }} />
          <select value={f.priority} onChange={e => setF({ ...f, priority: +e.target.value })}>
            {[0, 1, 2, 3].map(p => <option key={p} value={p}>⚑ {PRI[p][0]}</option>)}
          </select>
          <select value={f.list_id} onChange={e => setF({ ...f, list_id: e.target.value })}>
            <option value="">願望清單</option>
            {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {RECURRING_UI && (
            <button type="button" className={'tag-pill' + (f.recurring ? ' on' : '')} onClick={() => setShowRepeat(s => !s)}>
              🔁 {f.recurring ? repeatLabel(f.recurring, f.due_date) : '重複'}
            </button>
          )}
        </div>
        {RECURRING_UI && showRepeat && (
          <div style={{ marginTop: 8 }}>
            <RepeatPicker value={f.recurring} dueDate={f.due_date} missPolicy={f.miss_policy}
              onChange={(r, mp) => setF({ ...f, recurring: r, miss_policy: mp || f.miss_policy })} />
          </div>
        )}
        <button className="btn">新增任務</button>
      </form>
    </div>
  );
}

export default function Tasks({ view, tasks, lists, filters, habits = [], reload, title, goVocab, goMemo, topSlot = null }) {
  const [selId, setSelId] = useState(null);
  const [quick, setQuick] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  // 排序方式記起來：下次開啟還是同一個（default | time | priority | title）
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem('taskSort') || 'default'; } catch { return 'default'; }
  });
  const pickSort = v => { setSortBy(v); try { localStorage.setItem('taskSort', v); } catch {} };

  // 科目（＝清單）在側邊欄的順序，拿來當「依科目」的第一層排序
  const subjOrd = {};
  lists.forEach((l, i) => { subjOrd[String(l.id)] = i; });
  // numeric：課名裡的數字要照數值比大小，不然「單元10」會排在「單元2」前面
  const byLesson = new Intl.Collator('zh-Hant', { numeric: true }).compare;

  const sortFns = {
    default: defaultSort, // 依時間，同一天依課序
    priority: (a, b) => b.priority - a.priority || defaultSort(a, b),
    title: (a, b) => a.title.localeCompare(b.title, 'zh-Hant'),
    // 依科目：每一組（已逾期／今天／某一天）裡面先照科目分堆，同一科內照課名順序
    subject: (a, b) =>
      ((subjOrd[String(a.list_id)] ?? 99) - (subjOrd[String(b.list_id)] ?? 99))
      || byLesson(a.title, b.title)
      || defaultSort(a, b),
    // 照科目分堆：科目已經是分組標題了，組內只要照課名排
    subjectGroup: (a, b) => byLesson(a.title, b.title) || defaultSort(a, b),
  };
  const applySort = list => sortFns[sortBy] ? [...list].sort(sortFns[sortBy]) : list;

  // 「照科目分堆」用科目當分組標題，不看日期（日期還是顯示在每一列右邊）
  const groupBySubject = list => {
    const by = new Map();
    for (const t of list) {
      const k = String(t.list_id ?? '');
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(t);
    }
    return [...by.entries()]
      .sort((a, b) => (subjOrd[a[0]] ?? 99) - (subjOrd[b[0]] ?? 99))
      .map(([k, l]) => [lists.find(x => String(x.id) === k)?.name || '未分科目', l]);
  };

  // 刪除/勾選立即從畫面消失，不等伺服器
  const [hidden, setHidden] = useState(new Set());
  // 樂觀覆蓋：編輯後畫面立刻變，不用等「存檔→重抓」兩趟往返；重抓回來就清掉
  const [over, setOver] = useState({});
  // 重抓回來就清掉樂觀狀態——但 hidden 不能無條件清空：
  // 勾完成之後可能先收到一份「還沒寫進去」的舊資料（別的地方也會觸發重載），
  // 清掉的話那一列會冒出來、等下一份資料到了才又消失，看起來就是閃一下。
  // 所以只放掉伺服器已經確認的：資料回來仍然符合目前視圖 = 還沒生效，繼續蓋著。
  useEffect(() => {
    setHidden(h => {
      if (!h.size) return h;
      const keep = [...h].filter(id => {
        const t = tasks.find(x => x.id === id);
        return t && matchView(t, view, { filters });
      });
      return keep.length === h.size ? h : new Set(keep);
    });
    setOver({});
  }, [tasks]);
  const tv = Object.keys(over).length ? tasks.map(t => over[t.id] ? { ...t, ...over[t.id] } : t) : tasks;
  const shown = tv.filter(t => matchView(t, view, { filters }) && !hidden.has(t.id));
  const sel = tv.find(t => t.id === selId);

  async function restore(t) {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body: { deleted: false } });
    reload('tasks');
  }
  async function hardDel(t) {
    if (!window.confirm(`永久刪除「${t.title}」？無法復原`)) return;
    await api(`/tasks/${t.id}?hard=1`, { method: 'DELETE' });
    reload('tasks');
  }
  async function emptyTrash() {
    if (!window.confirm('清空垃圾桶？所有項目將永久刪除')) return;
    await api('/trash', { method: 'DELETE' });
    reload('tasks');
  }
  // 拖曳排序（預設排序時才能拖）
  const [dragT, setDragT] = useState(null);
  async function dropOn(target, list) {
    if (!dragT || dragT.id === target.id) return;
    const ids = list.map(x => x.id).filter(id => id !== dragT.id);
    ids.splice(ids.indexOf(target.id), 0, dragT.id);
    setDragT(null);
    await api('/tasks/reorder', { method: 'POST', body: { ids } });
    reload('tasks');
  }

  // 底部小提示（可復原，防誤按）
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  function showToast(msg, undo) {
    clearTimeout(toastTimer.current);
    setToast({ msg, undo });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }
  async function toggle(t) {
    setHidden(h => new Set([...h, t.id]));   // 勾完成立即從當前列表消失
    api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: !t.completed } }).then(() => reload('tasks')).catch(() => reload('tasks'));
    if (!t.completed) showToast(`已完成「${t.title}」`, async () => {
      // 復原：要主動取消遮蔽，不然它會一直被當成「等伺服器確認完成」而不顯示
      setHidden(h => { const n = new Set(h); n.delete(t.id); return n; });
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: false } });
      reload('tasks');
    });
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
    reload('tasks');
  }
  // 儲存去抖動：不再每敲一個字就打 API＋全量重載（造成又慢又容易出錯）
  const saveTimer = useRef(null);
  const pendingSave = useRef(null);
  function flushSave() {
    const t = pendingSave.current;
    pendingSave.current = null;
    if (!t) return Promise.resolve();
    const { id, title, notes, due_date, due_time, priority, tags, subtasks, recurring, miss_policy, list_id } = t;
    return api(`/tasks/${id}`, { method: 'PATCH', body: { title, notes, due_date, due_time, priority, tags, subtasks, recurring, miss_policy, list_id } }).catch(() => {});
  }
  function save(t) {
    setOver(o => ({ ...o, [t.id]: t }));   // 先讓畫面反映
    pendingSave.current = t;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 400);
  }
  function closeDetail() {
    clearTimeout(saveTimer.current);
    setSelId(null);
    flushSave().then(() => reload('tasks'));   // 關閉時先送出未儲存的變更，再重新整理
  }
  async function del(t) {
    setHidden(h => new Set([...h, t.id]));   // 立刻消失
    setSelId(null);
    api(`/tasks/${t.id}`, { method: 'DELETE' }).then(() => reload('tasks')).catch(() => reload('tasks'));
    showToast(`已刪除「${t.title}」`, async () => {
      setHidden(h => { const n = new Set(h); n.delete(t.id); return n; });   // 同上，復原要取消遮蔽
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { deleted: false } });
      reload('tasks');
    });
  }

  // 願望清單：想做/要記得的事（無日期、無清單）
  const [wish, setWish] = useState('');
  const wishes = tv.filter(t => !t.list_id && !t.completed && !t.due_date && !t.deleted);
  async function addWish(e) {
    e.preventDefault();
    if (!wish.trim()) return;
    await api('/tasks', { method: 'POST', body: { title: wish.trim() } });
    setWish('');
    reload('tasks');
  }

  return (
    <>
      <div className="main">
        <div className="main-head">
          <h2>{title}</h2><span className="muted">{shown.length} 項</span>
          {!['trash', 'completed'].includes(view.type) && shown.length > 1 && (
            <select value={sortBy} onChange={e => pickSort(e.target.value)} style={{ marginLeft: 'auto', fontSize: 13 }}>
              <option value="default">預設排序</option>
              <option value="time">依時間</option>
              <option value="subject">依科目</option>
              <option value="subjectGroup">照科目分堆</option>
              <option value="priority">依優先級</option>
              <option value="title">依標題</option>
            </select>
          )}
          {view.type === 'trash' && shown.length > 0 && (
            <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={emptyTrash}>清空垃圾桶</button>
          )}
        </div>
        {!['completed', 'trash', 'search'].includes(view.type) && (
          <form className="quick-add" onSubmit={quickAdd}>
            <input placeholder="＋ 新增任務，按 Enter 儲存" value={quick} onChange={e => setQuick(e.target.value)} />
          </form>
        )}
        <div className="main-body">
          {topSlot}
          {view.type === 'today' && <MemoCard goMemo={goMemo} />}
          {view.type === 'trash'
            ? shown.map(t => (
              <div key={t.id} className="trow" style={{ cursor: 'default' }}>
                <span className="title" style={{ color: 'var(--muted)' }}>{t.title}</span>
                {t.due_date && <span className="muted">{t.due_date.slice(5)}</span>}
                <button className="btn sm ghost" onClick={() => restore(t)}>還原</button>
                <button className="icon-btn" title="永久刪除" onClick={() => hardDel(t)}>✕</button>
              </div>
            ))
            : (sortBy === 'subjectGroup' ? groupBySubject(shown) : groupTasks(shown, view.type)).map(([label, list]) => {
              const sorted = applySort(list);
              const canDrag = sortBy === 'default';
              return (
                <div className="tgroup" key={label}>
                  <div className="glabel">{label}</div>
                  {sorted.map(t => <TaskRow key={t.id} t={t} lists={lists} sel={t.id === selId} onSel={x => setSelId(x.id)} onToggle={toggle}
                    onDragStart={canDrag ? setDragT : undefined}
                    onDropOn={canDrag ? x => dropOn(x, sorted) : undefined}
                    onSwipeDelete={del} />)}
                </div>
              );
            })}
          {shown.length === 0 && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>沒有任務</div>}

          {view.type === 'today' && habits.length > 0 && (
            <div className="tgroup" style={{ marginTop: 24, borderTop: '2px dashed var(--border)', paddingTop: 12 }}>
              <div className="glabel">🌱 今日習慣</div>
              {habits.map(h => {
                const done = h.checkins.includes(today());
                // keep 政策：計算近 7 天（不含今天）漏打卡的天數
                const owed = h.miss_policy === 'keep'
                  ? [...Array(7)].map((_, i) => addDays(today(), -i - 1))
                    .filter(d => !h.checkins.includes(d)).length
                  : 0;
                return (
                  <div key={h.id} className={'todo' + (done ? ' done' : '')} style={{ marginTop: 6 }}>
                    <input type="checkbox" checked={done}
                      onChange={() => api(`/habits/${h.id}/checkin`, { method: 'POST', body: { date: today(), undo: done } }).then(reload)} />
                    <span>{h.icon}</span>
                    <span className="todo-title">{h.name}</span>
                    {owed > 0 && <span className="chip" style={{ color: 'var(--red)' }}>欠 {owed} 天，到習慣頁補卡</span>}
                    <span className="muted" style={{ marginLeft: 'auto' }}>🔥 {(() => { let s = 0, d = today(); if (!h.checkins.includes(d)) d = addDays(d, -1); while (h.checkins.includes(d)) { s++; d = addDays(d, -1); } return s; })()} 天</span>
                  </div>
                );
              })}
            </div>
          )}

          {view.type === 'today' && (
            <div className="tgroup" style={{ marginTop: 24, borderTop: '2px dashed var(--border)', paddingTop: 12 }}>
              <div className="glabel">💭 願望清單（想做、要記得的事）</div>
              {wishes.map(t => <TaskRow key={t.id} t={t} lists={lists} sel={t.id === selId} onSel={x => setSelId(x.id)} onToggle={toggle} onSwipeDelete={del} />)}
              <form onSubmit={addWish} style={{ marginTop: 6 }}>
                <input placeholder="＋ 記一件想做的事…" value={wish} onChange={e => setWish(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px dashed var(--border)' }} />
              </form>
            </div>
          )}

          {view.type === 'today' && <VocabCard goVocab={goVocab} />}
        </div>
        {view.type !== 'completed' && <button className="fab" onClick={() => setShowAdd(true)}>＋</button>}
      </div>
      {showAdd && <AddSheet view={view} lists={lists} onDone={() => { setShowAdd(false); reload(); }} onClose={() => setShowAdd(false)} />}
      {sel && <Detail key={sel.id} task={sel} lists={lists} onSave={save} onDelete={del} onClose={closeDetail} />}
      {toast && (
        <div className="toast">
          <span>{toast.msg}</span>
          <button onClick={() => { toast.undo(); setToast(null); }}>復原</button>
        </div>
      )}
    </>
  );
}
