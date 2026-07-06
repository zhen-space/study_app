import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';
import { parseICS } from './ics';

const LIST_COLORS = ['#4772fa', '#e03131', '#16a34a', '#f59f00', '#9333ea', '#0891b2'];
const TYPE_OPTIONS = ['範例', '例題', '單元練習', '歷屆試題'];
const WD = '日一二三四五六';

// 把多筆同名同時段的行程統整成一列
function groupEvents(list) {
  const map = {};
  for (const e of list) {
    const k = `${e.title}|${e.start_time}|${e.end_time}|${e.recurring || ''}`;
    (map[k] = map[k] || { ...e, ids: [], dates: [] });
    map[k].ids.push(e.id);
    map[k].dates.push(e.date);
  }
  return Object.values(map).map(g => {
    g.dates.sort();
    // 日期一律逐一列出，不用區間縮寫
    if (g.recurring) g.when = `每週${WD[new Date(g.dates[0] + 'T00:00:00').getDay()]}（${g.dates[0]} 起）`;
    else g.when = g.dates.map(d => `${+d.slice(5, 7)}/${+d.slice(8)}`).join('、');
    return g;
  });
}

export default function WizardView({ lists, reload, goTasks }) {
  const [step, setStep] = useState(0);
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [follow, setFollow] = useState(true);
  const [shift, setShift] = useState({ sleep_start: '', sleep_end: '' });
  const [evForm, setEvForm] = useState({ title: '', date: today(), start_time: '08:00', end_time: '09:00', recurring: '' });
  const [selEv, setSelEv] = useState({});           // 行程多選刪除
  const [items, setItems] = useState([]);           // 已勾選的章節項目
  const [rangeInput, setRangeInput] = useState({});
  const [tocs, setTocs] = useState([]);
  const [tocBusy, setTocBusy] = useState(null);
  const [tocMsg, setTocMsg] = useState({});
  const [expanded, setExpanded] = useState({});
  const [mode, setMode] = useState('spread');
  const [types, setTypes] = useState([]);            // 勾選的題型
  const [combine, setCombine] = useState('together'); // together | separate | custom
  const [typeGroup, setTypeGroup] = useState({});     // 自訂：題型→組別編號
  const [finals, setFinals] = useState({});           // 壓軸項目 key set
  const [bySubject, setBySubject] = useState(false);
  const [byGroup, setByGroup] = useState(false);
  const [dGlobal, setDGlobal] = useState({ start: today(), end: addDays(today(), 6) });
  const [dMap, setDMap] = useState({});               // `${sid}|${gi}` → {start,end}
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [aiPreview, setAiPreview] = useState(null);   // 統整後的匯入預覽群組
  const [aiBusy, setAiBusy] = useState(false);

  const loadEv = () => api('/events').then(setEvents);
  useEffect(() => {
    loadEv();
    api('/settings').then(s => { setSettings(s); setShift({ sleep_start: s.sleep_start, sleep_end: s.sleep_end }); });
    api('/import/toc').then(setTocs);
  }, []);

  const evGroups = useMemo(() => groupEvents(events), [events]);

  /* ---------- 題型組別 ---------- */
  const groups = useMemo(() => {
    if (!types.length) return [null]; // 不分題型
    if (combine === 'together') return [types];
    if (combine === 'separate') return types.map(t => [t]);
    const m = {};
    types.forEach(t => { const g = typeGroup[t] ?? 0; (m[g] = m[g] || []).push(t); });
    return Object.values(m);
  }, [types, combine, typeGroup]);
  const gLabel = g => g ? g.join('+') : '';

  const winOf = (sid, gi) => {
    const k = `${bySubject ? sid : 'all'}|${byGroup ? gi : 'all'}`;
    return dMap[k] || dGlobal;
  };

  /* ---------- 檔案 ---------- */
  const fileToB64 = async file => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(bin);
  };

  async function importAI(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setImportMsg('檔案太大（上限 15MB）'); return; }
    setAiBusy(true);
    setImportMsg('🤖 AI 解讀中，約需 30 秒～1 分鐘…');
    try {
      const { events: parsed } = await api('/import/parse', {
        method: 'POST',
        body: { filename: file.name, mime: file.type, data: await fileToB64(file) },
      });
      if (!parsed.length) { setImportMsg('AI 沒有在檔案中找到行程'); }
      else {
        // 統整同名同時段
        const map = {};
        parsed.forEach(ev => {
          const k = `${ev.title}|${ev.start_time}|${ev.end_time}|${ev.recurring || ''}`;
          (map[k] = map[k] || { ...ev, all: [], checked: true }).all.push(ev);
        });
        setAiPreview(Object.values(map).map(g => {
          const ds = g.all.map(x => x.date).sort();
          g.dates = ds;
          g.past = !g.recurring && ds[ds.length - 1] < today();
          g.when = g.recurring ? `每週${WD[new Date(ds[0] + 'T00:00:00').getDay()]}` :
            ds.map(d => `${+d.slice(5, 7)}/${+d.slice(8)}`).join('、');
          if (g.past) g.checked = false;
          return g;
        }));
        setImportMsg('');
      }
    } catch (err2) { setImportMsg(err2.message); }
    setAiBusy(false);
    e.target.value = '';
  }
  async function confirmAI() {
    const chosen = aiPreview.filter(g => g.checked);
    // 匯入前檢查：既有行程中與匯入日期相同的，詢問是否保留
    const importDates = new Set(chosen.flatMap(g => g.recurring ? [] : g.all.map(x => x.date)));
    const dup = events.filter(e => importDates.has(e.date));
    if (dup.length && !window.confirm(
      `已有 ${dup.length} 筆既有行程與這次匯入的日期相同。\n\n按「確定」＝保留舊行程一起顯示\n按「取消」＝刪除舊的、只留這次匯入的`)) {
      for (const e of dup) await api(`/events/${e.id}`, { method: 'DELETE' });
    }
    for (const g of chosen) for (const ev of g.all) {
      const { checked, all, when, dates, past, open, ...body } = ev;
      await api('/events', { method: 'POST', body });
    }
    setAiPreview(null);
    setImportMsg(`已加入 ${chosen.reduce((a, g) => a + g.all.length, 0)} 筆行程`);
    loadEv();
  }
  async function importICS(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportMsg('讀取中…');
    try {
      const parsed = parseICS(await file.text());
      const horizon = addDays(today(), 60);
      const wanted = parsed.filter(ev => ev.recurring || (ev.date >= today() && ev.date <= horizon));
      const existing = await api('/events');
      let n = 0;
      for (const ev of wanted.slice(0, 200)) {
        if (existing.some(x => x.title === ev.title && x.date === ev.date && x.start_time === ev.start_time)) continue;
        await api('/events', { method: 'POST', body: ev });
        n++;
      }
      setImportMsg(`匯入完成：新增 ${n} 筆行程`);
      loadEv();
    } catch { setImportMsg('讀取失敗，請確認是 .ics 行事曆檔'); }
    e.target.value = '';
  }
  async function addEvent(e) {
    e.preventDefault();
    if (!evForm.title.trim()) return;
    await api('/events', { method: 'POST', body: { ...evForm, recurring: evForm.recurring || null } });
    setEvForm(f => ({ ...f, title: '' }));
    loadEv();
  }
  async function deleteSelected() {
    const ids = evGroups.filter(g => selEv[g.ids[0]]).flatMap(g => g.ids);
    for (const id of ids) await api(`/events/${id}`, { method: 'DELETE' });
    setSelEv({});
    loadEv();
  }

  /* ---------- 科目章節 ---------- */
  async function addSubject() {
    const name = prompt('科目名稱（如：數學）：');
    if (!name?.trim()) return;
    await api('/lists', { method: 'POST', body: { name: name.trim(), color: LIST_COLORS[lists.length % LIST_COLORS.length] } });
    reload();
  }
  async function uploadTOC(l, e) {
    const file = e.target.files[0];
    if (!file) return;
    setTocBusy(l.id);
    setTocMsg(m => ({ ...m, [l.id]: '🤖 AI 解讀目錄中，約 30 秒～1 分鐘…' }));
    try {
      await api('/import/toc', { method: 'POST', body: { list_id: l.id, filename: file.name, mime: file.type, data: await fileToB64(file) } });
      setTocs(await api('/import/toc'));
      setItems(a => a.filter(x => x.subject_id !== l.id || !String(x.key).startsWith('toc-')));
      setTocMsg(m => ({ ...m, [l.id]: '' }));
    } catch (err2) { setTocMsg(m => ({ ...m, [l.id]: err2.message })); }
    setTocBusy(null);
    e.target.value = '';
  }
  const tocTitle = (c, secs) => c.title + (secs.length ? `（${secs.join('、')}）` : '');
  const findItem = c => items.find(x => x.key === `toc-${c.id}`);
  const mkItem = (l, c, secs = []) => ({ key: `toc-${c.id}`, subject_id: l.id, name: l.name, color: l.color, title: tocTitle(c, secs), minutes: 120, secs });

  function toggleChapter(l, c) {
    setItems(a => findItem(c) ? a.filter(x => x.key !== `toc-${c.id}`) : [...a, mkItem(l, c)]);
  }
  function toggleSection(l, c, s) {
    setItems(a => {
      const it = a.find(x => x.key === `toc-${c.id}`);
      if (!it) return [...a, mkItem(l, c, [s])];
      const secs = it.secs.includes(s) ? it.secs.filter(x => x !== s) : [...it.secs, s];
      return a.map(x => x.key === it.key ? { ...x, secs, title: tocTitle(c, secs) } : x);
    });
  }
  function selectAll(l, toc) {
    const allChecked = toc.every(c => findItem(c));
    setItems(a => {
      const rest = a.filter(x => !(x.subject_id === l.id && String(x.key).startsWith('toc-')));
      return allChecked ? rest : [...rest, ...toc.map(c => mkItem(l, c))];
    });
  }
  function addRange(l) {
    const title = (rangeInput[l.id] || '').trim();
    if (!title) return;
    setItems(it => [...it, { key: Date.now() + Math.random(), subject_id: l.id, name: l.name, color: l.color, title, minutes: 120, secs: [] }]);
    setRangeInput(r => ({ ...r, [l.id]: '' }));
  }

  /* ---------- 產生排程 ---------- */
  async function genPreview() {
    setErr('');
    const expanded2 = [];
    for (const it of items) {
      groups.forEach((g, gi) => {
        const w = winOf(it.subject_id, gi);
        expanded2.push({
          subject_id: it.subject_id,
          title: it.title + (g ? `｜${gLabel(g)}` : ''),
          minutes: it.minutes,
          start: w.start, end: w.end,
          final: !!finals[it.key],
        });
      });
    }
    try {
      const body = { items: expanded2, mode, startDate: dGlobal.start, endDate: dGlobal.end };
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

  const steps = ['行程與作息', '科目與範圍', '題型與偏好', '日期安排', '確認'];
  const dateInput = (k, label) => {
    const v = dMap[k] || dGlobal;
    return (
      <div className="row" key={k} style={{ marginTop: 6, marginLeft: 10 }}>
        <span className="muted" style={{ minWidth: 90 }}>{label}</span>
        <input type="date" value={v.start} onChange={e => setDMap(m => ({ ...m, [k]: { ...v, start: e.target.value } }))} />
        <span>–</span>
        <input type="date" value={v.end} onChange={e => setDMap(m => ({ ...m, [k]: { ...v, end: e.target.value } }))} />
      </div>
    );
  };

  const selCount = evGroups.filter(g => selEv[g.ids[0]]).length;

  return (
    <div className="main">
      <div className="main-head"><h2>🪄 排程精靈</h2></div>
      <div className="main-body">
        <div className="steps" style={{ marginTop: 8 }}>{steps.map((_, i) => <div key={i} className={'step-dot' + (i <= step ? ' on' : '')} />)}</div>
        <div className="muted" style={{ marginBottom: 10 }}>步驟 {step + 1}／5：{steps[step]}</div>

        {/* ============ 0 行程與作息 ============ */}
        {step === 0 && settings && (
          <div className="tile">
            <p>排程會自動避開<b>既定行程</b>與睡覺、吃飯時間。</p>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="btn sm ghost">📅 匯入 .ics<input type="file" accept=".ics,text/calendar" style={{ display: 'none' }} onChange={importICS} /></label>
              <label className="btn sm" style={{ opacity: aiBusy ? .6 : 1 }}>🤖 AI 匯入課表<input type="file" disabled={aiBusy} accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,image/*" style={{ display: 'none' }} onChange={importAI} /></label>
            </div>
            {importMsg && <div className="muted" style={{ marginTop: 6 }}>{importMsg}</div>}

            {aiPreview && (
              <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
                <b>AI 解讀結果（已統整，勾選要加入的）：</b>
                {aiPreview.map((g, i) => (
                  <div key={i} style={{ marginTop: 6 }}>
                    <div className="row">
                      <input type="checkbox" checked={g.checked} onChange={() => setAiPreview(p => p.map((x, j) => j === i ? { ...x, checked: !x.checked } : x))} />
                      <span><b>{g.title}</b></span>
                      <span className="muted" style={{ cursor: 'pointer' }} onClick={() => setAiPreview(p => p.map((x, j) => j === i ? { ...x, open: !x.open } : x))}>
                        {g.when} {g.start_time}–{g.end_time}{g.dates.length > 1 && !g.recurring ? (g.open ? ' ▾' : ' ▸') : ''}
                      </span>
                      {g.past && <span className="error" style={{ fontSize: 12 }}>⚠️ 過去日期</span>}
                    </div>
                    {g.open && <div className="muted" style={{ marginLeft: 28, fontSize: 12 }}>{g.dates.join('、')}</div>}
                  </div>
                ))}
                <div className="muted" style={{ marginTop: 6 }}>點日期文字可展開核對每一天；有誤就取消勾選、加入後也可回來多選刪除</div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn sm" onClick={confirmAI}>加入勾選的行程</button>
                  <button className="btn sm ghost" onClick={() => setAiPreview(null)}>取消</button>
                </div>
              </div>
            )}

            <form className="row" style={{ marginTop: 12 }} onSubmit={addEvent}>
              <input placeholder="手動新增行程" value={evForm.title} onChange={e => setEvForm(f => ({ ...f, title: e.target.value }))} style={{ flex: 1, minWidth: 120 }} />
              <input type="date" value={evForm.date} onChange={e => setEvForm(f => ({ ...f, date: e.target.value }))} />
              <input type="time" value={evForm.start_time} onChange={e => setEvForm(f => ({ ...f, start_time: e.target.value }))} />
              <input type="time" value={evForm.end_time} onChange={e => setEvForm(f => ({ ...f, end_time: e.target.value }))} />
              <select value={evForm.recurring} onChange={e => setEvForm(f => ({ ...f, recurring: e.target.value }))}>
                <option value="">單次</option><option value="weekly">每週</option>
              </select>
              <button className="btn sm">＋</button>
            </form>

            {/* 已統整的行程清單＋多選刪除 */}
            {evGroups.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="row">
                  <b>目前行程（{evGroups.length} 組）</b>
                  {selCount > 0 && <button className="btn sm danger" onClick={deleteSelected}>刪除選取（{selCount}）</button>}
                  <button className="btn sm ghost" onClick={() => {
                    const all = evGroups.every(g => selEv[g.ids[0]]);
                    setSelEv(all ? {} : Object.fromEntries(evGroups.map(g => [g.ids[0], true])));
                  }}>{evGroups.every(g => selEv[g.ids[0]]) ? '取消全選' : '全選'}</button>
                </div>
                {evGroups.map(g => (
                  <div key={g.ids[0]} className="row" style={{ marginTop: 6 }}>
                    <input type="checkbox" checked={!!selEv[g.ids[0]]} onChange={() => setSelEv(s => ({ ...s, [g.ids[0]]: !s[g.ids[0]] }))} />
                    <span><b>{g.title}</b></span>
                    <span className="muted" style={{ flex: 1 }}>{g.when} {g.start_time}–{g.end_time}</span>
                    <button className="icon-btn" onClick={async () => {
                      if (!window.confirm(`刪除「${g.title}」的 ${g.ids.length} 筆行程？`)) return;
                      for (const id of g.ids) await api(`/events/${id}`, { method: 'DELETE' });
                      loadEv();
                    }}>✕</button>
                  </div>
                ))}
              </div>
            )}

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

        {/* ============ 1 科目與範圍 ============ */}
        {step === 1 && (
          <div className="tile">
            <p className="muted">每科先「拍課本目錄」建立章節，之後直接勾選（節可勾可不勾）。</p>
            <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={addSubject}>＋新增科目</button>
            {lists.map(l => {
              const toc = tocs.filter(t => t.list_id === l.id);
              const allSel = toc.length > 0 && toc.every(c => findItem(c));
              return (
                <div key={l.id} style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <div className="row">
                    <span className="tag" style={{ background: l.color, color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>{l.name}</span>
                    <label className="btn sm ghost" style={{ opacity: tocBusy === l.id ? .5 : 1 }}>
                      📷 {toc.length ? '重拍目錄' : '拍課本目錄'}
                      <input type="file" disabled={tocBusy !== null} accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => uploadTOC(l, e)} />
                    </label>
                    {toc.length > 0 && <button className="btn sm ghost" onClick={() => selectAll(l, toc)}>{allSel ? '全不選' : '全選'}</button>}
                  </div>
                  {tocMsg[l.id] && <div className="muted" style={{ marginTop: 4 }}>{tocMsg[l.id]}</div>}
                  {toc.map(c => {
                    const it = findItem(c);
                    return (
                      <div key={c.id} style={{ marginTop: 6, marginLeft: 4 }}>
                        <div className="row">
                          <input type="checkbox" checked={!!it} onChange={() => toggleChapter(l, c)} />
                          <span style={{ flex: 1 }} onClick={() => c.sections.length && setExpanded(x => ({ ...x, [c.id]: !x[c.id] }))}>
                            {c.title}{c.sections.length > 0 && <span className="muted"> {expanded[c.id] ? '▾' : '▸'}</span>}
                          </span>
                          {it && <>
                            <input type="number" min="30" step="30" value={it.minutes} style={{ width: 70 }}
                              onChange={e => setItems(a => a.map(x => x.key === it.key ? { ...x, minutes: +e.target.value } : x))} />
                            <span className="muted">分</span>
                          </>}
                        </div>
                        {expanded[c.id] && c.sections.map(s => (
                          <label key={s} className="row" style={{ marginLeft: 26, marginTop: 3, fontSize: 14 }}>
                            <input type="checkbox" checked={!!it?.secs?.includes(s)} onChange={() => toggleSection(l, c, s)} />
                            <span className="muted">{s}</span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                  <div className="row" style={{ marginTop: 8 }}>
                    <input placeholder="或手動輸入範圍（如：講義 p.20-35）" value={rangeInput[l.id] || ''} onChange={e => setRangeInput(r => ({ ...r, [l.id]: e.target.value }))} style={{ flex: 1, fontSize: 14 }} />
                    <button className="btn sm ghost" onClick={() => addRange(l)}>＋</button>
                  </div>
                  {items.filter(it => it.subject_id === l.id && !String(it.key).startsWith('toc-')).map(it => (
                    <div key={it.key} className="row" style={{ marginTop: 6, marginLeft: 10 }}>
                      <span>• {it.title}</span>
                      <input type="number" min="30" step="30" value={it.minutes} style={{ width: 70 }}
                        onChange={e => setItems(a => a.map(x => x.key === it.key ? { ...x, minutes: +e.target.value } : x))} />
                      <span className="muted">分</span>
                      <button className="icon-btn" onClick={() => setItems(a => a.filter(x => x.key !== it.key))}>✕</button>
                    </div>
                  ))}
                </div>
              );
            })}
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn ghost" onClick={() => setStep(0)}>上一步</button>
              <button className="btn" disabled={!items.length} onClick={() => setStep(2)}>下一步（已選 {items.length} 項）</button>
            </div>
          </div>
        )}

        {/* ============ 2 題型與偏好 ============ */}
        {step === 2 && (
          <div className="tile">
            <b>分配方式</b>
            <div className="row" style={{ marginTop: 6 }}>
              <label><input type="radio" checked={mode === 'order'} onChange={() => setMode('order')} /> 按科目順序讀</label>
              <label><input type="radio" checked={mode === 'spread'} onChange={() => setMode('spread')} /> 打散平均分配</label>
            </div>

            <b style={{ display: 'block', marginTop: 16 }}>你的教材有哪些題型？（沒有就不勾）</b>
            <div className="row" style={{ marginTop: 6 }}>
              {TYPE_OPTIONS.map(t => (
                <label key={t} className={'tag-pill' + (types.includes(t) ? ' on' : '')} style={{ cursor: 'pointer' }}
                  onClick={() => setTypes(ts => ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t])}>{t}</label>
              ))}
            </div>

            {types.length > 1 && (
              <div style={{ marginTop: 12 }}>
                <b>這些題型要怎麼寫？</b>
                <label style={{ display: 'block', marginTop: 4 }}><input type="radio" checked={combine === 'together'} onChange={() => setCombine('together')} /> 一起寫（每章一個時段做完所有題型）</label>
                <label style={{ display: 'block' }}><input type="radio" checked={combine === 'separate'} onChange={() => setCombine('separate')} /> 全部打散（每種題型分開時段）</label>
                <label style={{ display: 'block' }}><input type="radio" checked={combine === 'custom'} onChange={() => setCombine('custom')} /> 自訂組合（例如：範例+例題一組、單元練習+歷屆一組）</label>
                {combine === 'custom' && types.map(t => (
                  <div className="row" key={t} style={{ marginTop: 4, marginLeft: 10 }}>
                    <span style={{ minWidth: 70 }}>{t}</span>
                    <select value={typeGroup[t] ?? 0} onChange={e => setTypeGroup(g => ({ ...g, [t]: +e.target.value }))}>
                      {[0, 1, 2, 3].map(n => <option key={n} value={n}>第 {n + 1} 組</option>)}
                    </select>
                  </div>
                ))}
                {groups[0] && <div className="muted" style={{ marginTop: 6 }}>→ 每個章節會拆成 {groups.length} 段：{groups.map(gLabel).join('｜')}（每段套用該章的分鐘數）</div>}
              </div>
            )}

            <b style={{ display: 'block', marginTop: 16 }}>有沒有要「壓軸」的範圍？（例如：學測模擬試題、115 學測試題——會排在其他全部讀完之後）</b>
            {items.map(it => (
              <label key={it.key} className="row" style={{ marginTop: 4 }}>
                <input type="checkbox" checked={!!finals[it.key]} onChange={() => setFinals(f => ({ ...f, [it.key]: !f[it.key] }))} />
                <span style={{ color: it.color }}>■</span><span>{it.name}｜{it.title}</span>
              </label>
            ))}

            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn ghost" onClick={() => setStep(1)}>上一步</button>
              <button className="btn" onClick={() => setStep(3)}>下一步</button>
            </div>
          </div>
        )}

        {/* ============ 3 日期安排 ============ */}
        {step === 3 && (
          <div className="tile">
            <div className="row">
              <label>整體範圍：</label>
              <input type="date" value={dGlobal.start} onChange={e => setDGlobal(d => ({ ...d, start: e.target.value }))} />
              <span>–</span>
              <input type="date" value={dGlobal.end} onChange={e => setDGlobal(d => ({ ...d, end: e.target.value }))} />
            </div>
            <label style={{ display: 'block', marginTop: 12 }}>
              <input type="checkbox" checked={bySubject} onChange={e => setBySubject(e.target.checked)} /> 各科目用不同日期範圍
            </label>
            {groups.length > 1 && (
              <label style={{ display: 'block', marginTop: 4 }}>
                <input type="checkbox" checked={byGroup} onChange={e => setByGroup(e.target.checked)} /> 各題型組用不同日期範圍
              </label>
            )}
            {(bySubject || byGroup) && (
              <div style={{ marginTop: 10 }}>
                {(bySubject ? [...new Set(items.map(i => i.subject_id))] : ['all']).map(sid => {
                  const sname = sid === 'all' ? '' : lists.find(l => l.id === sid)?.name || '';
                  return (byGroup ? groups.map((g, gi) => dateInput(`${bySubject ? sid : 'all'}|${gi}`, `${sname}${sname && g ? '・' : ''}${gLabel(g) || (byGroup ? `第${gi + 1}組` : '')}`))
                    : [dateInput(`${sid}|all`, sname || '全部')]);
                })}
                <div className="muted" style={{ marginTop: 6 }}>沒填的會用整體範圍</div>
              </div>
            )}
            {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setStep(2)}>上一步</button>
              <button className="btn" onClick={genPreview}>產生排程</button>
            </div>
          </div>
        )}

        {/* ============ 4 確認 ============ */}
        {step === 4 && preview && (
          <div className="tile">
            {preview.unplaced && <div className="error">{preview.message}</div>}
            {Object.entries(preview.blocks.reduce((a, b) => { (a[b.date] = a[b.date] || []).push(b); return a; }, {})).map(([d, list]) => (
              <div key={d} style={{ marginBottom: 10 }}>
                <b>{d}（週{WD[new Date(d + 'T00:00:00').getDay()]}）</b>
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
              <button className="btn" disabled={saving} onClick={confirm}>{saving ? '建立中…' : `滿意，加入待辦（${preview.blocks.length} 段）！`}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
