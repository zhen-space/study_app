import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { planName, isLegacyPlanTask } from './plans';
import { applyWizardSchedule } from './wizardApply';
import { buildSchedulePreviewRequest, persistConfirmedConditions } from './schedulePreview';
import { today, addDays } from './helpers';
import { parseICS } from './ics';
import { fileToPayload } from './vocabImport';
import FeasibilityGap from './FeasibilityGap';
import MaterialSelector from './MaterialSelector';
import { listBooks, getPlanSelection, selectItems, materialSchedulingItems } from './material';
import { SegmentedControl, Button } from './ui';

const LIST_COLORS = ['#0086CC', '#e03131', '#16a34a', '#f59f00', '#9333ea', '#0891b2'];
const TYPE_OPTIONS = ['範例', '例題', '單元練習', '歷屆試題'];
// 範例/例題跟著小節/主題；單元練習/歷屆試題是「每章一份」
const CH_TYPES = ['單元練習', '歷屆試題'];
// 合理預設：不調整也能直接產生——範例+例題一組、單元練習+歷屆試題一組
const DEF_TYPES = ['範例', '例題', '單元練習', '歷屆試題'];
const DEF_COMBINE = 'custom';
const DEF_TG = { 範例: 0, 例題: 0, 單元練習: 1, 歷屆試題: 1 };
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

// 說明文字一律收在「怎麼用？」裡，預設收合——展開才佔版面，畫面才不會被灰字淹沒
function Help({ children }) {
  return (
    <details className="wz-help">
      <summary>怎麼用？</summary>
      <div>{children}</div>
    </details>
  );
}

// 三個步驟：讀什麼 → 怎麼安排 → AI 排程結果。沒有第四步。
const STEPS = ['讀什麼', '怎麼安排', 'AI 排程結果'];
// 從「調整計畫」底部選單進來時，要直接跳到哪一段
const SECTION_STEP = { content: 0, all: 0, time: 1, cond: 1, deadline: 1 };

export default function WizardView({
  lists, tasks = [], reload, goTasks, goCalendar,
  // Edit Mode：從計畫明細的「調整計畫」進來，帶著要調整的那個計畫
  mode = 'create', planId = null, planTitle = '', planTasks = [], initialSection = '', onDone,
}) {
  const isEdit = mode === 'edit' && planId != null;
  const [step, setStep] = useState(SECTION_STEP[initialSection] ?? 0);
  // 第 3 步的檢視方式：清單／日曆。只是換看法，不是換排法
  const [resultView, setResultView] = useState('list');
  const [applied, setApplied] = useState(null);   // Edit Mode 套用結果摘要
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [follow, setFollow] = useState(true);
  const [shift, setShift] = useState({ sleep_start: '', sleep_end: '' });
  const [items, setItems] = useState([]);           // 已勾選的章節項目
  const [rangeInput, setRangeInput] = useState({});
  // 正式 Material 選取。Create 模式是草稿（Plan 還不存在），Edit 模式直接寫正式 API。
  const [matIds, setMatIds] = useState(() => new Set());
  const [matPicked, setMatPicked] = useState(() => new Map()); // id → descriptor
  const [matBooks, setMatBooks] = useState([]);
  // null = 自動：有正式教材就用教材庫，還沒有就直接顯示舊版目錄。
  // 一律預設教材庫會讓還沒轉換的使用者一進來就看到空白。
  const [source, setSource] = useState(null);
  const [tocs, setTocs] = useState([]);
  const [tocBusy, setTocBusy] = useState(null);
  const [editBook, setEditBook] = useState(null);   // 正在改名的書：`${list_id}|${第一章的id}`
  const [bookDraft, setBookDraft] = useState(null); // 編輯中的書名/出版社（按「完成」才存）
  const [tocMsg, setTocMsg] = useState({});
  const [expanded, setExpanded] = useState({});
  const [adding, setAdding] = useState({});      // 哪個節點正在「自己加節/主題」
  const [addDraft, setAddDraft] = useState({});  // 打到一半的名稱
  const [subjSpread, setSubjSpread] = useState({});   // 每科：章節打散(spread)或照順序(order)
  const [typeRef, setTypeRef] = useState({});         // 每科題型：'self'或跟哪個 sid 相同
  const [typesBy, setTypesBy] = useState({});         // 分科題型 sid→types[]
  const [combineBy, setCombineBy] = useState({});
  const [typeGroupBy, setTypeGroupBy] = useState({});
  const [finals, setFinals] = useState({});           // 壓軸項目
  const [firstsSel, setFirstsSel] = useState({});     // 要先完成的項目
  const [plainSel, setPlainSel] = useState({});       // 純題目：不套題型、照順序（如模考）
  const [skipTypes, setSkipTypes] = useState({});     // 「key|組序」→ 'first'先完成｜'final'壓軸｜'off'不寫；沒設＝正常排
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
  // 科目先後順序（2C-P6-B）：使用者排「數學 → 化學 → 英文」。
  // 語意是 priority 不是 dependency——優先取得排程位置，但不要求前一科排完
  // 才能開始下一科。存的是科目 id 由前到後。
  const [subjOrder, setSubjOrder] = useState([]);
  const [bySubject, setBySubject] = useState(false);
  const [byGroup, setByGroup] = useState(false);
  const [dGlobal, setDGlobal] = useState({ start: today(), end: addDays(today(), 6) });
  const [dMap, setDMap] = useState({});               // `${sid}|${gi}` → {start,end}
  const [preview, setPreview] = useState(null);
  const [redoUndone, setRedoUndone] = useState(true); // 要不要一起重新安排
  const [mergedLeftover, setMergedLeftover] = useState([]); // 這次真的被併進排程的舊任務（含 id）
  const [redoDone, setRedoDone] = useState(false);    // 想重讀一次時才勾
  const [planNameInput, setPlanNameInput] = useState('');  // 這份計畫要叫什麼（確認步驟）
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
    listBooks().then(setMatBooks).catch(() => setMatBooks([]));
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
  // Edit Mode 的草稿要分計畫存，不然調整 A 計畫會把 B 計畫的草稿蓋掉。
  // （草稿只是「這次操作到一半的設定」，不是計畫資料，不是第二套排程狀態）
  const draftKey = isEdit ? `wizardDraft:plan:${planId}` : 'wizardDraft';
  const draftLoaded = useRef(false);
  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) || 'null');
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
        d.skipTypes && setSkipTypes(Object.fromEntries(
          Object.entries(d.skipTypes).map(([k, v]) => [k, v === true ? 'off' : v]).filter(([, v]) => v))); // 舊草稿 true＝不寫
        d.exWd && setExWd(d.exWd);
        d.exDates && setExDates(d.exDates);
        d.levelMin && setLevelMin(d.levelMin);
        d.busyHours != null && setBusyHours(d.busyHours);
        d.timed != null && setTimed(d.timed);
        d.limitPerDay != null && setLimitPerDay(d.limitPerDay);
        d.perDay != null && setPerDay(d.perDay);
        d.pace && setPace(d.pace);
        d.groupSize && setGroupSize(d.groupSize);
        Array.isArray(d.subjOrder) && setSubjOrder(d.subjOrder);
        d.bySubject != null && setBySubject(d.bySubject);
        d.byGroup != null && setByGroup(d.byGroup);
        // 整體範圍：過期的不還原；開始日一律不早於今天（過去的日期沒意義）
        if (d.dGlobal && d.dGlobal.end >= today()) {
          setDGlobal({ start: d.dGlobal.start < today() ? today() : d.dGlobal.start, end: d.dGlobal.end });
        }
        // 各科/各題型的額外設定：過期的（結束日已過）就丟掉，改回跟著整體範圍
        if (d.dMap) {
          setDMap(Object.fromEntries(Object.entries(d.dMap).filter(([, v]) => !v?.end || v.end >= today())));
        }
        // 第 3 步要重新產生預覽才有東西看，草稿最多還原到第 2 步；
        // 有指定 section（從「調整計畫」深連結進來）時以 section 為準
        if (d.step != null && !initialSection) setStep(Math.min(d.step, 1));
      }
    } catch {}
    draftLoaded.current = true;
    // draftKey／initialSection 在同一個掛載期間不會變（Shell 用它們當 key），
    // 列進來只是讓相依關係寫全，語意沒有改變
  }, [draftKey, initialSection]);
  // 草稿是舊的也沒關係：科目改過顏色/名稱就同步成現在的
  useEffect(() => {
    if (!lists.length) return;
    setItems(a => {
      let changed = false;
      const next = a.map(it => {
        const l = lists.find(x => x.id === it.subject_id);
        if (l && (it.color !== l.color || it.name !== l.name)) { changed = true; return { ...it, color: l.color, name: l.name }; }
        return it;
      });
      return changed ? next : a;
    });
  }, [lists]);
  useEffect(() => {
    if (!draftLoaded.current) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({
        items, subjSpread, typeRef, typesBy, combineBy, typeGroupBy, finals, firstsSel, plainSel, skipTypes,
        exWd, exDates, levelMin, busyHours, timed, limitPerDay, perDay, pace, groupSize, subjOrder,
        bySubject, byGroup, dGlobal, dMap, step,
      }));
    } catch {}
  }, [draftKey, items, subjSpread, typeRef, typesBy, combineBy, typeGroupBy, finals, firstsSel, plainSel, skipTypes,
    exWd, exDates, levelMin, busyHours, timed, limitPerDay, perDay, pace, groupSize, subjOrder,
    bySubject, byGroup, dGlobal, dMap, step]);

  const evGroups = useMemo(() => groupEvents(events), [events]);

  // 「上次還沒做完的」要從哪裡來，是這一段最危險的地方。
  //
  // 原本走 GET /plan-tasks，但那支是照「讀書計劃」標籤／標題全域撈的，
  // 而且回傳裡沒有 plan_id——正式 Plan 的任務會被一起撈進來，跟著重排一次，
  // 同一份內容就會同時存在兩個計畫。所以這裡改成自己從 tasks 推導，
  // Create Mode 只認 legacy（plan_id == null），Edit Mode 只認這個計畫自己的。
  const livePlanTasks = useMemo(() => planTasks.filter(t => !t.deleted), [planTasks]);
  const leftover = useMemo(
    () => (isEdit ? livePlanTasks.filter(t => !t.completed) : tasks.filter(isLegacyPlanTask).filter(t => !t.completed)),
    [isEdit, livePlanTasks, tasks]);
  // 已完成的不再重排。這份只用來「排除」，不會寫入任何東西，
  // 所以維持原本的全域範圍（做過的內容不該在任何計畫裡再冒出來）。
  const doneItems = useMemo(
    () => (isEdit ? livePlanTasks.filter(t => t.completed)
      : tasks.filter(t => t.completed && !t.deleted
        && ((Array.isArray(t.tags) && t.tags.includes('讀書計劃')) || (t.title || '').includes('｜')))),
    [isEdit, livePlanTasks, tasks]);

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
    const r = typeRef[sid];
    const ref = (r && r !== 'self' && lists.some(l => String(l.id) === String(r))) ? r : sid;
    // 沒動過的科目用預設兩組（範例+例題／單元練習+歷屆）；清空過的（[]）尊重使用者
    return calcGroups(typesBy[ref] ?? DEF_TYPES, combineBy[ref] ?? DEF_COMBINE, typeGroupBy[ref] ?? DEF_TG);
  };
  const gLabel = g => g ? g.join('+') : '';

  // 各科／各題型的日期：只有「使用者自己動過的那一欄」才記在 dMap，
  // 其他一律跟著整體範圍走（改整體範圍時會自動跟著變）
  const mergeWin = k => {
    const o = dMap[k] || {};
    return { start: o.start || dGlobal.start, end: o.end || dGlobal.end };
  };
  const winOf = (sid, gi) => mergeWin(`${bySubject ? sid : 'all'}|${byGroup ? gi : 'all'}`);

  /* ---------- 檔案 ---------- */

  async function importAI(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setImportMsg('檔案太大（上限 15MB）'); return; }
    setAiBusy(true);
    setImportMsg('🤖 AI 解讀中，約需 30 秒～1 分鐘…');
    try {
      const { events: parsed } = await api('/import/parse', {
        method: 'POST',
        body: await fileToPayload(file),                              // 同上：轉正＋縮圖
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
  /* ---------- 科目章節 ---------- */
  // 常見科目的預設顏色（英文=藍、生物=黃）
  const SUBJ_COLOR = { 英文: '#0086CC', 英語: '#0086CC', 國文: '#e03131', 數學: '#16a34a', 化學: '#f59f00', 物理: '#9333ea', 生物: '#eab308', 地科: '#0d9488', 歷史: '#b45309', 地理: '#65a30d', 公民: '#db2777' };
  // 生物舊預設色（青藍/藍）跟英文太像：既有清單若還是舊色就自動改黃
  useEffect(() => {
    lists.filter(l => l.name === '生物' && ['#0891b2', '#0086CC'].includes(l.color))
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
  // mode: 'replace'＝重拍整科｜'newbook'＝加一本新的書（不會併進上一本）｜{ book }＝補某一本的後幾頁
  async function uploadTOC(l, e, mode = 'replace') {
    const fileList = [...e.target.files];
    if (!fileList.length) return;
    if (fileList.length > 12) { setTocMsg(m => ({ ...m, [l.id]: '一次最多 12 張照片' })); e.target.value = ''; return; }
    const replace = mode === 'replace';
    const targetBook = typeof mode === 'object' ? mode.book : null;
    setTocBusy(l.id);
    setTocMsg(m => ({ ...m, [l.id]: `🤖 AI 解讀 ${fileList.length} 張目錄中，約 30 秒～1 分鐘…` }));
    try {
      const files = [];
      for (const f of fileList) files.push(await fileToPayload(f));   // 照片自動轉正＋縮圖，AI 才讀得到
      await api('/import/toc', {
        method: 'POST',
        body: { list_id: l.id, files, replace, forceNew: mode === 'newbook', book: targetBook },
      });
      setTocs(await api('/import/toc'));
      if (replace) setItems(a => a.filter(x => x.subject_id !== l.id || !String(x.key).startsWith('toc-')));
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
  /* ---------- Material 選取 → 排程項目 ---------- */
  //
  // Material 的 ContentItem 本身就是原子單位（某一份單元練習、某一題例題），
  // 不需要再經過舊版的「題型展開」——那是為了把抽象的章節拆成可排的份數而存在的。
  // 所以這裡直接一項對一項產生排程項目，並保留 material_content_item_id，
  // 讓套用時建立的 Task 帶得上正式 Material linkage。
  // 排程項目一律由 material.js 的純函式產生：它回傳的 subject_id 是正式的
  // lists.id（material_books.subject_list_id），**絕不用科目名稱**去比對。
  // 沒有科目的書會被列進 blocked，在第 1 步就顯示出來，不會拖到排程最後才失敗。
  const { items: materialItems, blocked: matNoSubject } = useMemo(
    () => materialSchedulingItems(matPicked, matBooks, lists, LIST_COLORS[0]),
    [matPicked, matBooks, lists]);

  const onMaterialPicked = useCallback((descriptors, selected) => {
    setMatPicked(prev => {
      const next = new Map(prev);
      for (const d of descriptors) { if (selected) next.set(d.id, d); else next.delete(d.id); }
      return next;
    });
  }, []);

  // Edit Mode：正式 selection 存在後端，進來時直接讀回來當初始狀態。
  useEffect(() => {
    if (!isEdit || planId == null) return;
    getPlanSelection(planId).then(rows => {
      const picked = new Map();
      for (const r of rows) {
        if (!r.selected || r.material_completed) continue;
        picked.set(r.content_item_id, {
          id: r.content_item_id, title: r.title, kind: r.kind,
          estimated_minutes: null, book_id: r.book_id,
          book_title: matBooks.find(b => b.id === r.book_id)?.title || '', path: [],
        });
      }
      setMatPicked(picked);
      setMatIds(new Set(picked.keys()));
    }).catch(() => {});
  }, [isEdit, planId, matBooks]);

  const srcTab = source ?? (matBooks.length ? 'material' : 'legacy');
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

  /* ---------- 科目先後順序 ---------- */
  // 這次真的選到的科目（去重，維持出現順序）
  const selectedSubjectIds = [...new Set(items.map(i => i.subject_id))];
  // 畫面上顯示的順序：使用者排過的優先，沒排到的接在後面。
  // 已經不在這次選取範圍的科目自動消失，不用另外清理。
  const orderedSubjectIds = [
    ...subjOrder.filter(sid => selectedSubjectIds.some(x => String(x) === String(sid))),
    ...selectedSubjectIds.filter(sid => !subjOrder.some(x => String(x) === String(sid))),
  ];
  // 上／下移一格。第一次移動時把當下顯示的順序整個定下來——
  // 在那之前 subjOrder 是空的，代表「使用者沒指定」，後端就維持既有行為。
  const moveSubject = (sid, delta) => {
    const cur = [...orderedSubjectIds];
    const i = cur.findIndex(x => String(x) === String(sid));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]];
    setSubjOrder(cur);
  };

  /* ---------- 產生排程 ---------- */
  // 使用者設定的「排法」。產生預覽與（成功套用後）存進條件快照都用這一份，
  // 兩邊不會各寫一次、也不會漂移。
  const conditions = {
    timed, limitPerDay, perDay, pace,
    excludeWeekdays: exWd, excludeDates: exDates, skipIfBusyHours: busyHours,
    // 只送「這次真的有選到的科目」，順序照使用者排的。沒排過就是空的，
    // 後端收不到這個欄位＝沒指定。
    // 使用者沒排過就送空的：沒指定 ≠ 照選取順序，後端要維持既有行為
    subjectOrder: subjOrder.length ? orderedSubjectIds : [],
  };

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
    const chapTitle = {};
    tocs.forEach(r => { chapTitle[`toc-${r.id}`] = r.title; });
    // 同一科有多本課本時，任務標題前面加書名，才知道是哪一本
    const bookByToc = {};
    tocs.forEach(r => { bookByToc[`toc-${r.id}`] = r.book || ''; });
    const bookPrefix = (sid, key) => {
      if (new Set(tocs.filter(t => t.list_id === sid).map(t => t.book || '')).size < 2) return '';
      const b = bookByToc[String(key).split('+')[0].split('.')[0]];
      return b ? `${b}｜` : '';
    };
    Object.values(mergedBySub).forEach(list => {
      const sid = list[0].subject_id; // 保留原始型別（Object 的 key 會變字串，導致比對失敗、沒顏色）
      const normal = list.filter(it => !anyFlag(it, plainSel));
      const plains = list.filter(it => anyFlag(it, plainSel));
      groupsFor(sid).forEach((g, gi) => {
        const w = fixWin(winOf(sid, gi));
        const gNode = g ? g.filter(t => !CH_TYPES.includes(t)) : null;   // 跟著節/主題的題型
        const gChap = g ? g.filter(t => CH_TYPES.includes(t)) : [];      // 以章為單位的題型
        // 每單元每組題型的狀態：'off'不寫｜'first'先完成｜'final'壓軸｜沒設＝正常排
        const modeOf = it => {
          const ms = (it._members || [it.key]).map(k => skipTypes[`${k}|${gi}`]);
          if (ms.length && ms.every(m => m === 'off')) return 'off';
          return ms.find(m => m === 'first' || m === 'final') || null;
        };
        const skipped = it => g && gNode.length && modeOf(it) === 'off';
        if (!g || gNode.length) normal.filter(it => !skipped(it)).forEach(it => expanded2.push({
          subject_id: sid,
          // 標題含章名稱：勾的是節/主題時，前面加上所屬章（如「3 大氣｜主題1 …」）
          title: (() => {
            const base = String((it._members?.[0]) ?? it.key).split('+')[0].split('.')[0];
            const ch = base.startsWith('toc-') && base !== String(it.key).split('+')[0] ? chapTitle[base] : '';
            return bookPrefix(sid, it.key) + (ch ? `${ch}｜` : '') + it.title + (gNode?.length ? `｜${gNode.join('+')}` : '');
          })(),
          minutes: it.minutes,
          start: w.start, end: w.end,
          final: anyFlag(it, finals) || modeOf(it) === 'final',
          first: anyFlag(it, firstsSel) || modeOf(it) === 'first',
          spread: (subjSpread[sid] ?? 'order') === 'spread',
        }));
        if (gChap.length) {
          const seen = new Set();
          normal.forEach(it => {
            // 找出這個項目所屬的章：key 形如 toc-12.0.2 → 章＝toc-12
            const base = String((it._members?.[0]) ?? it.key).split('+')[0].split('.')[0];
            const chKey = base.startsWith('toc-') ? base : String(it.key);
            if (seen.has(chKey)) return;
            seen.add(chKey);
            const chMode = skipTypes[`ch:${chKey}|${gi}`];
            if (chMode === 'off') return; // 這章的練習/歷屆標「不寫」
            expanded2.push({
              subject_id: sid,
              title: `${bookPrefix(sid, chKey)}${chapTitle[chKey] || it.title}｜${gChap.join('+')}`,
              minutes: minutesFor('章', 0),
              start: w.start, end: w.end,
              final: chMode === 'final',
              first: chMode === 'first',
              spread: (subjSpread[sid] ?? 'order') === 'spread',
              onePerDay: true, // 單元練習/歷屆試題盡量一天一課；擠不下優先讓範例+例題一天兩課
            });
          });
        }
      });
      // 純題目（模考、學測實驗必考重點等）：不套題型、照順序、一律壓軸排最後。
      // 日期用科目整體範圍（沒設就用全域），不能被某個題型組的前段範圍框住
      const pw = fixWin(mergeWin(`${bySubject ? sid : 'all'}|all`));
      plains.forEach(it => expanded2.push({
        subject_id: sid,
        title: it.title,
        minutes: it.minutes,
        start: pw.start, end: pw.end,
        // 純題目預設壓軸，但也可以標先完成或照常排
        final: anyFlag(it, finals),
        first: anyFlag(it, firstsSel),
        spread: false,
        onePerDay: true,   // 純題目本來就是整份題目，一天只排一份
      }));
    });
    // 上次沒做完的一起重排：標題原樣帶回去（伺服器會自己認出純題目），
    // 已經在這次勾選裡的就不重複加
    // 這次真正被帶進排程的舊任務，逐筆記下來（連 id 一起）。
    // 之後只有「這幾筆」有資格被軟刪除——沒被帶進來的一律不動。
    const merged2 = [];
    if (redoUndone && leftover.length) {
      const have = new Set(expanded2.map(i => i.title));
      const gw = fixWin(mergeWin('all|all'));
      for (const t of leftover) {
        if (!t.title || have.has(t.title)) continue;
        have.add(t.title);
        const w = bySubject ? fixWin(mergeWin(`${t.list_id}|all`)) : gw;
        expanded2.push({ subject_id: t.list_id, title: t.title, minutes: 60, start: w.start, end: w.end, spread: false });
        merged2.push(t);
      }
    }
    // Material 選取直接附加，不經過題型展開（ContentItem 已經是原子單位）。
    // 這一步刻意放在展開之後：既有的展開邏輯一行都沒有被改到。
    for (const m of materialItems) {
      const w = bySubject ? fixWin(mergeWin(`${m.subject_id}|all`)) : fixWin(mergeWin('all|all'));
      expanded2.push({
        subject_id: m.subject_id, title: m.title, minutes: m.minutes,
        start: w.start, end: w.end, spread: false,
        material_content_item_id: m.material_content_item_id,
      });
    }
    setMergedLeftover(merged2);
    // 已經打勾完成的不要再排一次（想重讀才勾「已完成的也重排」）。
    // 同一科＋同一個標題才算同一件事，不同科目撞名不會誤刪。
    // 注意：這裡不能取名 items——外面已經有一個 items（勾選的目錄項目），
    // 在同一個函式裡再 let 一次會讓函式開頭那行的 items 落進暫時性死區，
    // 一進 genPreview 就丟 ReferenceError，按鈕看起來像完全沒反應。
    let sendItems = expanded2;
    if (!redoDone && doneItems.length) {
      const done = new Set(doneItems.map(t => `${t.list_id}|${t.title}`));
      sendItems = expanded2.filter(i => !done.has(`${i.subject_id}|${i.title}`));
    }
    if (!sendItems.length) { setErr('這次沒有要排的項目——選的範圍可能都已經完成了'); return; }
    try {
      // request 的組法只有一套（./schedulePreview），Today 的 AI 重排走同一支，
      // 免得同一個計畫在不同入口被用不同的排法排一次
      const body = buildSchedulePreviewRequest({
        items: sendItems, startDate: dGlobal.start, endDate: dGlobal.end,
        // 「這次調整作息」是一次性的，只影響這次預覽，不進條件快照
        conditions: { ...conditions, ...(follow ? {} : { sleep_start: shift.sleep_start, sleep_end: shift.sleep_end }) },
      });
      // Edit Mode 需要釋出自己舊的 block；Create Mode 沒有既有 Plan，會把所有
      // active Plan 的 timed block 都當作 busy interval。
      if (isEdit) body.plan_id = planId;
      const pv = await api('/schedule/preview', { method: 'POST', body });
      // 同一天之內：同科目排在一起（照科目清單順序），同科目內保持原本順序
      // （原本是「全科的範例組→全科的練習組」，同一科會被其他科隔開）
      const subjOrd = {};
      lists.forEach((l, i) => { subjOrd[String(l.id)] = i; });
      pv.blocks = [...pv.blocks].sort((a, b) =>
        a.date.localeCompare(b.date) || (subjOrd[String(a.subject_id)] ?? 99) - (subjOrd[String(b.subject_id)] ?? 99));
      setPreview(pv);
      // 預設計畫名稱：單科單書用「{科目}｜{書名}」，其他用「讀書計畫｜{起}–{迄}」。
      // 只有使用者還沒自己打過才覆蓋，免得重新產生預覽把他改的名字洗掉。
      setPlanNameInput(n => n.trim() ? n : (planTitle || planName(
        pv.blocks.map(b => ({ title: b.title, list_id: b.subject_id, due_date: b.date })), lists)));
      setApplied(null);
      setStep(2);
    } catch (e) { setErr(e.message); }
  }
  // 真正寫進資料庫的只有這一步，而且只透過 ./wizardApply 這一層。
  // 精靈本身不知道排定位置目前是存在 due_date——2C 換成 ScheduleVersion 時，
  // 三個步驟一行都不用改。
  // block → material_content_item_id。materialItems 的 title 是這次自己組出來的，
  // 所以 (科目|標題) 在這次 session 內足以指回原本的 ContentItem。
  const materialBlockMap = useMemo(() => {
    const m = {};
    for (const it of materialItems) m[`${it.subject_id}|${it.title}`] = it.material_content_item_id;
    return m;
  }, [materialItems]);

  async function confirm() {
    setSaving(true);
    try {
      const r = await applyWizardSchedule({
        mode: isEdit ? 'edit' : 'create',
        planId,
        name: planNameInput.trim() || planName(
          preview.blocks.map(b => ({ title: b.title, list_id: b.subject_id, due_date: b.date })), lists),
        blocks: preview.blocks,
        // 這一批 Material 選取產生的 block 對應到哪個 ContentItem。
        // key 是本次 session 自己生成的（科目＋標題），不是拿去猜 legacy 身分的全域比對。
        materialByBlock: materialBlockMap,
        existingTasks: livePlanTasks,
        // 舊任務只有同時滿足這三件事才會被軟刪除：
        //   ① 這次真的被帶進排程（merged）
        //   ② 內容確實出現在最後的排程結果裡（沒排進去的不能刪）
        //   ③ plan_id == null（正式 Plan 的任務一律不碰，apply layer 還會再擋一次）
        legacyMerged: isEdit ? [] : mergedLeftover.filter(t =>
          preview.blocks.some(b => b.title === t.title && String(b.subject_id) === String(t.list_id))),
        // 使用者選「維持原本日期不動」時，這次沒排到的任務原封不動留著
        removeUnscheduled: redoUndone,
      });
      // Create Mode：Plan 這時候才存在，把草稿選取寫成正式的 Plan selection。
      // （Edit Mode 的每一次點擊本來就已經寫進後端了，不需要再送一次）
      if (!isEdit && matIds.size) {
        try { await selectItems(r.planId, [...matIds], true); } catch { /* 排程已成立，選取失敗不回滾 */ }
      }
      setApplied(r);
      // 先把這次真正用的排法記下來，之後 Today 的 AI 重排才有得依循。
      // 順序很重要：草稿是「操作到一半」，套用成功後就沒有意義了，
      // 但條件必須活得比草稿久——所以一定是先存快照、再清草稿。
      await persistConfirmedConditions(r.planId, conditions);
      localStorage.removeItem(draftKey);
    } catch (e) { setSaving(false); setErr(e.message); return; }
    setSaving(false);
    await reload();
    if (isEdit) onDone?.();
    else goTasks();
  }
  const dateInput = (k, label) => {
    const o = dMap[k] || {};
    const v = mergeWin(k);
    const custom = !!(o.start || o.end);            // 有自己設過才算「額外設定」
    const setOne = (field, val) => setDMap(m => ({ ...m, [k]: { ...(m[k] || {}), [field]: val } }));
    return (
      <div className="row" key={k} style={{ marginTop: 6, marginLeft: 10 }}>
        <span className="muted" style={{ minWidth: 90 }}>{label}</span>
        <input type="date" value={v.start} onChange={e => setOne('start', e.target.value)}
          style={o.start ? { boxShadow: 'inset 0 0 0 2px var(--primary)' } : undefined} />
        <span>–</span>
        <input type="date" value={v.end} onChange={e => setOne('end', e.target.value)}
          style={o.end ? { boxShadow: 'inset 0 0 0 2px var(--primary)' } : undefined} />
        {custom
          ? <button className="btn sm ghost" title="改回跟著整體範圍"
              onClick={() => setDMap(m => { const n = { ...m }; delete n[k]; return n; })}>跟整體</button>
          : <span className="muted" style={{ fontSize: 12 }}>跟著整體</span>}
      </div>
    );
  };


  // 排程結果：清單與日曆看的是同一份 preview，只是換一種看法，不是換排法
  const byDate = useMemo(
    () => (preview?.blocks || []).reduce((a, b) => { (a[b.date] = a[b.date] || []).push(b); return a; }, {}),
    [preview]);
  const calCells = useMemo(() => {
    const days = Object.keys(byDate).sort();
    if (!days.length) return [];
    const cells = [];
    for (let i = 0; i < new Date(days[0] + 'T00:00:00').getDay(); i++) cells.push({ date: null, list: [] });
    for (let d = days[0]; d <= days[days.length - 1]; d = addDays(d, 1)) cells.push({ date: d, list: byDate[d] || [] });
    return cells;
  }, [byDate]);

  return (
    <div className="main">
      <div className="main-head">
        <h2>{isEdit ? `調整「${planTitle || '這個計畫'}」` : '🪄 排程精靈'}</h2>
      </div>
      <div className="main-body">
        {isEdit && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            調整的是這一個計畫，不會新增計畫，也不會影響其他計畫
          </div>
        )}
        <div className="steps" style={{ marginTop: 8 }}>{STEPS.map((_, i) => <div key={i} className={'step-dot' + (i <= step ? ' on' : '')} />)}</div>
        <div className="muted" style={{ marginBottom: 10 }}>步驟 {step + 1}／3：{STEPS[step]}</div>

        {/* ============ 步驟 2 之一：這次要排到什麼程度 ============
            這是第 2 步唯一的「主要選擇」，用學生聽得懂的話問，
            不把 timed 這個內部參數講出來。 */}
        {step === 1 && (
          <div className="tile" style={{ marginBottom: 10 }}>
            <b>這次要排到什麼程度？</b>
            <label style={{ display: 'block', marginTop: 6 }}>
              <input type="radio" name="wz-howfar" checked={!timed} onChange={() => setTimed(false)} />
              {' '}<b>只安排每天要做什麼</b>：每天列出要讀的內容，不綁幾點
            </label>
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="wz-howfar" checked={timed} onChange={() => setTimed(true)} />
              {' '}<b>安排到實際時間</b>：連幾點到幾點都排好，自動避開上課與睡覺
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
        )}

        {/* ============ 步驟 2 之二：可用時間 ============
            時間資料就是既有的行事曆與作息設定，精靈不另外做一套日曆——
            要改行程請到行事曆，這裡只顯示現況與匯入工具。 */}
        {step === 1 && settings && (
          <details className="tile" id="wz-sec-time" open={initialSection === 'time'} style={{ marginBottom: 10 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 700 }}>可用時間</summary>
            <p>排程會自動避開<b>既定行程</b>{timed ? '與睡覺、吃飯時間' : ''}。</p>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="muted">目前有 {evGroups.length} 組固定行程</span>
              <button className="btn sm ghost" onClick={() => goCalendar?.()}>去行事曆調整</button>
            </div>
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

            {evGroups.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <b>目前行程（{evGroups.length} 組）</b>
                {evGroups.slice(0, 8).map(g => (
                  <div key={g.ids[0]} className="row" style={{ marginTop: 4 }}>
                    <span><b>{g.title}</b></span>
                    <span className="muted" style={{ flex: 1 }}>{g.when} {g.start_time}–{g.end_time}</span>
                  </div>
                ))}
                {evGroups.length > 8 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>…還有 {evGroups.length - 8} 組</div>}
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>要新增或刪除行程請到行事曆，這裡只顯示現況</div>
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <label style={{ display: 'block' }}><input type="radio" name="wz-sleep" checked={follow} onChange={() => setFollow(true)} /> 遵循平常作息（睡 {settings.sleep_start}–{settings.sleep_end}）</label>
              <label style={{ display: 'block', marginTop: 4 }}><input type="radio" name="wz-sleep" checked={!follow} onChange={() => setFollow(false)} /> 這次調整（可前後 1–2 小時）</label>
              {!follow && (
                <div className="row" style={{ marginTop: 6 }}>
                  <input type="time" value={shift.sleep_start} onChange={e => setShift(s => ({ ...s, sleep_start: e.target.value }))} />
                  <span>–</span>
                  <input type="time" value={shift.sleep_end} onChange={e => setShift(s => ({ ...s, sleep_end: e.target.value }))} />
                </div>
              )}
            </div>
          </details>
        )}

        {/* ============ 步驟 1：讀什麼 ============ */}
        {step === 0 && (
          <div className="tile" id="wz-sec-content">
            {/* 正式教材（Material domain）與舊版目錄（legacy toc_items）是兩套資料，
                identity 不互通。legacy → Material 的 migration 還沒執行，所以這裡
                明確分開讓使用者選，前端絕不用書名／路徑去猜兩邊是不是同一份教材。 */}
            <SegmentedControl ariaLabel="教材來源" block value={srcTab} onChange={setSource}
              options={[{ value: 'material', label: '教材庫' }, { value: 'legacy', label: '舊版目錄' }]} />
            {srcTab === 'material' && (
              <div style={{ marginTop: 12 }}>
                <MaterialSelector
                  planId={isEdit ? planId : null}
                  draftIds={matIds}
                  onDraftChange={setMatIds}
                  onPickedChange={onMaterialPicked}
                  footer={
                    // 用 Design System 的 Button：舊的 .btn 沒有 :disabled 樣態，
                    // 停用時看起來仍像可按，使用者只會覺得「按了沒反應」。
                    <Button variant="primary" style={{ marginLeft: 'auto' }}
                      disabled={!materialItems.length} onClick={() => setStep(1)}>
                      下一步：怎麼安排
                    </Button>
                  } />
                {matNoSubject.length > 0 && (
                  <div className="mt-source-note" role="alert" style={{ marginTop: 12 }}>
                    這些教材還沒有指定科目，所以無法排入計畫：
                    {matNoSubject.map(b => `${b.book_title}（已選 ${b.count} 項）`).join('、')}。
                    請先到「更多 → 教材庫」為它們設定科目，再回來排程。
                  </div>
                )}
              </div>
            )}
            {srcTab === 'legacy' && (<>
            <div className="mt-source-note" style={{ marginTop: 12 }}>
              舊版目錄<span className="mt-legacy-tag">legacy</span>
              是以前用拍照匯入建立的資料，尚未轉成正式教材，所以不會出現在教材庫，
              也不會累積教材完成度。兩邊是不同的資料，不會互相對應。
            </div>
            <Help>
              每科先「拍課本目錄」建立章節，之後直接勾選。<br />
              ・可勾章／節／主題任一層，勾小的會取代大的<br />
              ・同一科第二本書用「加一本新書」；某本沒拍完用該書的「＋頁」補<br />
              ・書名按 ✎ 改；整本按 ✕ 刪<br />
              ・AI 讀漏的自己補：章的「＋節」、節的「＋主題」，打錯按 ✕<br />
              ・多本書時用 ↑↓ 決定先排哪一本
            </Help>
            <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={addSubject}>＋新增科目</button>
            {lists.map(l => {
              const rows = tocs.filter(t => t.list_id === l.id);
              const nodes = rows.map(chapterNode);
              const allSel = nodes.length > 0 && nodes.every(n => findItem(n.key));
              // 以「書」分組：書名當大標、向下展開出現章；可整本刪除
              const bookGroups = (() => {
                const m = new Map();
                rows.forEach(r => { const k = r.book || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
                return [...m.entries()];
              })();
              // 選擇先排哪本書：往上／往下換順序（排程就照這個順序走）
              const moveBook = async (bk, dir) => {
                const names = bookGroups.map(([k]) => k);
                const i = names.indexOf(bk), j = i + dir;
                if (i < 0 || j < 0 || j >= names.length) return;
                [names[i], names[j]] = [names[j], names[i]];
                await api('/import/toc-book-order', { method: 'PATCH', body: { list_id: l.id, books: names } }).catch(() => {});
                setTocs(await api('/import/toc'));
              };
              const delBook = async (bk, rws) => {
                const ids = new Set(rws.map(r => `toc-${r.id}`));
                // 這本書底下已勾選的項目一併移除
                setItems(a => a.filter(x => !(x.subject_id === l.id && ids.has(String(x.key).split('+')[0].split('.')[0]))));
                await api(`/import/toc-book?list_id=${l.id}&book=${encodeURIComponent(bk)}`, { method: 'DELETE' });
                setTocs(await api('/import/toc'));
              };
              // 就地改書名／出版社：畫面先更新，離開欄位才送出（書名是分組鍵，改完重載）
              const saveBook = async (bk, patch) => {
                setEditBook(null);
                setTocs(ts => ts.map(t => t.list_id === l.id && (t.book || '') === bk ? { ...t, ...patch } : t));
                await api('/import/toc-book', { method: 'PATCH', body: { list_id: l.id, book: bk, ...patch } });
                setTocs(await api('/import/toc'));
              };

              // AI 把「本來就獨立」的單元塞進某章底下時，把它拉出來自成一章
              const promote = async (key) => {
                const parts = String(key).split('.');           // toc-12.0.2 → id=12, path=[0,2]
                const tocId = +parts[0].replace('toc-', '');
                const path = parts.slice(1).map(Number);
                if (!path.length) return;
                setItems(a => a.filter(x => !(String(x.key) === String(key) || String(x.key).startsWith(key + '.'))));
                await api('/import/toc-promote', { method: 'POST', body: { id: tocId, path } });
                setTocs(await api('/import/toc'));
              };

              // 自己在章底下加節、在節底下加主題（AI 讀漏或課本沒印的時候）
              const keyToRef = key => {
                const parts = String(key).split('.');
                return { tocId: +parts[0].replace('toc-', ''), path: parts.slice(1).map(Number) };
              };
              // 只換掉那一章的 sections，不用重抓整份目錄（快很多）
              const patchToc = (tocId, sections) => setTocs(a => a.map(r => r.id === tocId ? { ...r, sections } : r));
              // 前端先算一次編號，畫面才能「按下去就出現」；伺服器仍是最終依據
              const nextTitle = (list, t) => {
                let maxN = 0, style = '';
                for (const k of list) {
                  const m = String(k.title || k).match(/^\s*(主題|單元|重點|第)?\s*(\d+)/);
                  if (!m) continue;
                  if (+m[2] > maxN) maxN = +m[2];
                  if (!style && m[1]) style = m[1];
                }
                return /^\s*(主題|單元|重點|第)?\s*\d+/.test(t) ? t : `${style}${maxN + 1} ${t}`;
              };
              const addNode = async (n) => {
                const raw = (addDraft[n.key] || '').trim();
                if (!raw) return;
                const lines = raw.split('\n').map(x => x.trim()).filter(Boolean);
                if (!lines.length) return;
                const { tocId, path } = keyToRef(n.key);
                const level = n.depth === 0 ? '節' : '主題';
                // 1) 先在畫面上加好（樂觀更新），輸入框立刻清空
                setAddDraft(d => ({ ...d, [n.key]: '' }));
                setExpanded(x => ({ ...x, [n.key]: true }));
                const row = tocs.find(r => r.id === tocId);
                if (row) {
                  const clone = JSON.parse(JSON.stringify(row.sections || []));
                  let list = clone;
                  for (const i of path) { list[i].children = list[i].children || []; list = list[i].children; }
                  for (const t of lines) list.push({ title: nextTitle(list, t), level, children: [] });
                  patchToc(tocId, clone);
                }
                // 2) 一次送出全部，回來再用伺服器版本校正
                try {
                  const r = await api('/import/toc-node', { method: 'POST', body: { id: tocId, path, titles: lines, level } });
                  if (r?.sections) patchToc(tocId, r.sections);
                } catch (e) {
                  setTocs(await api('/import/toc'));                 // 失敗就抓回真實狀態
                  setTocMsg(m => ({ ...m, [l.id]: e.message || '加入失敗' }));
                }
              };
              const delNode = async (key) => {
                const { tocId, path } = keyToRef(key);
                if (!path.length) return;
                setItems(a => a.filter(x => !(String(x.key) === String(key) || String(x.key).startsWith(key + '.'))));
                // 一樣先讓畫面立刻反應
                const row = tocs.find(r => r.id === tocId);
                if (row) {
                  const clone = JSON.parse(JSON.stringify(row.sections || []));
                  let list = clone;
                  for (const i of path.slice(0, -1)) { list[i].children = list[i].children || []; list = list[i].children; }
                  list.splice(path[path.length - 1], 1);
                  patchToc(tocId, clone);
                }
                try {
                  const r = await api(`/import/toc-node?id=${tocId}&path=${path.join(',')}`, { method: 'DELETE' });
                  if (r?.sections) patchToc(tocId, r.sections);
                } catch { setTocs(await api('/import/toc')); }
              };

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
                      {n.depth < 2 && (
                        <button className="icon-btn" style={{ padding: 2, fontSize: 12 }} title={n.depth === 0 ? '自己加一個節' : '自己加一個主題'}
                          onClick={() => { setExpanded(x => ({ ...x, [n.key]: true })); setAdding(a => ({ ...a, [n.key]: !a[n.key] })); }}>
                          ＋{n.depth === 0 ? '節' : '主題'}
                        </button>
                      )}
                      {n.depth > 0 && (
                        <button className="icon-btn" style={{ padding: 2, fontSize: 12 }} title="這其實是獨立單元，不屬於這一章 → 拉出來自成一章"
                          onClick={() => promote(n.key)}>⤴獨立</button>
                      )}
                      {n.depth > 0 && (
                        <button className="icon-btn" style={{ padding: 2, fontSize: 12 }} title="刪掉這一個"
                          onClick={() => delNode(n.key)}>✕</button>
                      )}
                      {it && timed && <>
                        <input type="number" min="10" step="10" value={it.minutes} style={{ width: 66 }}
                          onChange={e => setItems(a => a.map(x => x.key === it.key ? { ...x, minutes: +e.target.value || 0 } : x))}
                          onBlur={e => { const v = +e.target.value; if (v && v !== (levelMin[it.level] ?? null)) changeMinutes(it, v); }} />
                        <span className="muted">分</span>
                      </>}
                    </div>
                    {adding[n.key] && n.depth < 2 && (
                      <div className="row" style={{ marginTop: 4, marginLeft: 20, gap: 6, alignItems: 'flex-start' }}>
                        <textarea autoFocus rows={Math.min(4, (addDraft[n.key] || '').split('\n').length)}
                          placeholder={n.depth === 0 ? '節名，一行一個' : '主題名，一行一個'}
                          value={addDraft[n.key] || ''} style={{ flex: 1, minWidth: 0, resize: 'none' }}
                          onChange={e => setAddDraft(d => ({ ...d, [n.key]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNode(n); } }} />
                        <button className="btn sm" onClick={() => addNode(n)}>加入</button>
                        <button className="btn sm ghost" onClick={() => setAdding(a => ({ ...a, [n.key]: false }))}>取消</button>
                      </div>
                    )}
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
                      📷 {rows.length ? '重拍' : '拍課本目錄'}
                      <input type="file" multiple disabled={tocBusy !== null} accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => uploadTOC(l, e, 'replace')} />
                    </label>
                    {rows.length > 0 && (
                      <label className="btn sm ghost" style={{ opacity: tocBusy === l.id ? .5 : 1 }}>
                        ➕ 加一本
                        <input type="file" multiple disabled={tocBusy !== null} accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => uploadTOC(l, e, 'newbook')} />
                      </label>
                    )}
                  </div>
                  {rows.length > 0 && (
                    <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                      {subjectLevels(l).map(lv => (
                        <button key={lv} className="btn sm ghost" onClick={() => selectLevel(l, lv)}>全選{lv}</button>
                      ))}
                      <button className="btn sm ghost" onClick={() => setItems(a => a.filter(x => !(x.subject_id === l.id && String(x.key).startsWith('toc-'))))}>清除</button>
                    </div>
                  )}
                  {tocMsg[l.id] && <div className="muted" style={{ marginTop: 4 }}>{tocMsg[l.id]}</div>}
                  {bookGroups.map(([bk, rws]) => (
                    editBook === `${l.id}|${rws[0].id}` ? (
                      // 編輯模式：獨立一行（不放在可收合標題裡，才不會一點就收合／跳掉焦點）
                      // 打完按「完成」才存，中途切換欄位不會被打斷
                      <div key={'edit' + rws[0].id} className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                        <span>📘</span>
                        <input autoFocus value={bookDraft?.book ?? ''} placeholder="書名"
                          onChange={e => setBookDraft(d => ({ ...d, book: e.target.value }))}
                          style={{ fontWeight: 600, fontSize: 14, flex: '1 1 45%', minWidth: 90, padding: '4px 8px' }} />
                        <input value={bookDraft?.publisher ?? ''} placeholder="出版社"
                          onChange={e => setBookDraft(d => ({ ...d, publisher: e.target.value }))}
                          style={{ fontSize: 13, flex: '1 1 30%', minWidth: 80, padding: '4px 8px' }} />
                        <button className="btn sm ghost" onClick={() => { setEditBook(null); setBookDraft(null); }}>取消</button>
                        <button className="btn sm" onClick={() => {
                          const patch = {};
                          if ((bookDraft?.book || '').trim() !== bk) patch.newBook = (bookDraft?.book || '').trim();
                          if ((bookDraft?.publisher || '').trim() !== (rws[0]?.publisher || '')) patch.publisher = (bookDraft?.publisher || '').trim();
                          setEditBook(null); setBookDraft(null);
                          if (Object.keys(patch).length) saveBook(bk, patch);
                        }}>完成</button>
                      </div>
                    ) : (
                      <details key={bk || '_none'} style={{ marginTop: 6 }}>
                        {/* 平常是一行純文字（不佔格子）；按 ✎ 才切成上面的編輯模式 */}
                        <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                          <span style={{ flex: 1, fontSize: 14, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            📘 <b>{bk || '未命名課本'}</b>
                            <span className="muted" style={{ fontSize: 12 }}>{rws[0]?.publisher ? `・${rws[0].publisher}` : ''}・{rws.length} 章</span>
                          </span>
                          {/* 多本書時可以決定先排哪一本（順序徽章不放進會截斷的書名列） */}
                          {bookGroups.length > 1 && <>
                            <span className="chip" title="排的順序" style={{ whiteSpace: 'nowrap' }}>
                              第{bookGroups.findIndex(([k]) => k === bk) + 1}本
                            </span>
                            <button className="icon-btn" title="早一點排這本" style={{ padding: 2, opacity: bookGroups[0][0] === bk ? .3 : 1 }}
                              onClick={e => { e.preventDefault(); e.stopPropagation(); moveBook(bk, -1); }}>↑</button>
                            <button className="icon-btn" title="晚一點排這本" style={{ padding: 2, opacity: bookGroups[bookGroups.length - 1][0] === bk ? .3 : 1 }}
                              onClick={e => { e.preventDefault(); e.stopPropagation(); moveBook(bk, 1); }}>↓</button>
                          </>}
                          {/* 補「這一本」的後幾頁：掛在該書底下，不會跟別本混在一起 */}
                          <label className="icon-btn" title={`補「${bk || '這本'}」的後幾頁`} style={{ padding: 2, cursor: 'pointer', opacity: tocBusy === l.id ? .4 : 1 }}
                            onClick={e => e.stopPropagation()}>＋頁
                            <input type="file" multiple disabled={tocBusy !== null} accept="image/*,.pdf" style={{ display: 'none' }}
                              onChange={e => uploadTOC(l, e, { book: bk })} />
                          </label>
                          <button className="icon-btn" title="改書名／出版社" style={{ padding: 2 }}
                            onClick={e => {
                              e.preventDefault(); e.stopPropagation();
                              setBookDraft({ book: bk, publisher: rws[0]?.publisher || '' });
                              setEditBook(`${l.id}|${rws[0].id}`);
                            }}>✎</button>
                          <button className="icon-btn" title="整本刪除" style={{ padding: 2 }}
                            onClick={e => { e.preventDefault(); e.stopPropagation(); delBook(bk, rws); }}>✕</button>
                        </summary>
                        {rws.map(chapterNode).map(renderNode)}
                      </details>
                    )
                  ))}
                  <div className="row" style={{ marginTop: 8 }}>
                    <input placeholder="手動輸入範圍（如 p.20-35）" value={rangeInput[l.id] || ''} onChange={e => setRangeInput(r => ({ ...r, [l.id]: e.target.value }))} style={{ flex: 1, fontSize: 14 }} />
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
              <button className="btn" disabled={!items.length} onClick={() => setStep(1)}>下一步：怎麼安排（已選 {items.length} 項）</button>
            </div>
            </>)}
          </div>
        )}

        {/* ============ 步驟 2 之三：排程條件（題型與偏好） ============ */}
        {step === 1 && (() => {
          const sids = [...new Set(items.map(i => i.subject_id))];
          // 用字串比對：下拉選單回傳的是字串，科目 id 是數字，直接 === 會找不到名字
          const sname = sid => lists.find(l => String(l.id) === String(sid))?.name || '';
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
                  <label style={{ display: 'block' }}><input type="radio" checked={cb === 'together'} onChange={() => onCb('together')} /> 一起寫</label>
                  <label style={{ display: 'block' }}><input type="radio" checked={cb === 'separate'} onChange={() => onCb('separate')} /> 全部分開</label>
                  <label style={{ display: 'block' }}><input type="radio" checked={cb === 'custom'} onChange={() => onCb('custom')} /> 自訂組合</label>
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
            <details className="tile" id="wz-sec-cond" open={initialSection === 'cond'} style={{ marginBottom: 10 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700 }}>排程條件</summary>

              {/* 科目先後順序（2C-P6-B）。用上下移動而不是拖曳：
                  HTML5 drag 在手機上不可靠，而這一頁主要是在手機上用的。 */}
              {sids.length > 1 && (
                <>
                  <b style={{ display: 'block', marginTop: 8 }}>先讀哪一科？</b>
                  <Help>
                    排在前面的科目會優先拿到比較早的排程位置。<br />
                    這<b>不是</b>「前一科讀完才能開始下一科」——各科還是每天輪流進行，
                    只是誰先出手照你排的順序。
                  </Help>
                  <div style={{ marginTop: 6 }}>
                    {orderedSubjectIds.map((sid, i) => (
                      <div className="row" key={sid} style={{ marginTop: 4 }}>
                        <span className="muted" style={{ width: 20 }}>{i + 1}.</span>
                        <span className="tag" style={{ background: lists.find(l => String(l.id) === String(sid))?.color, color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>{sname(sid)}</span>
                        <span style={{ marginLeft: 'auto' }} />
                        <button className="btn sm ghost subj-move" aria-label={`把${sname(sid)}往前移`}
                          disabled={i === 0} onClick={() => moveSubject(sid, -1)}>↑</button>
                        <button className="btn sm ghost subj-move" aria-label={`把${sname(sid)}往後移`}
                          disabled={i === orderedSubjectIds.length - 1} onClick={() => moveSubject(sid, 1)}>↓</button>
                      </div>
                    ))}
                  </div>
                  {subjOrder.length > 0 && (
                    <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setSubjOrder([])}>
                      取消指定順序
                    </button>
                  )}
                </>
              )}

              <b style={{ display: 'block', marginTop: 16 }}>各科的章節要打散還是照順序？</b>
              {/* 跟著上面排好的順序走：使用者剛把英文移到第一，下面卻還是舊順序，
                  會讓人以為順序沒生效。 */}
              {orderedSubjectIds.map(sid => (
                <div key={sid} style={{ marginTop: 8 }}>
                  <div className="row">
                    <span className="tag" style={{ background: lists.find(l => l.id === sid)?.color, color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>{sname(sid)}</span>
                    <label><input type="radio" checked={(subjSpread[sid] ?? 'order') === 'order'} onChange={() => setSubjSpread(s => ({ ...s, [sid]: 'order' }))} /> 照章節順序（預設）</label>
                    <label><input type="radio" checked={subjSpread[sid] === 'spread'} onChange={() => setSubjSpread(s => ({ ...s, [sid]: 'spread' }))} /> 打散平均</label>
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

              <b style={{ display: 'block', marginTop: 16 }}>教材題型</b>
              <Help>
                已預設好：範例+例題一組、單元練習+歷屆試題一組（以「章」為單位，每章一份）。<br />
                不用改就能直接下一步；想調整再展開各科設定。<br />
                ・一起寫＝每章一個時段做完所有題型<br />
                ・全部分開＝每種題型自己一段<br />
                ・自訂組合＝自己決定哪幾種併一組（如範例+例題）<br />
                ・各單元設定：點題型循環 要排 → 先完成 → 壓軸 → 不寫；<br />
                　模考類點「純題目」那顆：壓軸 → 先完成 → 照常 → 取消
              </Help>
              {sids.map(sid => {
                // 指到已不存在的科目就當作「自己設定」，否則會卡在「使用「」的設定」改不掉
                const raw = typeRef[sid];
                const ref = raw && raw !== 'self' && sids.some(s2 => String(s2) === String(raw)) ? raw : null;
                return (
                  <div key={sid} style={{ marginTop: 10, borderLeft: `3px solid ${lists.find(l => l.id === sid)?.color}`, paddingLeft: 8 }}>
                    <div className="row">
                      <b>{sname(sid)}</b>
                      {/* 每一科都要能選（第一科也是），不然設錯了救不回來 */}
                      <select value={ref == null ? 'self' : String(ref)} onChange={e => setTypeRef(s => ({ ...s, [sid]: e.target.value }))}>
                        <option value="self">自己設定</option>
                        {sids.filter(s2 => String(s2) !== String(sid) && !(typeRef[s2] && typeRef[s2] !== 'self')).map(s2 =>
                          <option key={s2} value={String(s2)}>跟「{sname(s2)}」一樣</option>)}
                      </select>
                    </div>
                    {ref
                      ? <div className="muted" style={{ marginTop: 4 }}>＝ 使用「{sname(ref)}」的題型設定</div>
                      : <TypePanel ts={typesBy[sid] ?? DEF_TYPES} cb={combineBy[sid] ?? DEF_COMBINE} tg={typeGroupBy[sid] ?? DEF_TG}
                        onTs={v => setTypesBy(s => ({ ...s, [sid]: v }))}
                        onCb={v => setCombineBy(s => ({ ...s, [sid]: v }))}
                      onTg={v => setTypeGroupBy(s => ({ ...s, [sid]: v }))} />}
                  </div>
                );
              })}

              {(() => {
                const chapTitle = {};
                tocs.forEach(r => { chapTitle[`toc-${r.id}`] = r.title; });
                // 這個單元屬於哪一本書：同一科有多本課本時要標出來，才不會搞混
                const bookByToc = {};
                tocs.forEach(r => { bookByToc[`toc-${r.id}`] = r.book || ''; });
                const bookOf = key => bookByToc[String(key).split('+')[0].split('.')[0]] || '';
                const isMultiBook = sid => new Set(tocs.filter(t => t.list_id === sid).map(t => t.book || '')).size > 1;
                // 純題目獨立一顆（五段全擠一顆要點太多次）：
                // 沒標＝灰色；點了循環 壓軸(預設・紺青) → 先完成 → 照常 → 取消回到題型
                const plainCycle = it => {
                  const on = !!plainSel[it.key];
                  const mode = !on ? null : finals[it.key] ? 'final' : firstsSel[it.key] ? 'first' : 'norm';
                  const st = !on ? {}
                    : mode === 'final' ? { background: '#192F60', color: '#fff' }
                    : mode === 'first' ? { background: '#8AC4DE', color: '#fff' }
                    : { background: '#0086CC', color: '#fff' };
                  const onClick = () => {
                    if (!on) { setPlainSel(f => ({ ...f, [it.key]: true })); setFinals(f => ({ ...f, [it.key]: true })); setFirstsSel(f => ({ ...f, [it.key]: false })); }
                    else if (mode === 'final') { setFinals(f => ({ ...f, [it.key]: false })); setFirstsSel(f => ({ ...f, [it.key]: true })); }
                    else if (mode === 'first') { setFirstsSel(f => ({ ...f, [it.key]: false })); }
                    else { setPlainSel(f => ({ ...f, [it.key]: false })); }
                  };
                  return (
                    <label className="tag-pill" style={{ cursor: 'pointer', ...st }} onClick={onClick}>
                      純題目{mode === 'final' ? '・壓軸' : mode === 'first' ? '・先完成' : mode === 'norm' ? '・照常' : ''}
                    </label>
                  );
                };
                // 題型 pill（單元與章共用）：四段循環 要排→先完成→壓軸→不寫
                const pill = (key, label) => {
                  const m = skipTypes[key];
                  const next = m === undefined ? 'first' : m === 'first' ? 'final' : m === 'final' ? 'off' : undefined;
                  const st = m === 'off' ? { textDecoration: 'line-through', opacity: .55 }
                    : m === 'first' ? { background: '#8AC4DE', color: '#fff' }
                    : m === 'final' ? { background: '#005B98', color: '#fff' }
                    : { background: '#0086CC', color: '#fff' };
                  return (
                    <label key={key} className="tag-pill" style={{ cursor: 'pointer', ...st }}
                      onClick={() => setSkipTypes(s => { const n = { ...s }; if (next) n[key] = next; else delete n[key]; return n; })}>
                      {label}{m === 'first' ? '・先完成' : m === 'final' ? '・壓軸' : m === 'off' ? '・不寫' : ''}
                    </label>
                  );
                };
                // 沒設定題型的科目用這組當後備（先完成/壓軸切換；純題目那顆共用 plainCycle）
                const ffPills = it => <>
                  <label className={'tag-pill' + (firstsSel[it.key] ? ' on' : '')} style={{ cursor: 'pointer' }}
                    onClick={() => { setFirstsSel(f => ({ ...f, [it.key]: !f[it.key] })); setFinals(f => ({ ...f, [it.key]: false })); }}>先完成</label>
                  <label className={'tag-pill' + (finals[it.key] ? ' on' : '')} style={{ cursor: 'pointer' }}
                    onClick={() => { setFinals(f => ({ ...f, [it.key]: !f[it.key] })); setFirstsSel(f => ({ ...f, [it.key]: false })); }}>壓軸</label>
                </>;
                // 三層收合：科目 → 書名 → 單元（都點一下展開）
                const blocks = sids.map(sid => {
                  const l = lists.find(x => x.id === sid);
                  if (!l) return null;
                  const ord = {}; allNodes(l).forEach((n, i) => { ord[n.key] = i; });
                  const subjItems = items.filter(it => it.subject_id === sid)
                    .sort((a, b) => (ord[String(a.key).split('+')[0]] ?? 9999) - (ord[String(b.key).split('+')[0]] ?? 9999));
                  if (!subjItems.length) return null;
                  const nodeGs = groupsFor(sid).map((g, gi) => [g ? g.filter(t => !CH_TYPES.includes(t)) : [], gi]).filter(([gn]) => gn.length);
                  const chapGs = groupsFor(sid).map((g, gi) => [g ? g.filter(t => CH_TYPES.includes(t)) : [], gi]).filter(([gc]) => gc.length);
                  // 依書分組（手動輸入的範圍歸「手動範圍」）
                  const byBook = new Map();
                  subjItems.forEach(it => {
                    const bk = String(it.key).startsWith('toc-') ? (bookOf(it.key) || '未命名課本') : '手動範圍';
                    if (!byBook.has(bk)) byBook.set(bk, []);
                    byBook.get(bk).push(it);
                  });
                  const bookBlocks = [...byBook.entries()].map(([bk, list]) => {
                    const unitRows = list.map(it => (
                      <div key={'sk' + it.key} style={{ marginTop: 8 }}>
                        <div>{it.title}</div>
                        <div className="row" style={{ marginLeft: 12, marginTop: 3 }}>
                          {!plainSel[it.key] && (nodeGs.length ? nodeGs.map(([gn, gi]) => pill(`${it.key}|${gi}`, gn.join('+'))) : ffPills(it))}
                          {plainCycle(it)}
                        </div>
                      </div>
                    ));
                    const seenCh = new Set();
                    const chapRows = [];
                    if (chapGs.length) list.filter(it => !plainSel[it.key]).forEach(it => {
                      const base = String(it.key).split('+')[0].split('.')[0];
                      const chKey = base.startsWith('toc-') ? base : String(it.key);
                      if (seenCh.has(chKey)) return;
                      seenCh.add(chKey);
                      chapRows.push(
                        <div key={'ch' + chKey} style={{ marginTop: 8 }}>
                          <div>{chapTitle[chKey] || it.title}</div>
                          <div className="row" style={{ marginLeft: 12, marginTop: 3 }}>{chapGs.map(([gc, gi]) => pill(`ch:${chKey}|${gi}`, gc.join('+')))}</div>
                        </div>
                      );
                    });
                    return (
                      <details key={'bk' + sid + bk} style={{ marginTop: 6, marginLeft: 6 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 14 }}>
                          📘 <b>{bk}</b> <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{list.length} 個單元</span>
                        </summary>
                        <div style={{ marginLeft: 10 }}>
                          {unitRows}
                          {chapRows.length > 0 && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>每章一份：</div>}
                          {chapRows}
                        </div>
                      </details>
                    );
                  });
                  return (
                    <details key={'skb' + sid} style={{ marginTop: 8, paddingLeft: 10, borderLeft: `3px solid ${l.color}` }}>
                      <summary style={{ cursor: 'pointer' }}>
                        <span className="tag" style={{ background: l.color, color: '#fff', padding: '2px 10px', borderRadius: 999, fontSize: 12 }}>{l.name}</span>
                        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>{byBook.size > 1 ? `${byBook.size} 本・` : ''}{subjItems.length} 個單元</span>
                      </summary>
                      {bookBlocks}
                    </details>
                  );
                }).filter(Boolean);
                if (!blocks.length) return null;
                return <>
                  <b style={{ display: 'block', marginTop: 16 }}>各單元設定</b>
                  <div className="muted" style={{ fontSize: 12 }}>點題型可循環切換狀態（說明看上面的 ⓘ）</div>
                  {blocks}
                </>;
              })()}

            </details>
          );
        })()}

        {/* ============ 步驟 2 之四：完成期限 ============ */}
        {step === 1 && (
          <details className="tile" id="wz-sec-deadline" open={initialSection !== 'time' && initialSection !== 'cond'} style={{ marginBottom: 10 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 700 }}>完成期限</summary>
            <div className="row">
              <label>整體範圍：</label>
              <input type="date" value={dGlobal.start} onChange={e => setDGlobal(d => ({ ...d, start: e.target.value }))} />
              <span>–</span>
              <input type="date" value={dGlobal.end} onChange={e => setDGlobal(d => ({ ...d, end: e.target.value }))} />
              {dGlobal.start !== today() && <button className="btn sm ghost" onClick={() => setDGlobal(d => ({ ...d, start: today() }))}>從今天</button>}
            </div>
            <Help>
              開始日預設今天（可改）。<br />
              底下各科／各題型都跟著整體範圍，改過的才會固定住（按「跟整體」還原）。
            </Help>

            {leftover.length > 0 && (
              <div className="tile" style={{ marginTop: 12, padding: '8px 12px', background: 'var(--fill)' }}>
                <div style={{ marginBottom: 4 }}>
                  {isEdit ? '這個計畫' : '上次'}還有 <b>{leftover.length}</b> 項沒做完
                </div>
                <label style={{ display: 'block' }}>
                  <input type="radio" name="wz-redo" checked={redoUndone} onChange={() => setRedoUndone(true)} /> 一起重新安排
                </label>
                <label style={{ display: 'block' }}>
                  <input type="radio" name="wz-redo" checked={!redoUndone} onChange={() => setRedoUndone(false)} /> 維持原本日期不動
                </label>
              </div>
            )}

            {doneItems.length > 0 && (
              <div className="tile" style={{ marginTop: 12, padding: '8px 12px', background: 'var(--fill)' }}>
                <div style={{ marginBottom: 4 }}>已完成 <b>{doneItems.length}</b> 項，不會再排進來</div>
                <label style={{ display: 'block' }}>
                  <input type="checkbox" checked={redoDone} onChange={e => setRedoDone(e.target.checked)} /> 想重讀一次，也一起排
                </label>
              </div>
            )}

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
          </details>
        )}

        {/* 第 2 步的共同結尾：不管展開哪一段，產生排程都在這裡 */}
        {step === 1 && (
          <>
            {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setStep(0)}>上一步</button>
              <button className="btn" onClick={genPreview}>產生排程</button>
            </div>
          </>
        )}

        {/* ============ 步驟 3：AI 排程結果 ============ */}
        {step === 2 && preview && (
          <div className="tile">
            {/* 目前是哪一種安排，結果頁要一直看得到（不是看法，是排法） */}
            <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
              <span className="chip">{timed ? '時間排程' : '每日待辦'}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {timed ? '已排到幾點到幾點' : '只列出每天要做什麼'}
              </span>
              <span className="row" style={{ marginLeft: 'auto', gap: 4 }}>
                {/* 只是換看法，不會改變排法 */}
                <button className={'btn sm' + (resultView === 'list' ? '' : ' ghost')} onClick={() => setResultView('list')}>清單</button>
                <button className={'btn sm' + (resultView === 'cal' ? '' : ' ghost')} onClick={() => setResultView('cal')}>日曆</button>
              </span>
            </div>
            {preview.check && (
              <div style={{ background: 'var(--fill)', borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
                <span className="muted">
                  ✓ 已自我檢查：每日 {preview.check.dailyMin}～{preview.check.dailyMax} 項
                  {(!preview.check.warnings || !preview.check.warnings.length) && '，各科分佈正常'}
                </span>
                {(preview.check.subjects || []).length > 0 && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    {preview.check.subjects.map(s => {
                      const nm = lists.find(l => l.id === s.subject_id)?.name || '?';
                      const span = `${s.first.slice(5).replace('-', '/')}–${s.last.slice(5).replace('-', '/')}`;
                      // 把公式攤開給你看：全部天數 －（單元練習/歷屆份數）＝ 節可用的天數
                      const f = s.one > 0 && s.sec > 0
                        ? `　${s.totalDays}天−${s.one}份練習/歷屆=${s.secDays}天排${s.sec}個節（一天${s.secMin === s.secMax ? s.secMax : `${s.secMin}~${s.secMax}`}個）`
                        : '';
                      return <div key={s.subject_id}>{nm} {span}（{s.count}項）{f}</div>;
                    })}
                  </div>
                )}
                {/* 哪幾科把每天塞爆的：直接指出要延長哪一科、延到幾天 */}
                {(preview.check.subjects || []).filter(s => s.secMax >= 3 && s.wantDays > s.availDays)
                  .sort((a, b) => b.secMax - a.secMax || b.sec - a.sec).slice(0, 3).map(s => (
                    <div key={'a' + s.subject_id} style={{ marginTop: 4, color: 'var(--orange, #C46A22)' }}>
                      ⚠️ {lists.find(l => l.id === s.subject_id)?.name || '有一科'}一天要排 {s.secMin === s.secMax ? s.secMax : `${s.secMin}~${s.secMax}`} 個節：
                      共 {s.sec} 個節，但扣掉 {s.one} 天的單元練習／歷屆後只剩 {s.secDays} 天。
                      這科延長到 {s.wantDays} 天（目前 {s.availDays} 天，再加 {s.wantDays - s.availDays} 天）就會變成一天 2 個。
                    </div>
                  ))}
                {(preview.check.tight || []).map((t, i) => (
                  <div key={'t' + i} style={{ marginTop: 4, color: 'var(--orange, #C46A22)' }}>
                    ⚠️ {lists.find(l => l.id === t.subject_id)?.name || '有一科'}的日期範圍太短：只有 {t.haveDays} 天，
                    最擠的一天要排 {t.maxPerDay} 項。
                    {t.oneMax > 2 && `單元練習／歷屆試題最多一天兩份，這科有 ${t.oneCount} 份、天數真的不夠，只好有幾天擠了 ${t.oneMax} 份——請把「單元練習／歷屆試題」那一組的日期範圍拉長到至少 ${Math.ceil(t.oneCount / 2)} 天。`}
                    大約需要 {t.needDays} 天，建議把結束日往後延 {t.needDays - t.haveDays} 天，或這次先少選一些單元／少選一本書。
                  </div>
                ))}
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
                <FeasibilityGap feasibility={preview.feasibility} />
                <div className="muted">想怎麼處理？</div>
                <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => setStep(0)}>刪掉一些內容</button>
                  <button className="btn sm ghost" onClick={() => setStep(1)}>增加讀書天數/延長日期</button>
                  {timed && <button className="btn sm ghost" onClick={() => { setTimed(false); genPreview(); }}>改成「不計時、只排進度」</button>}
                </div>
              </div>
            )}
            {resultView === 'list'
              ? Object.entries(byDate).map(([d, list]) => (
                <div key={d} style={{ marginBottom: 10 }}>
                  <b>{d}（週{WD[new Date(d + 'T00:00:00').getDay()]}）</b>
                  {list.map((b, i) => {
                    const l = lists.find(x => String(x.id) === String(b.subject_id)); // 字串/數字都對得到，顏色不會消失
                    return <div key={i} className="row" style={{ marginTop: 4 }}>
                      {b.start_time && <span className="muted">{b.start_time}–{b.end_time}</span>}
                      <span style={{ color: l?.color }}>■</span><span>{l?.name}｜{b.title}</span>
                    </div>;
                  })}
                </div>
              ))
              : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
                  {[0, 1, 2, 3, 4, 5, 6].map(w => (
                    <div key={'h' + w} className="muted" style={{ fontSize: 11, textAlign: 'center' }}>{WD[w]}</div>
                  ))}
                  {calCells.map((c, i) => (
                    <div key={i} style={{ minHeight: 52, border: '1px solid var(--border)', borderRadius: 6, padding: 3, opacity: c.date ? 1 : .25 }}>
                      {c.date && <>
                        <div style={{ fontSize: 11, fontWeight: 600 }}>{+c.date.slice(8)}</div>
                        {c.list.slice(0, 3).map((b, j) => {
                          const l = lists.find(x => String(x.id) === String(b.subject_id));
                          return <div key={j} style={{ fontSize: 10, color: l?.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {b.start_time ? `${b.start_time} ` : ''}{b.title}
                          </div>;
                        })}
                        {c.list.length > 3 && <div className="muted" style={{ fontSize: 10 }}>＋{c.list.length - 3}</div>}
                      </>}
                    </div>
                  ))}
                </div>
              )}
            <div className="tile" style={{ marginTop: 14, padding: '10px 12px', background: 'var(--fill)' }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>這份計畫要叫什麼？</div>
              <input aria-label="計畫名稱" value={planNameInput} onChange={e => setPlanNameInput(e.target.value)}
                placeholder="計畫名稱" style={{ width: '100%' }} />
            </div>
            {isEdit && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                這只是預覽，按下「套用新版安排」之前，原本的計畫不會有任何改變
              </div>
            )}
            {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setStep(1)}>不滿意，重新調整</button>
              <button className="btn" disabled={saving} onClick={confirm}>
                {saving ? (isEdit ? '套用中…' : '建立中…')
                  : isEdit ? `套用新版安排（${preview.blocks.length} ${timed ? '段' : '項'}）`
                    : `滿意，加入待辦（${preview.blocks.length} ${timed ? '段' : '項'}）！`}
              </button>
            </div>
            {applied && (
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                已套用：保留 {applied.updated} 項、新增 {applied.created} 項
                {applied.removed ? `、移除 ${applied.removed} 項` : ''}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
