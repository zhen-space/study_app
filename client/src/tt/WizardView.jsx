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
  const [subjSpread, setSubjSpread] = useState({});   // 每科：章節打散(spread)或照順序(order)
  const [typeScope, setTypeScope] = useState('all');  // 題型設定：all=所有科目相同 / per=分科
  const [types, setTypes] = useState([]);             // 全域題型
  const [combine, setCombine] = useState('together');
  const [typeGroup, setTypeGroup] = useState({});
  const [typesBy, setTypesBy] = useState({});         // 分科題型 sid→types[]
  const [combineBy, setCombineBy] = useState({});
  const [typeGroupBy, setTypeGroupBy] = useState({});
  const [finals, setFinals] = useState({});           // 壓軸項目
  const [firstsSel, setFirstsSel] = useState({});     // 要先完成的項目
  const [exWd, setExWd] = useState([]);               // 不排的星期 0-6
  const [exDates, setExDates] = useState([]);         // 不排的日期
  const [exDateInput, setExDateInput] = useState(today());
  const [levelMin, setLevelMin] = useState({});       // 使用者固定的各層級時數
  const [busyHours, setBusyHours] = useState(0);      // 既定行程超過幾小時就不排（0=不限）
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
    // AI 解讀結果自動保存：離開頁面回來還在
    try { const saved = localStorage.getItem('wizardAiPreview'); if (saved) setAiPreview(JSON.parse(saved)); } catch {}
  }, []);
  useEffect(() => {
    try {
      if (aiPreview) localStorage.setItem('wizardAiPreview', JSON.stringify(aiPreview));
      else localStorage.removeItem('wizardAiPreview');
    } catch {}
  }, [aiPreview]);

  const evGroups = useMemo(() => groupEvents(events), [events]);

  /* ---------- 題型組別（可全域或分科） ---------- */
  const calcGroups = (ts, cb, tg) => {
    if (!ts.length) return [null];
    if (cb === 'together') return [ts];
    if (cb === 'separate') return ts.map(t => [t]);
    const m = {};
    ts.forEach(t => { const g = tg[t] ?? 0; (m[g] = m[g] || []).push(t); });
    return Object.values(m);
  };
  const groupsFor = sid => typeScope === 'all'
    ? calcGroups(types, combine, typeGroup)
    : calcGroups(typesBy[sid] || [], combineBy[sid] || 'together', typeGroupBy[sid] || {});
  const groups = useMemo(() => calcGroups(types, combine, typeGroup), [types, combine, typeGroup]);
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
  // append=true 表示追加（不清掉既有章節，接在後面）
  async function uploadTOC(l, e, append = false) {
    const fileList = [...e.target.files];
    if (!fileList.length) return;
    if (fileList.length > 12) { setTocMsg(m => ({ ...m, [l.id]: '一次最多 12 張照片' })); e.target.value = ''; return; }
    setTocBusy(l.id);
    setTocMsg(m => ({ ...m, [l.id]: `🤖 AI 解讀 ${fileList.length} 張目錄中，約 30 秒～1 分鐘…` }));
    try {
      const files = [];
      for (const f of fileList) files.push({ filename: f.name, mime: f.type, data: await fileToB64(f) });
      await api('/import/toc', { method: 'POST', body: { list_id: l.id, files, replace: !append } });
      setTocs(await api('/import/toc'));
      if (!append) setItems(a => a.filter(x => x.subject_id !== l.id || !String(x.key).startsWith('toc-')));
      setTocMsg(m => ({ ...m, [l.id]: '' }));
    } catch (err2) { setTocMsg(m => ({ ...m, [l.id]: err2.message })); }
    setTocBusy(null);
    e.target.value = '';
  }
  // 依單位大小的預設時數（大單位＝多時間），可被使用者固定覆寫
  const LEVEL_MIN = { 章: 120, 課: 120, 單元: 120, 節: 60, 小節: 60, 主題: 30, 重點: 30, 節次: 60 };
  const minutesFor = (level, depth) => levelMin[level] ?? LEVEL_MIN[level] ?? ([120, 60, 30][depth] ?? 60);

  // 使用者改某項時數 → 選擇是否固定該層級（套用到所有同層級項目、以後也用這個）
  function changeMinutes(it, val) {
    setItems(a => a.map(x => x.key === it.key ? { ...x, minutes: val } : x));
    if (window.confirm(`要把所有「${it.level}」都固定成 ${val} 分鐘嗎？\n（確定＝全部套用並記住，取消＝只改這一項）`)) {
      setLevelMin(m => ({ ...m, [it.level]: val }));
      setItems(a => a.map(x => x.level === it.level ? { ...x, minutes: val } : x));
    }
  }

  // 把一列 toc（章）正規化成樹：舊資料的 sections 是字串陣列，新資料是物件樹
  const normKids = kids => (kids || []).map(k =>
    typeof k === 'string' ? { title: k, level: '節', children: [] }
      : { title: k.title, level: k.level || '節', children: normKids(k.children) });
  const chapterNode = row => ({ key: `toc-${row.id}`, title: row.title, level: row.level || '章', children: normKids(row.sections), depth: 0 });

  const isAncestor = (a, b) => b.startsWith(a + '.');
  const findItem = key => items.find(x => x.key === key);

  function toggleNode(l, key, title, level, depth) {
    setItems(a => {
      if (a.find(x => x.key === key)) return a.filter(x => x.key !== key);
      // 出現更小單位，較大的單位就不要：移除同支的祖先與後代
      const cleaned = a.filter(x => !(x.key === key || isAncestor(x.key, key) || isAncestor(key, x.key)));
      return [...cleaned, { key, subject_id: l.id, name: l.name, color: l.color, title, minutes: minutesFor(level, depth), level }];
    });
  }
  function selectAllChapters(l, rows) {
    const nodes = rows.map(chapterNode);
    const allChecked = nodes.every(n => findItem(n.key));
    setItems(a => {
      const rest = a.filter(x => !(x.subject_id === l.id && String(x.key).startsWith('toc-')));
      return allChecked ? rest : [...rest,
        ...nodes.map(n => ({ key: n.key, subject_id: l.id, name: l.name, color: l.color, title: n.title, minutes: minutesFor(n.level, 0), level: n.level }))];
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
      groupsFor(it.subject_id).forEach((g, gi) => {
        const w = winOf(it.subject_id, gi);
        expanded2.push({
          subject_id: it.subject_id,
          title: it.title + (g ? `｜${gLabel(g)}` : ''),
          minutes: it.minutes,
          start: w.start, end: w.end,
          final: !!finals[it.key],
          first: !!firstsSel[it.key],
          spread: (subjSpread[it.subject_id] ?? 'spread') === 'spread',
        });
      });
    }
    try {
      const body = {
        items: expanded2, startDate: dGlobal.start, endDate: dGlobal.end,
        excludeWeekdays: exWd, excludeDates: exDates, skipIfBusyHours: busyHours,
      };
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
                {aiPreview.map((g, i) => {
                  const upd = fn => setAiPreview(p => p.map((x, j) => j === i ? fn({ ...x }) : x));
                  return (
                    <div key={i} style={{ marginTop: 8, borderBottom: '1px dashed var(--border)', paddingBottom: 6 }}>
                      <div className="row">
                        <input type="checkbox" checked={g.checked} onChange={() => upd(x => ({ ...x, checked: !x.checked }))} />
                        <input value={g.title} style={{ fontWeight: 700, width: 110, padding: '4px 6px' }}
                          onChange={e => upd(x => ({ ...x, title: e.target.value, all: x.all.map(ev => ({ ...ev, title: e.target.value })) }))} />
                        <input type="time" value={g.start_time} style={{ padding: '4px 4px' }}
                          onChange={e => upd(x => ({ ...x, start_time: e.target.value, all: x.all.map(ev => ({ ...ev, start_time: e.target.value })) }))} />
                        <span>–</span>
                        <input type="time" value={g.end_time} style={{ padding: '4px 4px' }}
                          onChange={e => upd(x => ({ ...x, end_time: e.target.value, all: x.all.map(ev => ({ ...ev, end_time: e.target.value })) }))} />
                        {g.past && <span className="error" style={{ fontSize: 12 }}>⚠️ 過去</span>}
                      </div>
                      <div className="row" style={{ marginTop: 4, marginLeft: 24, flexWrap: 'wrap', gap: 6 }}>
                        {g.recurring
                          ? <span className="muted">{g.when}</span>
                          : <>
                            {g.dates.map((d, di) => (
                              <span key={di} className="row" style={{ gap: 2 }}>
                                <input type="date" value={d} style={{ padding: '3px 4px', fontSize: 13 }}
                                  onChange={e => {
                                    const nd = e.target.value;
                                    if (!nd) return;
                                    upd(x => ({
                                      ...x,
                                      dates: x.dates.map((y, j) => j === di ? nd : y),
                                      all: x.all.map(ev => ev.date === d ? { ...ev, date: nd } : ev),
                                    }));
                                  }} />
                                <button className="icon-btn" title="移除這天" onClick={() => upd(x => {
                                  const dates = x.dates.filter((_, j) => j !== di);
                                  return { ...x, dates, all: x.all.filter(ev => ev.date !== d), checked: dates.length ? x.checked : false };
                                })}>✕</button>
                              </span>
                            ))}
                            <button className="btn sm ghost" onClick={() => upd(x => {
                              const last = x.dates[x.dates.length - 1] || today();
                              const nd = addDays(last, 1);
                              const tpl = x.all[0] || { title: x.title, start_time: x.start_time, end_time: x.end_time, recurring: null };
                              return { ...x, dates: [...x.dates, nd], all: [...x.all, { ...tpl, date: nd }], checked: true };
                            })}>＋加一天</button>
                          </>}
                      </div>
                    </div>
                  );
                })}
                <div className="muted" style={{ marginTop: 6 }}>名稱和時間可直接改；點日期籤可移除那一天。結果會自動保存，離開再回來還在</div>
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
              const rows = tocs.filter(t => t.list_id === l.id);
              const nodes = rows.map(chapterNode);
              const allSel = nodes.length > 0 && nodes.every(n => findItem(n.key));

              const renderNode = (n) => {
                const it = findItem(n.key);
                const hasKids = n.children && n.children.length > 0;
                const open = expanded[n.key];
                return (
                  <div key={n.key} style={{ marginTop: 5, marginLeft: n.depth * 20 }}>
                    <div className="row">
                      <input type="checkbox" checked={!!it} onChange={() => toggleNode(l, n.key, n.title, n.level, n.depth)} />
                      <span style={{ flex: 1, fontSize: n.depth === 0 ? 15 : 14, fontWeight: n.depth === 0 ? 600 : 400 }}
                        onClick={() => hasKids && setExpanded(x => ({ ...x, [n.key]: !x[n.key] }))}>
                        {n.title}
                        {hasKids && <span className="muted"> {open ? '▾' : '▸'}</span>}
                        {n.depth > 0 && <span className="chip" style={{ marginLeft: 6 }}>{n.level}</span>}
                      </span>
                      {it && <>
                        <input type="number" min="10" step="10" value={it.minutes} style={{ width: 66 }}
                          onChange={e => setItems(a => a.map(x => x.key === it.key ? { ...x, minutes: +e.target.value || 0 } : x))}
                          onBlur={e => { const v = +e.target.value; if (v && v !== (levelMin[it.level] ?? null)) changeMinutes(it, v); }} />
                        <span className="muted">分</span>
                      </>}
                    </div>
                    {open && hasKids && n.children.map((c, i) =>
                      renderNode({ key: `${n.key}.${i}`, title: c.title, level: c.level, children: c.children, depth: n.depth + 1 }))}
                  </div>
                );
              };

              return (
                <div key={l.id} style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <div className="row">
                    <span className="tag" style={{ background: l.color, color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>{l.name}</span>
                    <label className="btn sm ghost" style={{ opacity: tocBusy === l.id ? .5 : 1 }}>
                      📷 {rows.length ? '重拍目錄' : '拍課本目錄（可多張）'}
                      <input type="file" multiple disabled={tocBusy !== null} accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => uploadTOC(l, e)} />
                    </label>
                    {rows.length > 0 && (
                      <label className="btn sm ghost" style={{ opacity: tocBusy === l.id ? .5 : 1 }}>
                        ➕ 追加照片
                        <input type="file" multiple disabled={tocBusy !== null} accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => uploadTOC(l, e, true)} />
                      </label>
                    )}
                    {rows.length > 0 && <button className="btn sm ghost" onClick={() => selectAllChapters(l, rows)}>{allSel ? '全不選' : '全選（整章）'}</button>}
                  </div>
                  {rows.length > 0 && <div className="muted" style={{ marginTop: 4 }}>點名稱展開更小單位，可勾章／節／主題任一層（勾小的會取代大的）。改時數會問要不要固定整個層級。目錄不完整可用「追加照片」補後面幾頁</div>}
                  {tocMsg[l.id] && <div className="muted" style={{ marginTop: 4 }}>{tocMsg[l.id]}</div>}
                  {nodes.map(renderNode)}
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
        {step === 2 && (() => {
          const sids = [...new Set(items.map(i => i.subject_id))];
          const sname = sid => lists.find(l => l.id === sid)?.name || '';
          const TypePanel = ({ ts, cb, tg, onTs, onCb, onTg }) => (
            <div>
              <div className="row" style={{ marginTop: 6 }}>
                {TYPE_OPTIONS.map(t => (
                  <label key={t} className={'tag-pill' + (ts.includes(t) ? ' on' : '')} style={{ cursor: 'pointer' }}
                    onClick={() => onTs(ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t])}>{t}</label>
                ))}
              </div>
              {ts.length > 1 && (
                <div style={{ marginTop: 8 }}>
                  <label style={{ display: 'block' }}><input type="radio" checked={cb === 'together'} onChange={() => onCb('together')} /> 一起寫（每章一個時段做完所有題型）</label>
                  <label style={{ display: 'block' }}><input type="radio" checked={cb === 'separate'} onChange={() => onCb('separate')} /> 全部分開（每種題型自己一段）</label>
                  <label style={{ display: 'block' }}><input type="radio" checked={cb === 'custom'} onChange={() => onCb('custom')} /> 自訂組合（如：範例+例題一組）</label>
                  {cb === 'custom' && ts.map(t => (
                    <div className="row" key={t} style={{ marginTop: 4, marginLeft: 10 }}>
                      <span style={{ minWidth: 70 }}>{t}</span>
                      <select value={tg[t] ?? 0} onChange={e => onTg({ ...tg, [t]: +e.target.value })}>
                        {[0, 1, 2, 3].map(n => <option key={n} value={n}>第 {n + 1} 組</option>)}
                      </select>
                    </div>
                  ))}
                  <div className="muted" style={{ marginTop: 4 }}>→ 拆成 {calcGroups(ts, cb, tg).length} 段：{calcGroups(ts, cb, tg).map(gLabel).join('｜')}</div>
                </div>
              )}
            </div>
          );
          return (
            <div className="tile">
              <b>各科的章節要打散還是照順序？</b>
              {sids.map(sid => (
                <div className="row" key={sid} style={{ marginTop: 6 }}>
                  <span className="tag" style={{ background: lists.find(l => l.id === sid)?.color, color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>{sname(sid)}</span>
                  <label><input type="radio" checked={(subjSpread[sid] ?? 'spread') === 'spread'} onChange={() => setSubjSpread(s => ({ ...s, [sid]: 'spread' }))} /> 打散平均</label>
                  <label><input type="radio" checked={subjSpread[sid] === 'order'} onChange={() => setSubjSpread(s => ({ ...s, [sid]: 'order' }))} /> 照章節順序</label>
                </div>
              ))}

              <b style={{ display: 'block', marginTop: 16 }}>教材題型（範例/例題/單元練習/歷屆試題）</b>
              <div className="row" style={{ marginTop: 6 }}>
                <label><input type="radio" checked={typeScope === 'all'} onChange={() => setTypeScope('all')} /> 所有科目都一樣</label>
                <label><input type="radio" checked={typeScope === 'per'} onChange={() => setTypeScope('per')} /> 各科分別設定</label>
              </div>
              {typeScope === 'all'
                ? <TypePanel ts={types} cb={combine} tg={typeGroup} onTs={setTypes} onCb={setCombine} onTg={setTypeGroup} />
                : sids.map(sid => (
                  <div key={sid} style={{ marginTop: 10, borderLeft: `3px solid ${lists.find(l => l.id === sid)?.color}`, paddingLeft: 8 }}>
                    <b>{sname(sid)}</b>
                    <TypePanel ts={typesBy[sid] || []} cb={combineBy[sid] || 'together'} tg={typeGroupBy[sid] || {}}
                      onTs={v => setTypesBy(s => ({ ...s, [sid]: v }))}
                      onCb={v => setCombineBy(s => ({ ...s, [sid]: v }))}
                      onTg={v => setTypeGroupBy(s => ({ ...s, [sid]: v }))} />
                  </div>
                ))}

              <b style={{ display: 'block', marginTop: 16 }}>有沒有章節需要「先完成」或「壓軸」？</b>
              <div className="muted">先完成＝最先排；壓軸＝其他全部讀完才排（如：學測模擬試題、115 學測試題）</div>
              {items.map(it => (
                <div key={it.key} className="row" style={{ marginTop: 4 }}>
                  <span style={{ color: it.color }}>■</span>
                  <span style={{ flex: 1 }}>{it.name}｜{it.title}</span>
                  <label className={'tag-pill' + (firstsSel[it.key] ? ' on' : '')} style={{ cursor: 'pointer' }}
                    onClick={() => { setFirstsSel(f => ({ ...f, [it.key]: !f[it.key] })); setFinals(f => ({ ...f, [it.key]: false })); }}>先完成</label>
                  <label className={'tag-pill' + (finals[it.key] ? ' on' : '')} style={{ cursor: 'pointer' }}
                    onClick={() => { setFinals(f => ({ ...f, [it.key]: !f[it.key] })); setFirstsSel(f => ({ ...f, [it.key]: false })); }}>壓軸</label>
                </div>
              ))}

              <div className="row" style={{ marginTop: 16 }}>
                <button className="btn ghost" onClick={() => setStep(1)}>上一步</button>
                <button className="btn" onClick={() => setStep(3)}>下一步</button>
              </div>
            </div>
          );
        })()}

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
            {(typeScope === 'per' ? bySubject : groups.length > 1) && (
              <label style={{ display: 'block', marginTop: 4 }}>
                <input type="checkbox" checked={byGroup} onChange={e => setByGroup(e.target.checked)} /> 各題型組用不同日期範圍
              </label>
            )}
            {(bySubject || byGroup) && (
              <div style={{ marginTop: 10 }}>
                {(bySubject ? [...new Set(items.map(i => i.subject_id))] : ['all']).map(sid => {
                  const sname = sid === 'all' ? '' : lists.find(l => l.id === sid)?.name || '';
                  const gs = sid === 'all' ? groups : groupsFor(sid);
                  return (byGroup ? gs.map((g, gi) => dateInput(`${bySubject ? sid : 'all'}|${gi}`, `${sname}${sname && g ? '・' : ''}${gLabel(g) || `第${gi + 1}組`}`))
                    : [dateInput(`${sid}|all`, sname || '全部')]);
                })}
                <div className="muted" style={{ marginTop: 6 }}>沒填的會用整體範圍</div>
              </div>
            )}

            <b style={{ display: 'block', marginTop: 14 }}>有沒有不想排讀書的日子？</b>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="muted">星期：</span>
              {[1, 2, 3, 4, 5, 6, 0].map(d => (
                <span key={d} className={'tag-pill' + (exWd.includes(d) ? ' on' : '')} style={{ cursor: 'pointer' }}
                  onClick={() => setExWd(w => w.includes(d) ? w.filter(x => x !== d) : [...w, d])}>{WD[d]}</span>
              ))}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="muted">日期：</span>
              <input type="date" value={exDateInput} onChange={e => setExDateInput(e.target.value)} />
              <button className="btn sm ghost" onClick={() => exDateInput && !exDates.includes(exDateInput) && setExDates(x => [...x, exDateInput].sort())}>＋不排這天</button>
            </div>
            {exDates.length > 0 && (
              <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                {exDates.map(d => (
                  <span key={d} className="tag-pill on" style={{ cursor: 'pointer' }} onClick={() => setExDates(x => x.filter(y => y !== d))}>
                    {`${+d.slice(5, 7)}/${+d.slice(8)}`} ✕
                  </span>
                ))}
              </div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted">當天既定行程（上課、補習等）超過</span>
              <input type="number" min="0" max="24" value={busyHours} style={{ width: 60 }} onChange={e => setBusyHours(+e.target.value || 0)} />
              <span className="muted">小時，就不排讀書（填 0＝不限制）</span>
            </div>
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
