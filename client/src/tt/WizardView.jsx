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
import { listBooks, getPlanSelection, selectItems, materialSchedulingItems, createSubject } from './material';
import { Button } from './ui';

const LIST_COLORS = ['#0086CC', '#e03131', '#16a34a', '#f59f00', '#9333ea', '#0891b2'];
// 合理預設：不調整也能直接產生——範例+例題一組、單元練習+歷屆試題一組
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
  // 正式 Material 選取。Create 模式是草稿（Plan 還不存在），Edit 模式直接寫正式 API。
  const [matIds, setMatIds] = useState(() => new Set());
  const [matPicked, setMatPicked] = useState(() => new Map()); // id → descriptor
  const [matBooks, setMatBooks] = useState([]);
  const [subjSpread, setSubjSpread] = useState({});   // 每科：章節打散(spread)或照順序(order)
  const [exWd, setExWd] = useState([]);               // 不排的星期 0-6
  const [exDates, setExDates] = useState([]);         // 不排的日期
  const [exDateInput, setExDateInput] = useState(today());
  const [busyHours, setBusyHours] = useState(0);      // 既定行程超過幾小時就不排（0=不限）
  const [timed, setTimed] = useState(true);           // 是否計算時間
  const [limitPerDay, setLimitPerDay] = useState(false); // 不計時模式是否限制每天數量
  const [perDay, setPerDay] = useState(3);            // 每天幾項
  const [pace, setPace] = useState('even');           // even=平均分配 front=盡早排完（前面多排）
  // 科目先後順序（2C-P6-B）：使用者排「數學 → 化學 → 英文」。
  // 語意是 priority 不是 dependency——優先取得排程位置，但不要求前一科排完
  // 才能開始下一科。存的是科目 id 由前到後。
  const [subjOrder, setSubjOrder] = useState([]);
  const [bySubject, setBySubject] = useState(false);
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
        d.subjSpread && setSubjSpread(d.subjSpread);
        d.exWd && setExWd(d.exWd);
        d.exDates && setExDates(d.exDates);
        d.busyHours != null && setBusyHours(d.busyHours);
        d.timed != null && setTimed(d.timed);
        d.limitPerDay != null && setLimitPerDay(d.limitPerDay);
        d.perDay != null && setPerDay(d.perDay);
        d.pace && setPace(d.pace);
        Array.isArray(d.subjOrder) && setSubjOrder(d.subjOrder);
        d.bySubject != null && setBySubject(d.bySubject);
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
  // （舊版第 1 步的科目顏色同步已經不需要：教材選取的顏色一律當場從
  //   lists 取，不會有一份存在草稿裡、跟著過期的副本。）
  useEffect(() => {
    if (!draftLoaded.current) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({
        subjSpread, exWd, exDates, busyHours, timed, limitPerDay, perDay, pace, subjOrder,
        bySubject, dGlobal, dMap, step,
      }));
    } catch {}
  }, [draftKey, subjSpread, exWd, exDates, busyHours, timed, limitPerDay, perDay, pace, subjOrder,
    bySubject, dGlobal, dMap, step]);

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

  // 各科的日期：只有「使用者自己動過的那一欄」才記在 dMap，
  // 其他一律跟著整體範圍走（改整體範圍時會自動跟著變）
  const mergeWin = k => {
    const o = dMap[k] || {};
    return { start: o.start || dGlobal.start, end: o.end || dGlobal.end };
  };

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
  // 生物舊預設色（青藍/藍）跟英文太像：既有清單若還是舊色就自動改黃
  useEffect(() => {
    lists.filter(l => l.name === '生物' && ['#0891b2', '#0086CC'].includes(l.color))
      .forEach(l => api(`/lists/${l.id}`, { method: 'PATCH', body: { color: '#eab308' } }).then(reload).catch(() => {}));
  }, [lists.length]);
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

  // Edit Mode：名稱直接帶既有的計畫名稱，學生改完就存回同一個計畫。
  useEffect(() => {
    if (isEdit && planTitle) setPlanNameInput(n => (n ? n : planTitle));
  }, [isEdit, planTitle]);

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


  /* ---------- 科目先後順序 ---------- */
  // 這次真的選到的科目（去重，維持出現順序）
  // 這次真的選到的科目：直接來自教材選取。
  const selectedSubjectIds = [...new Set(materialItems.map(i => i.subject_id))];
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
    // 使用者自己設的日期範圍不一定合理：顛倒、只填一邊、整段已經過去。
    // 這些情況一律退回整體範圍，不要讓排程拿著一個排不出東西的窗口去試。
    const fixWin = w => {
      let { start, end } = w || {};
      if (!start || !end) return { start: dGlobal.start, end: dGlobal.end };
      if (start > end) [start, end] = [end, start];
      if (end < today()) return { start: dGlobal.start, end: dGlobal.end };
      return { start, end };
    };
    // 這次要排的項目。Material 的 ContentItem 本身就是原子單位（某一份單元練習、
    // 某一題例題），一項對一項直接產生排程項目，不需要舊版的「題型展開」——
    // 那是為了把抽象的章節拆成可排的份數而存在的。
    const expanded2 = [];
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
        start: w.start, end: w.end,
        // 第 2 步的「打散平均／照章節順序」。後端 routes/schedule.js 讀 item.spread：
        // false＝照順序（同科目照原本的排列），true＝打散。之前這裡寫死 false，
        // 於是那組選項按了完全沒有作用。
        spread: (subjSpread[m.subject_id] ?? 'order') === 'spread',
        material_content_item_id: m.material_content_item_id,
      });
    }
    setMergedLeftover(merged2);
    // 已經打勾完成的不要再排一次（想重讀才勾「已完成的也重排」）。
    // 同一科＋同一個標題才算同一件事，不同科目撞名不會誤刪。
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
      // 計畫名稱是學生在第 1 步自己打的，產生預覽**不覆寫**它。
      // 真的留白時才在送出當下退回一個自動名稱（見 confirm()）。
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

        {/* ============ 步驟 1：讀什麼 ============
            學生只需要理解兩件事：這次要準備什麼、要讀哪些內容。
            教材從哪裡來、怎麼記的，是系統自己的事，不出現在這個畫面上。 */}
        {step === 0 && (
          <MaterialSelector
            planId={isEdit ? planId : null}
            draftIds={matIds}
            onDraftChange={setMatIds}
            onPickedChange={onMaterialPicked}
            lists={lists}
            onLibraryChange={() => { listBooks().then(setMatBooks).catch(() => {}); }}
            onAddSubject={async name => {
              const created = await createSubject(name);
              await reload();          // 讓科目立刻出現在整個 App，不只這個畫面
              return created;
            }}
            header={
              <div className="wz-plan-name">
                <label htmlFor="wz-plan-name">這次要準備什麼？</label>
                <input id="wz-plan-name" value={planNameInput}
                  placeholder="第一次段考、下週數學小考"
                  onChange={e => setPlanNameInput(e.target.value)} />
              </div>
            }
            footer={
              <>
                {matNoSubject.length > 0 && (
                  <div className="mt-source-note" role="alert">
                    這些教材還沒有指定科目，所以無法排入計畫：
                    {matNoSubject.map(b => `${b.book_title}（已選 ${b.count} 項）`).join('、')}。
                    請先到「更多 → 教材庫」為它們設定科目，再回來排程。
                  </div>
                )}
                {/* 用 Design System 的 Button：舊的 .btn 沒有 :disabled 樣態，
                    停用時看起來仍像可按，使用者只會覺得「按了沒反應」。 */}
                <Button variant="primary" style={{ marginLeft: 'auto' }}
                  disabled={!materialItems.length} onClick={() => setStep(1)}>
                  下一步
                </Button>
              </>
            } />
        )}

        {/* ============ 步驟 2 之三：排程條件 ============ */}
        {step === 1 && (() => {
          // 用字串比對：科目 id 有時是字串有時是數字，直接 === 會找不到名字
          const sname = sid => lists.find(l => String(l.id) === String(sid))?.name || '';
          return (
            <details className="tile" id="wz-sec-cond" open={initialSection === 'cond'} style={{ marginBottom: 10 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700 }}>排程條件</summary>

              {/* 科目先後順序（2C-P6-B）。用上下移動而不是拖曳：
                  HTML5 drag 在手機上不可靠，而這一頁主要是在手機上用的。 */}
              {selectedSubjectIds.length > 1 && (
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
                </div>
              ))}

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
            {bySubject && (
              <div style={{ marginTop: 10 }}>
                {/* 科目清單要跟這次真的選到的教材一致，否則勾了「各科目用不同
                    日期範圍」卻一個欄位都沒出現，看起來就像按了沒反應。 */}
                {selectedSubjectIds.map(sid =>
                  dateInput(`${sid}|all`, lists.find(l => String(l.id) === String(sid))?.name || '全部'))}
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
            {/* 名稱在第 1 步就問過了（「這次要準備什麼？」），不在這裡再問一次 */}
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
