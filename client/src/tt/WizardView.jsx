import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [evForm, setEvForm] = useState({ title: '', date: today(), start_time: '08:00', end_time: '09:00', recurring: '', location: '' });
  const [selEv, setSelEv] = useState({});           // 行程多選刪除
  const [items, setItems] = useState([]);           // 已勾選的章節項目
  const [rangeInput, setRangeInput] = useState({});
  const [tocs, setTocs] = useState([]);
  const [tocBusy, setTocBusy] = useState(null);
  const [tocMsg, setTocMsg] = useState({});
  const [expanded, setExpanded] = useState({});
  const [subjSpread, setSubjSpread] = useState({});   // 每科：章節打散(spread)或照順序(order)
  const [typeRef, setTypeRef] = useState({});         // 每科題型：'self'或跟哪個 sid 相同
  const [typesBy, setTypesBy] = useState({});         // 分科題型 sid→types[]
  const [combineBy, setCombineBy] = useState({});
  const [typeGroupBy, setTypeGroupBy] = useState({});
  const [finals, setFinals] = useState({});           // 壓軸項目
  const [firstsSel, setFirstsSel] = useState({});     // 要先完成的項目
  const [plainSel, setPlainSel] = useState({});       // 純題目：不套題型、照順序（如模考）
  const [exWd, setExWd] = useState([]);               // 不排的星期 0-6
  const [exDates, setExDates] = useState([]);         // 不排的日期
  const [exDateInput, setExDateInput] = useState(today());
  const [levelMin, setLevelMin] = useState({});       // 使用者固定的各層級時數
  const [busyHours, setBusyHours] = useState(0);      // 既定行程超過幾小時就不排（0=不限）
  const [timed, setTimed] = useState(true);           // 是否計算時間
  const [limitPerDay, setLimitPerDay] = useState(false); // 不計時模式是否限制每天數量
  const [perDay, setPerDay] = useState(3);            // 每天幾項
  const [pace, setPace] = useState('even');           // even=平均分配 front=盡早排完（前面多排）
  const [groupSize, setGroupSize] = useState({});     // 每科：把連續 N 個單位綁成一組（0/1=不綁）
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

  /* ---------- 精靈草稿自動記憶：勾選、範圍、日期、排法等全部設定 ---------- */
  const draftLoaded = useRef(false);
  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem('wizardDraft') || 'null');
      if (d) {
        d.items && setItems(d.items);
        d.subjSpread && setSubjSpread(d.subjSpread);
        d.typeRef && setTypeRef(d.typeRef);
        d.typesBy && setTypesBy(d.typesBy);
        d.combineBy && setCombineBy(d.combineBy);
        d.typeGroupBy && setTypeGroupBy(d.typeGroupBy);
        d.finals && setFinals(d.finals);
        d.firstsSel && setFirstsSel(d.firstsSel);
        d.plainSel && setPlainSel(d.plainSel);
        d.exWd && setExWd(d.exWd);
        d.exDates && setExDates(d.exDates);
        d.levelMin && setLevelMin(d.levelMin);
        d.busyHours != null && setBusyHours(d.busyHours);
        d.timed != null && setTimed(d.timed);
        d.limitPerDay != null && setLimitPerDay(d.limitPerDay);
        d.perDay != null && setPerDay(d.perDay);
        d.pace && setPace(d.pace);
        d.groupSize && setGroupSize(d.groupSize);
        d.bySubject != null && setBySubject(d.bySubject);
        d.byGroup != null && setByGroup(d.byGroup);
        d.dGlobal && d.dGlobal.end >= today() && setDGlobal(d.dGlobal); // 過期的整體範圍不還原
        d.dMap && setDMap(d.dMap);
        d.step != null && setStep(Math.min(d.step, 3)); // 確認頁需重新產生預覽，最多回到日期步
      }
    } catch {}
    draftLoaded.current = true;
  }, []);
  useEffect(() => {
    if (!draftLoaded.current) return;
    try {
      localStorage.setItem('wizardDraft', JSON.stringify({
        items, subjSpread, typeRef, typesBy, combineBy, typeGroupBy, finals, firstsSel, plainSel,
        exWd, exDates, levelMin, busyHours, timed, limitPerDay, perDay, pace, groupSize,
        bySubject, byGroup, dGlobal, dMap, step,
      }));
    } catch {}
  }, [items, subjSpread, typeRef, typesBy, combineBy, typeGroupBy, finals, firstsSel, plainSel,
    exWd, exDates, levelMin, busyHours, timed, limitPerDay, perDay, pace, groupSize,
    bySubject, byGroup, dGlobal, dMap, step]);

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
  const groupsFor = sid => {
    const ref = (typeRef[sid] && typeRef[sid] !== 'self') ? typeRef[sid] : sid;
    return calcGroups(typesBy[ref] || [], combineBy[ref] || 'together', typeGroupBy[ref] || {});
  };
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
  // 常見科目的預設顏色（英文=藍、生物=黃）
  const SUBJ_COLOR = { 英文: '#4772fa', 英語: '#4772fa', 國文: '#e03131', 數學: '#16a34a', 化學: '#f59f00', 物理: '#9333ea', 生物: '#eab308', 地科: '#0d9488', 歷史: '#b45309', 地理: '#65a30d', 公民: '#db2777' };
  // 生物舊預設色（青藍/藍）跟英文太像：既有清單若還是舊色就自動改黃
  useEffect(() => {
    lists.filter(l => l.name === '生物' && ['#0891b2', '#4772fa'].includes(l.color))
      .forEach(l => api(`/lists/${l.id}`, { method: 'PATCH', body: { color: '#eab308' } }).then(reload).catch(() => {}));
  }, [lists.length]);
  async function addSubject() {
    const name = prompt('科目名稱（如：數學）：');
    if (!name?.trim()) return;
    const nm = name.trim();
    const used = new Set(lists.map(l => l.color));
    const color = SUBJ_COLOR[nm] || LIST_COLORS.find(c => !used.has(c)) || LIST_COLORS[lists.length % LIST_COLORS.length];
    await api('/lists', { method: 'POST', body: { name: nm, color } });
    reload();
  }
  async function setSubjectColor(l, color) {
    await api(`/lists/${l.id}`, { method: 'PATCH', body: { color } });
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
  // 收集某科所有節點（含深度、level）
  function allNodes(l) {
    const out = [];
    const walk = (n, key, depth) => {
      out.push({ key, title: n.title, level: n.level, depth });
      (n.children || []).forEach((c, i) => walk(c, `${key}.${i}`, depth + 1));
    };
    tocs.filter(t => t.list_id === l.id).map(chapterNode).forEach(n => walk(n, n.key, 0));
    return out;
  }
  // 全選某一層（章/節/主題）：勾選該層所有節點，並清掉同支祖先後代
  function selectLevel(l, targetLevel) {
    const nodes = allNodes(l).filter(n => n.level === targetLevel);
    if (!nodes.length) return;
    const allChecked = nodes.every(n => findItem(n.key));
    setItems(a => {
      // 移除該科所有 toc 選取，重建
      let rest = a.filter(x => !(x.subject_id === l.id && String(x.key).startsWith('toc-')));
      if (allChecked) return rest;
      return [...rest, ...nodes.map(n => ({ key: n.key, subject_id: l.id, name: l.name, color: l.color, title: n.title, minutes: minutesFor(n.level, n.depth), level: n.level }))];
    });
  }
  function selectAllChapters(l) { selectLevel(l, allNodes(l)[0]?.level || '章'); }
  // 該科出現過的層級（去重、依深度排序）
  function subjectLevels(l) {
    const seen = new Map();
    allNodes(l).forEach(n => { if (!seen.has(n.level)) seen.set(n.level, n.depth); });
    return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(x => x[0]);
  }
  function addRange(l) {
    const title = (rangeInput[l.id] || '').trim();
    if (!title) return;
    setItems(it => [...it, { key: Date.now() + Math.random(), subject_id: l.id, name: l.name, color: l.color, title, minutes: 120, secs: [] }]);
    setRangeInput(r => ({ ...r, [l.id]: '' }));
  }

  // 取單位標記（標題第一個詞，如「主題1」「壹」），供合併命名
  const unitTok = title => title.split(/[\s　]/)[0] || title;

  /* ---------- 產生排程 ---------- */
  async function genPreview() {
    setErr('');
    // 依「課本章節順序」排序（不管使用者點選先後），照順序模式才會正確
    const ordMap = {};
    lists.forEach(l => { allNodes(l).forEach((n, i) => { ordMap[n.key] = i; }); });
    const sortedItems = [...items].sort((a, b) => {
      const oa = ordMap[a.key] ?? 9999, ob = ordMap[b.key] ?? 9999;
      return oa - ob;
    });
    // 先依各科「N 個一組」把連續章節單位合併
    const merged = [];
    const bySub = {};
    sortedItems.forEach(it => (bySub[it.subject_id] = bySub[it.subject_id] || []).push(it));
    Object.entries(bySub).forEach(([sid, list]) => {
      const n = groupSize[sid] || 1;
      if (n <= 1) { merged.push(...list); return; }
      for (let i = 0; i < list.length; i += n) {
        const grp = list.slice(i, i + n);
        if (grp.length === 1) { merged.push(grp[0]); continue; }
        merged.push({
          ...grp[0],
          key: grp.map(x => x.key).join('+'),
          title: `${unitTok(grp[0].title)}～${unitTok(grp[grp.length - 1].title)}`,
          minutes: grp.reduce((a, x) => a + (x.minutes || 0), 0),
          _members: grp.map(x => x.key),
        });
      }
    });
    const anyFlag = (m, sel) => (m._members || [m.key]).some(k => sel[k]);

    // 展開順序＝「一個題型組一個題型組」：先送出全科所有章的第 1 組（如範例+例題），
    // 再送第 2 組（如單元練習+歷屆試題）。這樣同一範圍內會先做完整輪第 1 組再進第 2 組；
    // 若各組有自己的日期範圍，則各在自己的範圍內平均鋪滿。
    // 無效的日期範圍自動修正：開始＞結束就對調；整段已過期（草稿記住的舊設定）就退回整體範圍
    const fixWin = w => {
      let { start, end } = w || {};
      if (!start || !end) return { start: dGlobal.start, end: dGlobal.end };
      if (start > end) [start, end] = [end, start];
      if (end < today()) return { start: dGlobal.start, end: dGlobal.end };
      return { start, end };
    };
    const expanded2 = [];
    const mergedBySub = {};
    merged.forEach(it => { (mergedBySub[it.subject_id] = mergedBySub[it.subject_id] || []).push(it); });
    // 單元練習、歷屆試題是「每章一份」，不跟著節/主題各生一份
    const CH_TYPES = ['單元練習', '歷屆試題'];
    const chapTitle = {};
    tocs.forEach(r => { chapTitle[`toc-${r.id}`] = r.title; });
    Object.values(mergedBySub).forEach(list => {
      const sid = list[0].subject_id; // 保留原始型別（Object 的 key 會變字串，導致比對失敗、沒顏色）
      const normal = list.filter(it => !anyFlag(it, plainSel));
      const plains = list.filter(it => anyFlag(it, plainSel));
      groupsFor(sid).forEach((g, gi) => {
        const w = fixWin(winOf(sid, gi));
        const gNode = g ? g.filter(t => !CH_TYPES.includes(t)) : null;   // 跟著節/主題的題型
        const gChap = g ? g.filter(t => CH_TYPES.includes(t)) : [];      // 以章為單位的題型
        if (!g || gNode.length) normal.forEach(it => expanded2.push({
          subject_id: sid,
          title: it.title + (gNode?.length ? `｜${gNode.join('+')}` : ''),
          minutes: it.minutes,
          start: w.start, end: w.end,
          final: anyFlag(it, finals),
          first: anyFlag(it, firstsSel),
          spread: (subjSpread[sid] ?? 'spread') === 'spread',
        }));
        if (gChap.length) {
          const seen = new Set();
          normal.forEach(it => {
            // 找出這個項目所屬的章：key 形如 toc-12.0.2 → 章＝toc-12
            const base = String((it._members?.[0]) ?? it.key).split('+')[0].split('.')[0];
            const chKey = base.startsWith('toc-') ? base : String(it.key);
            if (seen.has(chKey)) return;
            seen.add(chKey);
            expanded2.push({
              subject_id: sid,
              title: `${chapTitle[chKey] || it.title}｜${gChap.join('+')}`,
              minutes: minutesFor('章', 0),
              start: w.start, end: w.end,
              final: false,
              first: false,
              spread: (subjSpread[sid] ?? 'spread') === 'spread',
            });
          });
        }
      });
      // 純題目（模考、學測實驗必考重點等）：不套題型、照順序、一律壓軸排最後。
      // 日期用科目整體範圍（沒設就用全域），不能被某個題型組的前段範圍框住
      const pw = fixWin(dMap[`${bySubject ? sid : 'all'}|all`] || dGlobal);
      plains.forEach(it => expanded2.push({
        subject_id: sid,
        title: it.title,
        minutes: it.minutes,
        start: pw.start, end: pw.end,
        final: true,
        first: false,
        spread: false,
      }));
    });
    try {
      const body = {
        items: expanded2, startDate: dGlobal.start, endDate: dGlobal.end,
        excludeWeekdays: exWd, excludeDates: exDates, skipIfBusyHours: busyHours,
        timed, perDay: (timed || limitPerDay) ? perDay : 0, pace,
      };
      if (!follow) { body.sleep_start = shift.sleep_start; body.sleep_end = shift.sleep_end; }
      setPreview(await api('/schedule/preview', { method: 'POST', body }));
      setStep(4);
    } catch (e) { setErr(e.message); }
  }
  async function confirm() {
    setSaving(true);
    for (const b of preview.blocks) {
      const body = { title: b.title, list_id: b.subject_id, due_date: b.date, tags: ['讀書計劃'] };
      if (b.start_time) { body.due_time = b.start_time; body.notes = `讀書時段 ${b.start_time}–${b.end_time}`; }
      await api('/tasks', { method: 'POST', body });
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
            <div style={{ background: 'var(--bg)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <b>要怎麼安排讀書進度？</b>
              <label style={{ display: 'block', marginTop: 6 }}>
                <input type="radio" checked={timed} onChange={() => setTimed(true)} /> <b>計算時間</b>：算出每章/節要花多久，排成含時段的讀書計劃
              </label>
              <label style={{ display: 'block', marginTop: 4 }}>
                <input type="radio" checked={!timed} onChange={() => setTimed(false)} /> <b>只排進度</b>：單純把章節平均分到每天，不算時間、不顯示時段
              </label>
              {!timed && (
                <div className="row" style={{ marginTop: 6 }}>
                  <label><input type="checkbox" checked={limitPerDay} onChange={e => setLimitPerDay(e.target.checked)} /> 限制每天數量</label>
                  {limitPerDay && <>
                    <span className="muted">每天排</span>
                    <input type="number" min="1" max="10" value={perDay} style={{ width: 56 }} onChange={e => setPerDay(Math.max(1, +e.target.value || 1))} />
                    <span className="muted">個</span>
                  </>}
                  {!limitPerDay && <span className="muted">（不限，平均鋪滿日期範圍）</span>}
                </div>
              )}
            </div>
            <p>排程會自動避開<b>既定行程</b>{timed ? '與睡覺、吃飯時間' : ''}。</p>
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
                        <input value={g.location || ''} placeholder="地點" style={{ width: 80, padding: '4px 6px' }}
                          onChange={e => upd(x => ({ ...x, location: e.target.value, all: x.all.map(ev => ({ ...ev, location: e.target.value })) }))} />
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
              <input placeholder="地點" value={evForm.location} style={{ width: 80 }} onChange={e => setEvForm(f => ({ ...f, location: e.target.value }))} />
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
                      {it && timed && <>
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
                    <input type="color" value={l.color} title="改科目顏色" style={{ width: 28, height: 24, padding: 0, border: 'none', background: 'none' }}
                      onChange={e => setSubjectColor(l, e.target.value)} />
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
                  </div>
                  {rows.length > 0 && (
                    <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                      <span className="muted">快速勾選：</span>
                      {subjectLevels(l).map(lv => (
                        <button key={lv} className="btn sm ghost" onClick={() => selectLevel(l, lv)}>全選{lv}</button>
                      ))}
                      <button className="btn sm ghost" onClick={() => setItems(a => a.filter(x => !(x.subject_id === l.id && String(x.key).startsWith('toc-'))))}>清除</button>
                    </div>
                  )}
                  {rows.length > 0 && <div className="muted" style={{ marginTop: 4 }}>點名稱展開更小單位，可勾章／節／主題任一層（勾小的會取代大的）。改時數會問要不要固定整個層級。目錄不完整可用「追加照片」補後面幾頁</div>}
                  {tocMsg[l.id] && <div className="muted" style={{ marginTop: 4 }}>{tocMsg[l.id]}</div>}
                  {nodes.map(renderNode)}
                  <div className="row" style={{ marginTop: 8 }}>
                    <input placeholder="或手動輸入範圍（如：講義 p.20-35）" value={rangeInput[l.id] || ''} onChange={e => setRangeInput(r => ({ ...r, [l.id]: e.target.value }))} style={{ flex: 1, fontSize: 14 }} />
                    <button className="btn sm ghost" onClick={() => addRange(l)}>＋</button>
                  </div>
                  {items.filter(it => it.subject_id === l.id && !String(it.key).startsWith('toc-')).map(it => (
                    <div key={it.key} className="row" style={{ marginTop: 6, marginLeft: 10 }}>
                      <span style={{ flex: 1 }}>• {it.title}</span>
                      {timed && <>
                        <input type="number" min="30" step="30" value={it.minutes} style={{ width: 70 }}
                          onChange={e => setItems(a => a.map(x => x.key === it.key ? { ...x, minutes: +e.target.value } : x))} />
                        <span className="muted">分</span>
                      </>}
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
                <div key={sid} style={{ marginTop: 8 }}>
                  <div className="row">
                    <span className="tag" style={{ background: lists.find(l => l.id === sid)?.color, color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>{sname(sid)}</span>
                    <label><input type="radio" checked={(subjSpread[sid] ?? 'spread') === 'spread'} onChange={() => setSubjSpread(s => ({ ...s, [sid]: 'spread' }))} /> 打散平均</label>
                    <label><input type="radio" checked={subjSpread[sid] === 'order'} onChange={() => setSubjSpread(s => ({ ...s, [sid]: 'order' }))} /> 照章節順序</label>
                  </div>
                  <div className="row" style={{ marginTop: 4, marginLeft: 10 }}>
                    <label><input type="checkbox" checked={(groupSize[sid] || 1) > 1} onChange={e => setGroupSize(g => ({ ...g, [sid]: e.target.checked ? 2 : 1 }))} /> 幾個單位綁一組排</label>
                    {(groupSize[sid] || 1) > 1 && <>
                      <input type="number" min="2" max="20" value={groupSize[sid]} style={{ width: 56 }} onChange={e => setGroupSize(g => ({ ...g, [sid]: Math.max(2, +e.target.value || 2) }))} />
                      <span className="muted">個一組（如「主題1～主題3」一次排）</span>
                    </>}
                  </div>
                </div>
              ))}

              <b style={{ display: 'block', marginTop: 16 }}>教材題型（範例/例題/單元練習/歷屆試題）</b>
              <div className="muted" style={{ marginTop: 2 }}>每科可自己設，也可選「跟某科一樣」共用設定。範例/例題跟著你勾的單位；單元練習/歷屆試題以「章」為單位，每章一份</div>
              {sids.map((sid, idx) => {
                const ref = typeRef[sid] && typeRef[sid] !== 'self' ? typeRef[sid] : null;
                return (
                  <div key={sid} style={{ marginTop: 10, borderLeft: `3px solid ${lists.find(l => l.id === sid)?.color}`, paddingLeft: 8 }}>
                    <div className="row">
                      <b>{sname(sid)}</b>
                      {idx > 0 && (
                        <select value={typeRef[sid] || 'self'} onChange={e => setTypeRef(s => ({ ...s, [sid]: e.target.value }))}>
                          <option value="self">自己設定</option>
                          {sids.filter(s2 => s2 !== sid && (typeRef[s2] || 'self') === 'self').map(s2 =>
                            <option key={s2} value={s2}>跟「{sname(s2)}」一樣</option>)}
                        </select>
                      )}
                    </div>
                    {ref
                      ? <div className="muted" style={{ marginTop: 4 }}>＝ 使用「{sname(ref)}」的題型設定</div>
                      : <TypePanel ts={typesBy[sid] || []} cb={combineBy[sid] || 'together'} tg={typeGroupBy[sid] || {}}
                        onTs={v => setTypesBy(s => ({ ...s, [sid]: v }))}
                        onCb={v => setCombineBy(s => ({ ...s, [sid]: v }))}
                      onTg={v => setTypeGroupBy(s => ({ ...s, [sid]: v }))} />}
                  </div>
                );
              })}

              <b style={{ display: 'block', marginTop: 16 }}>有沒有章節需要「先完成」或「壓軸」？</b>
              <div className="muted">先完成＝最先排；壓軸＝其他全部讀完才排（如：學測模擬試題、115 學測試題）</div>
              {items.map(it => (
                <div key={it.key} style={{ marginTop: 6 }}>
                  <div className="row">
                    <span style={{ color: it.color }}>■</span>
                    <span style={{ flex: 1 }}>{it.name}｜{it.title}</span>
                    <label className={'tag-pill' + (firstsSel[it.key] ? ' on' : '')} style={{ cursor: 'pointer' }}
                      onClick={() => { setFirstsSel(f => ({ ...f, [it.key]: !f[it.key] })); setFinals(f => ({ ...f, [it.key]: false })); }}>先完成</label>
                    <label className={'tag-pill' + (finals[it.key] ? ' on' : '')} style={{ cursor: 'pointer' }}
                      onClick={() => { setFinals(f => ({ ...f, [it.key]: !f[it.key] })); setFirstsSel(f => ({ ...f, [it.key]: false })); }}>壓軸</label>
                  </div>
                  <div className="row" style={{ marginLeft: 18, marginTop: 2 }}>
                    <label className={'tag-pill' + (plainSel[it.key] ? ' on' : '')} style={{ cursor: 'pointer' }}
                      onClick={() => {
                        const on = !plainSel[it.key];
                        setPlainSel(f => ({ ...f, [it.key]: on }));
                        if (on) { setFinals(f => ({ ...f, [it.key]: true })); setFirstsSel(f => ({ ...f, [it.key]: false })); }
                      }}>純題目（如模考、學測實驗）— 不套題型・照順序・壓軸排最後</label>
                  </div>
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

            <b style={{ display: 'block', marginTop: 14 }}>怎麼分配到這些日子？</b>
            <div style={{ marginTop: 6 }}>
              <label style={{ display: 'block' }}>
                <input type="radio" checked={pace === 'even'} onChange={() => setPace('even')} /> 平均分配（每天差不多，排到截止日）
              </label>
              <label style={{ display: 'block', marginTop: 4 }}>
                <input type="radio" checked={pace === 'front'} onChange={() => setPace('front')} /> 盡早排完（前面多排，早點讀完、後面留空）
              </label>
            </div>

            <label style={{ display: 'block', marginTop: 12 }}>
              <input type="checkbox" checked={bySubject} onChange={e => setBySubject(e.target.checked)} /> 各科目用不同日期範圍
            </label>
            {[...new Set(items.map(i => i.subject_id))].some(sid => groupsFor(sid).length > 1) && (
              <label style={{ display: 'block', marginTop: 4 }}>
                <input type="checkbox" checked={byGroup} onChange={e => setByGroup(e.target.checked)} /> 各題型組用不同日期範圍
              </label>
            )}
            {(bySubject || byGroup) && (
              <div style={{ marginTop: 10 }}>
                {(bySubject ? [...new Set(items.map(i => i.subject_id))] : ['all']).map(sid => {
                  const sname = sid === 'all' ? '' : lists.find(l => l.id === sid)?.name || '';
                  const gs = groupsFor(sid === 'all' ? [...new Set(items.map(i => i.subject_id))][0] : sid);
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
            {preview.check && (
              <div style={{ background: 'var(--fill)', borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
                <span className="muted">
                  ✓ 已自我檢查：每日 {preview.check.dailyMin}～{preview.check.dailyMax} 項
                  {(!preview.check.warnings || !preview.check.warnings.length) && '，各科分佈正常'}
                </span>
                {(preview.check.subjects || []).length > 0 && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    {preview.check.subjects.map(s =>
                      `${lists.find(l => l.id === s.subject_id)?.name || '?'} ${s.first.slice(5).replace('-', '/')}–${s.last.slice(5).replace('-', '/')}（${s.count}項）`
                    ).join('・')}
                  </div>
                )}
                {(preview.check.warnings || []).map((w, i) => (
                  <div key={i} className="muted" style={{ marginTop: 4 }}>
                    ℹ️ {lists.find(l => l.id === w.subject_id)?.name || '有一科'}中間有 {w.maxGap} 天不會出現——這是你設定的日期範圍造成的（如例題和練習的範圍中間有空檔），有需要可調整範圍
                  </div>
                ))}
              </div>
            )}
            {preview.unplaced && (
              <div style={{ border: '1px solid var(--red)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <div className="error"><b>空檔不足，有內容排不進去</b></div>
                <div className="muted" style={{ margin: '4px 0 8px' }}>{preview.message}</div>
                <div className="muted">想怎麼處理？</div>
                <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => setStep(1)}>刪掉一些內容</button>
                  <button className="btn sm ghost" onClick={() => setStep(3)}>增加讀書天數/延長日期</button>
                  {timed && <button className="btn sm ghost" onClick={() => { setTimed(false); genPreview(); }}>改成「不計時、只排進度」</button>}
                </div>
              </div>
            )}
            {Object.entries(preview.blocks.reduce((a, b) => { (a[b.date] = a[b.date] || []).push(b); return a; }, {})).map(([d, list]) => (
              <div key={d} style={{ marginBottom: 10 }}>
                <b>{d}（週{WD[new Date(d + 'T00:00:00').getDay()]}）</b>
                {list.map((b, i) => {
                  const l = lists.find(x => x.id === b.subject_id);
                  return <div key={i} className="row" style={{ marginTop: 4 }}>
                    {b.start_time && <span className="muted">{b.start_time}–{b.end_time}</span>}
                    <span style={{ color: l?.color }}>■</span><span>{l?.name}｜{b.title}</span>
                  </div>;
                })}
              </div>
            ))}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setStep(3)}>不滿意，重新調整</button>
              <button className="btn" disabled={saving} onClick={confirm}>{saving ? '建立中…' : `滿意，加入待辦（${preview.blocks.length} ${timed ? '段' : '項'}）！`}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
