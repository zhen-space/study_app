import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { today, addDays, localISO } from './helpers';
import { PALETTE } from './Icons';
import Icon from './Icons';
import { fileToPayload } from './vocabImport';

const WD = ['一', '二', '三', '四', '五', '六', '日'];
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 06:00–23:00
const ROW = 44;
const H0 = 6;                                       // 時間軸起點小時
const NOW_LINE = '#8AC4DE';                         // 現在時間線：淺天空藍，襯在行程後面
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const yOf = m => (m - H0 * 60) / 60 * ROW;          // 分鐘 → 垂直位置
// 依背景色自動選黑/白字，確保看得清楚
const textOn = hex => {
  if (!hex) return '#111';
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff';
};

// 顏色選擇：白底＋各色系（收合式，點色系名稱展開，才不會把視窗撐到按鈕看不到）
function ColorPicker({ value, onPick }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="muted">顏色</span>
        <span className={'swatch' + (!value ? ' on' : '')} style={{ background: '#fff', border: '1px solid var(--border)' }} title="白底黑字" onClick={() => onPick('')} />
        {value && <span className="swatch on" style={{ background: value }} />}
      </div>
      {PALETTE.map(g => (
        <details key={g.name} open={g.colors.some(([c]) => c === value)} style={{ marginBottom: 4 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
            {g.name}
            <span style={{ display: 'inline-flex', marginLeft: 6, verticalAlign: 'middle' }}>
              {g.colors.filter((_, i) => i % Math.max(1, Math.floor(g.colors.length / 5)) === 0).slice(0, 5).map(([c]) => (
                <span key={c} style={{ width: 10, height: 10, borderRadius: 5, background: c, marginLeft: -2 }} />
              ))}
            </span>
          </summary>
          <div className="swatches" style={{ marginTop: 4 }}>
            {g.colors.map(([c, n]) => (
              <span key={c} title={n} className={'swatch' + (value === c ? ' on' : '')} style={{ background: c }} onClick={() => onPick(c)} />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

export default function CalendarView({ tasks, reload }) {
  const [view, setView] = useState('week'); // day | week | month
  const [anchor, setAnchor] = useState(today());
  // 匯入/新增的既定行程（課表、補習等）：先用上次的快取立即顯示，再背景更新（不用每次等 API）
  const [events, setEvents] = useState(() => {
    try { return JSON.parse(localStorage.getItem('evCache') || '[]'); } catch { return []; }
  });
  // 現在時間（分鐘）：每分鐘更新一次，用來畫「現在」的藍線
  const [nowMin, setNowMin] = useState(() => new Date().getHours() * 60 + new Date().getMinutes());
  useEffect(() => {
    const t = setInterval(() => setNowMin(new Date().getHours() * 60 + new Date().getMinutes()), 30000);
    return () => clearInterval(t);
  }, []);
  const loadEvents = () => api('/events').then(list => {
    setEvents(list);
    try { localStorage.setItem('evCache', JSON.stringify(list)); } catch {}
  }).catch(() => {});
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
    const payload = await fileToPayload(file); // 照片自動縮圖壓縮：不爆大小限制、讀取更快
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
  // 某天有哪些既定行程（含每週重複）；重要日子（全天標記）另外算，不當行程
  const eventsOn = d => {
    const dow = new Date(d + 'T00:00:00').getDay();
    return events.filter(e => !e.kind && (e.recurring === 'weekly'
      ? new Date(e.date + 'T00:00:00').getDay() === dow && e.date <= d
      : e.date === d))
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
  };
  // 重要日子（像 Apple/Google 日曆的全天標記）：紀念日/生日、期限、考試、其他
  const MARKS = [
    ['anniv', '🎉', '紀念日／生日'],
    ['due', '⏰', '期限／截止'],
    ['exam', '📝', '考試'],
    ['day', '📌', '其他重要日子'],
  ];
  const markIcon = k => (MARKS.find(m => m[0] === k) || MARKS[3])[1];
  const marksOn = d => events.filter(e => e.kind
    && (e.recurring === 'yearly' ? e.date.slice(5) === d.slice(5) && e.date <= d : e.date === d));
  const annivYears = (e, d) => e.recurring === 'yearly' ? +d.slice(0, 4) - +e.date.slice(0, 4) : 0;
  // 期限倒數：今天＝當天，未來＝還有 N 天
  const daysLeft = d => Math.round((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
  const markLabel = (e, d) => {
    if (e.recurring === 'yearly') { const y = annivYears(e, d); return y > 0 ? ` ${y}週年` : ''; }
    if (e.kind === 'anniv') return '';
    const n = daysLeft(e.date);
    return n === 0 ? '（今天）' : n > 0 ? `（剩 ${n} 天）` : '';
  };

  // 點行程 → 開編輯（名稱、時間、顏色、刪除）；預設白底黑字
  const [editEv, setEditEv] = useState(null);
  // 「＋n 小時」只在「按下選單」時把截止＝起始＋n（最多 12 小時）；n 會記住
  const [durH, setDurH] = useState(() => +(localStorage.getItem('evDurH') || 1));
  const pickDur = h => { setDurH(h); try { localStorage.setItem('evDurH', String(h)); } catch {} };
  const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const addH = (t, h) => hm(Math.min(toMin(t) + Math.round(h * 60), 24 * 60 - 5));
  // 改「起始時間」時：保留原本的時長，截止跟著平移（不理會 +n）
  // 例：12:00–15:00（時長 3 小時）把起始改成 13:00 → 截止 16:00
  const shiftStart = (v, newStart) => {
    const dur = Math.max(5, toMin(v.end_time) - toMin(v.start_time));
    return { ...v, start_time: newStart, end_time: hm(Math.min(toMin(newStart) + dur, 24 * 60 - 5)) };
  };
  const DUR_OPTS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12];
  async function saveEvent() {
    const ev = editEv;
    if (!ev.title.trim()) { alert('請輸入行程名稱'); return; }
    // 顏色有改，且有其他同名行程 → 詢問是否一起變色
    const orig = events.find(x => x.id === ev.id);
    const colorChanged = orig && (orig.color || '') !== (ev.color || '');
    const sameName = events.filter(x => x.title === orig?.title && x.id !== ev.id);
    let applySameName = false;
    if (colorChanged && sameName.length) {
      applySameName = window.confirm(`要把所有「${orig.title}」的行程都改成同一個顏色嗎？（共 ${sameName.length + 1} 筆）\n\n確定＝全部一起變　取消＝只改這一筆`);
    }
    const patch = ev.kind
      ? { title: ev.title.trim(), color: ev.color || '', date: ev.date, kind: ev.kind, recurring: ev.recurring || '' } // 重要日子：沒有時間地點
      : { title: ev.title.trim(), location: ev.location || '', color: ev.color || '', date: ev.date, start_time: ev.start_time, end_time: ev.end_time };
    // 畫面立刻更新，API 在背景送（不用等）
    setEditEv(null);
    setEvents(list => list.map(x => {
      if (x.id === ev.id) return { ...x, ...patch };
      if (ev.recurring && orig && x.recurring && x.title === orig.title && x.start_time === orig.start_time && x.end_time === orig.end_time)
        return { ...x, ...patch, date: x.date };
      if (applySameName && orig && x.title === orig.title) return { ...x, color: ev.color || '' };
      return x;
    }));
    try {
      await api(`/events/${ev.id}`, { method: 'PATCH', body: { ...patch, applyAll: !ev.kind && !!ev.recurring } });
      if (applySameName) {
        await Promise.all(sameName.map(x => api(`/events/${x.id}`, { method: 'PATCH', body: { color: ev.color || '' } })));
      }
    } catch (err) { alert('儲存失敗：' + err.message); }
    loadEvents();
  }
  // 拖曳行程：可移到任何一天、任何時段（對齊到最近的半小時）
  // 桌機用 HTML5 拖曳；手機（iPhone/iPad）用觸控自製拖曳（見下方 touch handlers）
  const canDrag = !window.matchMedia('(pointer: coarse)').matches;
  const dragRef = useRef({ id: null, offY: 0 });
  // 拖曳時的即時預覽（會落在哪一天、哪個時段）：半小時為一格吸附。
  // 直接操作 DOM，不用 React state——拖曳中重繪會讓 Chromium 取消 drop，也比較順
  const lastPrev = useRef(null);
  const snap30 = y => Math.round((H0 * 60 + y / ROW * 60) / 30) * 30;
  const clearPreview = () => {
    document.querySelectorAll('.drag-prev').forEach(el => { el.style.display = 'none'; });
    lastPrev.current = null;
  };
  function updatePreview(clientX, clientY, e, offY) {
    const col = document.elementFromPoint(clientX, clientY)?.closest('[data-day]');
    if (!col) return null;
    const dur = toMin(e.end_time) - toMin(e.start_time);
    const rect = col.getBoundingClientRect();
    let startMin = snap30(clientY - rect.top - offY);
    startMin = Math.max(H0 * 60, Math.min(24 * 60 - dur, startMin));
    document.querySelectorAll('.drag-prev').forEach(el => { if (el.parentElement !== col) el.style.display = 'none'; });
    const el = col.querySelector('.drag-prev');
    if (el) {
      el.style.display = 'flex';
      el.style.top = `${yOf(startMin)}px`;
      el.style.height = `${Math.max(20, dur / 60 * ROW)}px`;
      el.textContent = `${hm(startMin)}–${hm(startMin + dur)}`;
    }
    lastPrev.current = { id: e.id, day: col.dataset.day, startMin, dur };
    return lastPrev.current;
  }
  // 共用：把行程 e 移到 day 這一欄、欄內 y 座標（已扣掉抓取偏移）的位置
  async function moveEventTo(e, day, startMin) {
    const dur = toMin(e.end_time) - toMin(e.start_time);
    const start = hm(startMin), end = hm(startMin + dur);
    if (e.date === day && e.start_time.slice(0, 5) === start) return;
    setEvents(list => list.map(x => x.id === e.id ? { ...x, date: day, start_time: start, end_time: end } : x)); // 畫面先動
    try { await api(`/events/${e.id}`, { method: 'PATCH', body: { date: day, start_time: start, end_time: end } }); }
    catch (err) { alert('移動失敗：' + err.message); }
    loadEvents();
  }
  async function dropEvent(dragEv, d) {
    dragEv.preventDefault();
    const id = dragEv.dataTransfer.getData('text/ev-id') || String(dragRef.current.id || '');
    if (!id) return;
    const e = events.find(x => String(x.id) === id);
    if (!e) return;
    // 就放在預覽框的位置（所見即所得）；沒有預覽才用放開的座標推算
    const prev = lastPrev.current;
    let day = d, startMin;
    if (prev && prev.id === e.id) { day = prev.day; startMin = prev.startMin; }
    else {
      const rect = dragEv.currentTarget.getBoundingClientRect();
      const offY = String(dragRef.current.id) === id ? dragRef.current.offY : 0;
      const dur = toMin(e.end_time) - toMin(e.start_time);
      startMin = Math.max(H0 * 60, Math.min(24 * 60 - dur, snap30(dragEv.clientY - rect.top - offY)));
    }
    dragRef.current = { id: null, offY: 0 };
    clearPreview();
    await moveEventTo(e, day, startMin);
  }
  // 桌機拖曳經過欄位時也顯示預覽
  function onColDragOver(ev, d) {
    ev.preventDefault();
    const e = events.find(x => x.id === dragRef.current.id);
    if (e) updatePreview(ev.clientX, ev.clientY, e, dragRef.current.offY);
  }
  // 長按（或桌機右鍵）行程 → 複製／刪除選單
  const [evMenu, setEvMenu] = useState(null); // { ev, x, y }
  const pressTimer = useRef(null);
  const suppressClick = useRef(false);
  // 剪貼簿：複製／剪下後，點日曆空格貼上（跟電腦一樣）
  const [clip, setClip] = useState(null); // { ev, mode: 'copy' | 'cut' }
  async function pasteAt(day, startMin) {
    if (!clip) return;
    const e = clip.ev;
    const dur = Math.max(5, toMin(e.end_time) - toMin(e.start_time));
    const s = Math.max(H0 * 60, Math.min(24 * 60 - 5 - dur, startMin));
    setClip(null);
    if (clip.mode === 'cut') {                       // 剪下＝搬過去
      setEvents(list => list.map(x => x.id === e.id ? { ...x, date: day, start_time: hm(s), end_time: hm(s + dur) } : x));
      await api(`/events/${e.id}`, { method: 'PATCH', body: { date: day, start_time: hm(s), end_time: hm(s + dur) } }).catch(err => alert('貼上失敗：' + err.message));
    } else {                                          // 複製＝新增一筆
      await api('/events', {
        method: 'POST',
        body: { title: e.title, date: day, start_time: hm(s), end_time: hm(s + dur), location: e.location || '', color: e.color || '', recurring: null },
      }).catch(err => alert('貼上失敗：' + err.message));
    }
    loadEvents();
  }
  // 複製一份接在原行程後面（不用貼上，直接產生）
  async function duplicateEvent(e) {
    setEvMenu(null);
    let start = e.start_time, end = e.end_time;
    if (!e.kind) {
      const dur = toMin(e.end_time) - toMin(e.start_time);
      let s = toMin(e.end_time);
      if (s + dur > 24 * 60 - 5) s = Math.max(H0 * 60, toMin(e.start_time) - dur);
      start = hm(s); end = hm(Math.min(s + dur, 24 * 60 - 5));
    }
    await api('/events', {
      method: 'POST',
      body: { title: e.title, date: e.date, start_time: start, end_time: end, location: e.location || '', color: e.color || '', kind: e.kind || '', recurring: null },
    });
    loadEvents();
  }

  // 手機觸控拖曳：按住行程移動就拖（超過門檻才算拖，只是點一下＝開編輯）
  const touchDrag = useRef(null);
  function onEvTouchStart(ev, e) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const t = ev.touches[0];
    touchDrag.current = { id: e.id, offY: t.clientY - rect.top, x0: t.clientX, y0: t.clientY, moved: false, el: ev.currentTarget, longPressed: false };
    // 按住不動 0.5 秒 → 出選單（一移動就取消，改成拖曳）
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      const d = touchDrag.current;
      if (!d || d.moved) return;
      d.longPressed = true;
      if (d.el) d.el.style.opacity = '';
      clearPreview();
      setEvMenu({ ev: e, x: t.clientX, y: t.clientY });
    }, 500);
  }
  function onEvTouchMove(ev) {
    const d = touchDrag.current; if (!d) return;
    if (d.longPressed) return;                 // 選單開著就不拖
    const t = ev.touches[0];
    if (!d.moved && Math.hypot(t.clientX - d.x0, t.clientY - d.y0) > 12) { d.moved = true; clearTimeout(pressTimer.current); }
    if (!d.moved) return;
    ev.preventDefault();                       // 拖起來就不捲動
    if (d.el) d.el.style.opacity = '.35';      // 原位置變淡，預覽框顯示目的地
    const e = events.find(x => x.id === d.id);
    if (e) updatePreview(t.clientX, t.clientY, e, d.offY);
  }
  async function onEvTouchEnd(ev) {
    const d = touchDrag.current; touchDrag.current = null;
    const prev = lastPrev.current;
    clearTimeout(pressTimer.current);
    clearPreview();
    if (!d) return;
    if (d.el) d.el.style.opacity = '';
    if (d.longPressed) { suppressClick.current = true; return; } // 長按已開選單，別再觸發點擊
    if (!d.moved) return; // 只是點一下 → onClick 開編輯
    const e = events.find(x => x.id === d.id);
    if (!e || !prev || prev.id !== e.id) return;
    await moveEventTo(e, prev.day, prev.startMin); // 就放在預覽框的位置
  }
  async function deleteEvent(ev) {
    // 不用 window.confirm（iOS 加到主畫面的 App 可能直接吃掉，導致按了沒反應）
    setEditEv(null);
    // 用「原本」的資料比對（視窗裡可能已改過名稱/時間）
    const orig = events.find(x => x.id === ev.id) || ev;
    setEvents(list => list.filter(x => !(x.id === ev.id || (orig.recurring && x.recurring && x.title === orig.title && x.start_time === orig.start_time)))); // 畫面先消失
    try {
      if (orig.recurring) {
        const same = events.filter(x => x.recurring && x.title === orig.title && x.start_time === orig.start_time);
        await Promise.all(same.map(e => api(`/events/${e.id}`, { method: 'DELETE' })));
      } else await api(`/events/${ev.id}`, { method: 'DELETE' });
    } catch (err) { alert('刪除失敗：' + err.message); }
    loadEvents();
  }

  // 手動新增行程
  const [addMenu, setAddMenu] = useState(false);
  const [addForm, setAddForm] = useState(null);
  // 紀念日／生日（全天標記，不是行程）
  const [annivForm, setAnnivForm] = useState(null);
  async function submitAnniv() {
    if (!annivForm.title.trim()) { alert('請輸入名稱'); return; }
    await api('/events', { method: 'POST', body: { ...annivForm, title: annivForm.title.trim(), kind: annivForm.kind || 'day', recurring: annivForm.recurring || null } });
    setAnnivForm(null);
    loadEvents();
  }
  // 點格子新增：預設就是點到的那個時段（像 Apple 日曆）
  function openAdd(date = anchor, startMin = null) {
    setAddMenu(false);
    const s = startMin == null ? 8 * 60 : startMin;
    setAddForm({ title: '', date, start_time: hm(s), end_time: hm(Math.min(s + durH * 60, 24 * 60 - 5)), location: '', color: '', recurring: '', allDay: false });
  }
  async function submitAdd() {
    if (!addForm.title.trim()) { alert('請輸入行程名稱'); return; }
    const { allDay, ...f } = addForm;
    await api('/events', {
      method: 'POST',
      body: allDay
        ? { title: f.title.trim(), date: f.date, kind: 'day', recurring: null }   // 全天＝日期下的標記
        : { ...f, title: f.title.trim(), recurring: f.recurring || null },
    });
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
    for (let i = 0; i <= 60; i++) { const d = addDays(today(), i); if (eventsOn(d).length || marksOn(d).length) dates.add(d); }
    const sorted = [...dates].sort();
    return (
      <div>
        {sorted.map(d => (
          <div key={d} className="tgroup">
            <div className="glabel">{`${+d.slice(5, 7)}/${+d.slice(8)}`} 週{WD[(new Date(d + 'T00:00:00').getDay() + 6) % 7]}{d === today() ? '（今天）' : ''}</div>
            {marksOn(d).map(a => (
              <div key={'a' + a.id} className="trow" style={{ cursor: 'pointer' }} onClick={() => setEditEv({ ...a })}>
                <span>{markIcon(a.kind)}</span>
                <span className="title">{a.title}</span>
                <span className="muted">{markLabel(a, d)}</span>
              </div>
            ))}
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
            {marksOn(d).map(a => (
              <div key={'a' + a.id} onClick={ev => { ev.stopPropagation(); setEditEv({ ...a }); }} title={a.title}
                style={{ fontSize: 10, color: 'var(--text)', fontWeight: 400, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {markIcon(a.kind)}{a.title}{markLabel(a, d)}
              </div>
            ))}
          </div>
        ))}
        {/* 時間刻度（現在時間線也延伸到這裡，並標出目前時刻） */}
        <div style={{ position: 'relative', height: totalH }}>
          {HOURS.map((h, i) => (
            <div key={h} style={{ position: 'absolute', top: i * ROW - 6, right: 4, fontSize: 11, color: 'var(--muted)' }}>{String(h).padStart(2, '0')}:00</div>
          ))}
          {days.includes(today()) && nowMin >= H0 * 60 && nowMin <= 24 * 60 && (
            <>
              <div style={{ position: 'absolute', top: yOf(nowMin), left: 0, right: 0, height: 2, background: NOW_LINE, zIndex: 1 }} />
              <div style={{ position: 'absolute', top: yOf(nowMin) - 7, right: 4, fontSize: 10, fontWeight: 700, color: NOW_LINE, background: 'var(--bg)', padding: '0 2px', zIndex: 2 }}>{hm(nowMin)}</div>
            </>
          )}
        </div>
        {/* 每一天一欄：格線 + 絕對定位的行程/任務區塊 */}
        {days.map(d => (
          <div key={d} data-day={d} style={{ position: 'relative', height: totalH, borderLeft: '1px solid var(--border)', background: d === today() ? 'rgba(0,134,204,.05)' : undefined }}
            onDragOver={ev => onColDragOver(ev, d)} onDrop={ev => dropEvent(ev, d)}>
            {HOURS.map((h, i) => (
              <div key={h} style={{ position: 'absolute', top: i * ROW, left: 0, right: 0, height: ROW }}>
                {/* 有剪貼簿內容時點格子＝貼上，否則＝新增 */}
                <div onClick={() => clip ? pasteAt(d, h * 60) : openAdd(d, h * 60)} title={clip ? '點一下貼上' : '點一下新增行程'}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW / 2, borderTop: '1px solid var(--border)', cursor: 'pointer' }} />
                <div onClick={() => clip ? pasteAt(d, h * 60 + 30) : openAdd(d, h * 60 + 30)}
                  style={{ position: 'absolute', top: ROW / 2, left: 0, right: 0, height: ROW / 2, borderTop: '1px dashed rgba(120,120,128,.18)', cursor: 'pointer' }} />
              </div>
            ))}
            {/* 既定行程：白底黑字，可點擊編輯、可拖曳到別天，高度＝時長 */}
            {eventsOn(d).map(e => {
              const top = yOf(toMin(e.start_time));
              const height = Math.max(16, yOf(toMin(e.end_time)) - top);
              const bg = e.color || '#ffffff';
              const dark = textOn(e.color) === '#fff';
              return (
                <div key={'e' + e.id}
                  onClick={ev => { ev.stopPropagation(); if (suppressClick.current) { suppressClick.current = false; return; } setEditEv({ ...e }); }}
                  onContextMenu={ev => { ev.preventDefault(); ev.stopPropagation(); setEvMenu({ ev: e, x: ev.clientX, y: ev.clientY }); }}
                  title="點一下編輯，長按可複製/刪除，拖曳可移到別天/別的時段"
                  draggable={canDrag} onDragStart={ev => {
                    dragRef.current = { id: e.id, offY: ev.clientY - ev.currentTarget.getBoundingClientRect().top };
                    ev.dataTransfer.setData('text/ev-id', String(e.id));
                    ev.dataTransfer.effectAllowed = 'move';
                  }}
                  onTouchStart={ev => onEvTouchStart(ev, e)} onTouchMove={onEvTouchMove} onTouchEnd={onEvTouchEnd}
                  style={{
                    position: 'absolute', top, height, left: 2, right: 2, zIndex: 2,
                    background: bg, color: textOn(e.color), border: `1px solid ${e.color || 'var(--border)'}`,
                    borderLeft: `3px solid ${e.color || '#c7c7cc'}`, borderRadius: 6, padding: '2px 5px',
                    fontSize: 11, lineHeight: 1.15, overflow: 'hidden', cursor: 'pointer', textAlign: 'center',
                    touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                  }}>
                  <div style={{ fontWeight: 600 }}>{e.title}</div>
                  {e.location ? <div style={{ fontSize: 10, color: dark ? 'rgba(255,255,255,.75)' : '#8e8e93' }}>{e.location}</div> : null}
                </div>
              );
            })}
            {/* 拖曳預覽：清楚看到會落在哪一天、哪個時段（半小時一格）。拖曳時直接改樣式 */}
            <div className="drag-prev" style={{
              display: 'none', position: 'absolute', top: 0, height: 20, left: 2, right: 2, zIndex: 6, pointerEvents: 'none',
              border: '2px dashed var(--primary)', borderRadius: 6, background: 'rgba(0,134,204,.14)',
              alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--primary)',
            }} />
            {/* 現在時間線：淺色、在行程後面（zIndex 1 < 行程的 2） */}
            {d === today() && nowMin >= H0 * 60 && nowMin <= 24 * 60 && (
              <div style={{ position: 'absolute', top: yOf(nowMin), left: 0, right: 0, height: 2, background: NOW_LINE, zIndex: 1, pointerEvents: 'none' }}>
                <span style={{ position: 'absolute', left: 0, top: -3, width: 8, height: 8, borderRadius: '50%', background: NOW_LINE }} />
              </div>
            )}
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

  /* ---- 未完成事項：放在日曆下面（往下滑）。只列「今天」＋「過去沒做完」的 ---- */
  const Undone = () => {
    const byTime = (a, b) => (a.due_date || '').localeCompare(b.due_date || '') || (a.due_time || '99').localeCompare(b.due_time || '99') || (a.order_index || 0) - (b.order_index || 0);
    const undone = t => !t.deleted && !t.completed && t.due_date;
    const list = tasks.filter(t => undone(t) && t.due_date === today()).sort(byTime);
    const over = tasks.filter(t => undone(t) && t.due_date < today()).sort(byTime);
    if (!list.length && !over.length) return null;
    const row = (t, late) => (
      <div key={t.id} className="trow">
        <input type="checkbox" checked={false} onChange={() => toggle(t)} />
        <span className="title">{t.title}</span>
        <span className="muted" style={late ? { color: 'var(--red)' } : {}}>
          {late ? `逾期 ${+t.due_date.slice(5, 7)}/${+t.due_date.slice(8)}` : `${+t.due_date.slice(5, 7)}/${+t.due_date.slice(8)}${t.due_time ? ' ' + t.due_time.slice(0, 5) : ''}`}
        </span>
      </div>
    );
    return (
      <div className="tgroup" style={{ marginTop: 14 }}>
        <div className="glabel">未完成事項（{over.length + list.length}）</div>
        {over.map(t => row(t, true))}
        {list.map(t => row(t))}
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
              {marksOn(c.ds).map(a => (
                <div key={'a' + a.id} style={{ fontSize: 9, color: 'var(--text)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
                  onClick={ev => { ev.stopPropagation(); setEditEv({ ...a }); }}>{markIcon(a.kind)}{a.title}</div>
              ))}
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
                <div onClick={() => { setAddMenu(false); setAnnivForm({ title: '', date: anchor, kind: 'due', recurring: '', color: '' }); }}>📌 重要日子（期限／考試／紀念日）</div>
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
        {clip
          ? <div className="row" style={{ margin: '6px 0', padding: '6px 10px', borderRadius: 10, background: 'var(--primary-soft)', color: 'var(--primary)', fontSize: 13 }}>
              <b>{clip.mode === 'cut' ? '✂️ 已剪下' : '📋 已複製'}「{clip.ev.title}」</b>
              <span>點日曆上要放的時段就貼上</span>
              <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => setClip(null)}>取消</button>
            </div>
          : ['day', '3day', 'week'].includes(view) && <div className="muted" style={{ margin: '6px 0' }}>點空格可直接新增行程・長按行程可複製/剪下/刪除</div>}
        {view === 'list' && <ListView />}
        {view === 'year' && <YearView />}
        {view === 'day' && <><HourGrid days={[anchor]} /><Undone /></>}
        {view === '3day' && <><HourGrid days={[anchor, addDays(anchor, 1), addDays(anchor, 2)]} /><Undone /></>}
        {view === 'week' && <><HourGrid days={weekDays} /><Undone /></>}
        {view === 'month' && <><MonthGrid /><Undone /></>}
      </div>

      {/* 長按行程的選單：複製／刪除 */}
      {evMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={() => setEvMenu(null)} onTouchStart={() => setEvMenu(null)} />
          <div className="add-menu" style={{
            position: 'fixed', zIndex: 61,
            left: Math.min(evMenu.x, window.innerWidth - 150), top: Math.min(evMenu.y, window.innerHeight - 120),
          }}>
            <div style={{ fontWeight: 600, opacity: .7, fontSize: 12, cursor: 'default' }}>{evMenu.ev.title}</div>
            <div onClick={() => { setClip({ ev: evMenu.ev, mode: 'copy' }); setEvMenu(null); }}>📋 複製</div>
            {!evMenu.ev.kind && <div onClick={() => { setClip({ ev: evMenu.ev, mode: 'cut' }); setEvMenu(null); }}>✂️ 剪下</div>}
            <div onClick={() => duplicateEvent(evMenu.ev)}><Icon name="plus" size={15} /> 複製一份到後面</div>
            <div style={{ color: 'var(--red)' }} onClick={() => { const t = evMenu.ev; setEvMenu(null); deleteEvent(t); }}><Icon name="trash" size={15} /> 刪除</div>
          </div>
        </>
      )}

      {/* 編輯行程：同樣是 Apple 日曆式版面 */}
      {editEv && (
        <div className="cal-modal-back" onClick={() => setEditEv(null)}>
          <div className="ev-sheet" onClick={e => e.stopPropagation()}>
            <div className="ev-nav">
              <button onClick={() => setEditEv(null)}>取消</button>
              <b>{editEv.kind ? '編輯重要日子' : '編輯行程'}</b>
              <button className="done" onClick={saveEvent}>完成</button>
            </div>

            <div className="ev-group">
              <div className="ev-row ev-title">
                <input value={editEv.title} placeholder="標題" onChange={e => setEditEv(v => ({ ...v, title: e.target.value }))} />
              </div>
              {!editEv.kind && (
                <div className="ev-row">
                  <input value={editEv.location || ''} placeholder="地點" onChange={e => setEditEv(v => ({ ...v, location: e.target.value }))} />
                </div>
              )}
            </div>

            <div className="ev-group">
              {editEv.kind && (
                <div className="ev-row" style={{ flexWrap: 'wrap' }}>
                  {MARKS.map(([k, ic, name]) => (
                    <span key={k} className={'tag-pill' + (editEv.kind === k ? ' on' : '')} style={{ cursor: 'pointer' }}
                      onClick={() => setEditEv(v => ({ ...v, kind: k }))}>{ic} {name}</span>
                  ))}
                </div>
              )}
              <div className="ev-row">
                <span className="lb grow">{editEv.kind ? '日期' : '開始'}</span>
                <input type="date" value={editEv.date || ''} onChange={e => setEditEv(v => ({ ...v, date: e.target.value }))} />
                {!editEv.kind && <input type="time" value={editEv.start_time?.slice(0, 5)} onChange={e => setEditEv(v => shiftStart(v, e.target.value))} />}
              </div>
              {!editEv.kind && (
                <div className="ev-row">
                  <span className="lb grow">結束</span>
                  <input type="time" value={editEv.end_time?.slice(0, 5)} onChange={e => setEditEv(v => ({ ...v, end_time: e.target.value }))} />
                  <select value={durH} title="快速設定時長"
                    onChange={e => { const h = +e.target.value; pickDur(h); setEditEv(v => ({ ...v, end_time: addH(v.start_time, h) })); }}>
                    {DUR_OPTS.map(h => <option key={h} value={h}>＋{h}時</option>)}
                  </select>
                </div>
              )}
              <div className="ev-row">
                <span className="lb grow">重複</span>
                {editEv.kind
                  ? <select value={editEv.recurring || ''} onChange={e => setEditEv(v => ({ ...v, recurring: e.target.value || null }))}>
                      <option value="">永不</option><option value="yearly">每年</option>
                    </select>
                  : <span className="muted">{editEv.recurring === 'weekly' ? '每週・改動套用到每一週' : '永不'}</span>}
              </div>
            </div>

            {!editEv.kind && (
              <div className="ev-group" style={{ padding: '4px 14px 10px' }}>
                <ColorPicker value={editEv.color} onPick={c => setEditEv(v => ({ ...v, color: c }))} />
              </div>
            )}

            <div className="ev-group">
              <div className="ev-row" style={{ justifyContent: 'center', color: 'var(--red)', cursor: 'pointer' }} onClick={() => deleteEvent(editEv)}>
                刪除行程
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 重要日子 */}
      {annivForm && (
        <div className="cal-modal-back" onClick={() => setAnnivForm(null)}>
          <div className="tile cal-modal" onClick={e => e.stopPropagation()}>
            <b>📌 重要日子</b>
            <div className="muted" style={{ marginTop: 2 }}>全天標記，不佔行事曆時段</div>
            <div className="row" style={{ marginTop: 8 }}>
              {MARKS.map(([k, ic, name]) => (
                <span key={k} className={'tag-pill' + (annivForm.kind === k ? ' on' : '')} style={{ cursor: 'pointer' }}
                  onClick={() => setAnnivForm(v => ({ ...v, kind: k, recurring: k === 'anniv' ? 'yearly' : '' }))}>{ic} {name}</span>
              ))}
            </div>
            <input value={annivForm.title} placeholder={annivForm.kind === 'anniv' ? '名稱（如：媽媽生日）' : annivForm.kind === 'exam' ? '名稱（如：第三次段考）' : '名稱（如：物理報告最後期限）'} autoFocus
              onChange={e => setAnnivForm(v => ({ ...v, title: e.target.value }))} style={{ width: '100%', marginTop: 8 }} />
            <div className="row" style={{ marginTop: 8 }}>
              <span className="muted">日期</span>
              <input type="date" value={annivForm.date} onChange={e => setAnnivForm(v => ({ ...v, date: e.target.value }))} />
              {annivForm.date >= today() && <span className="muted">{daysLeft(annivForm.date) === 0 ? '就是今天' : `還有 ${daysLeft(annivForm.date)} 天`}</span>}
            </div>
            <label className="row" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={annivForm.recurring === 'yearly'} onChange={e => setAnnivForm(v => ({ ...v, recurring: e.target.checked ? 'yearly' : '' }))} />
              <span>每年重複（會顯示第幾週年）</span>
            </label>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn sm ghost" onClick={() => setAnnivForm(null)}>取消</button>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={submitAnniv}>新增</button>
            </div>
          </div>
        </div>
      )}

      {/* 新增行程：Apple 日曆式（底部彈出＋分組列表） */}
      {addForm && (
        <div className="cal-modal-back" onClick={() => setAddForm(null)}>
          <div className="ev-sheet" onClick={e => e.stopPropagation()}>
            <div className="ev-nav">
              <button onClick={() => setAddForm(null)}>取消</button>
              <b>新增行程</b>
              <button className="done" disabled={!addForm.title.trim()} onClick={submitAdd}>加入</button>
            </div>

            <div className="ev-group">
              <div className="ev-row ev-title">
                <input value={addForm.title} placeholder="標題" autoFocus
                  onChange={e => setAddForm(v => ({ ...v, title: e.target.value }))} />
              </div>
              <div className="ev-row">
                <input value={addForm.location} placeholder="地點" onChange={e => setAddForm(v => ({ ...v, location: e.target.value }))} />
              </div>
            </div>

            <div className="ev-group">
              <div className="ev-row">
                <span className="lb grow">全天</span>
                <span className={'ios-sw' + (addForm.allDay ? ' on' : '')} onClick={() => setAddForm(v => ({ ...v, allDay: !v.allDay }))}><i /></span>
              </div>
              <div className="ev-row">
                <span className="lb grow">開始</span>
                <input type="date" value={addForm.date} onChange={e => setAddForm(v => ({ ...v, date: e.target.value }))} />
                {!addForm.allDay && <input type="time" value={addForm.start_time} onChange={e => setAddForm(v => shiftStart(v, e.target.value))} />}
              </div>
              {!addForm.allDay && (
                <div className="ev-row">
                  <span className="lb grow">結束</span>
                  <input type="time" value={addForm.end_time} onChange={e => setAddForm(v => ({ ...v, end_time: e.target.value }))} />
                  <select value={durH} title="快速設定時長"
                    onChange={e => { const h = +e.target.value; pickDur(h); setAddForm(v => ({ ...v, end_time: addH(v.start_time, h) })); }}>
                    {DUR_OPTS.map(h => <option key={h} value={h}>＋{h}時</option>)}
                  </select>
                </div>
              )}
              <div className="ev-row">
                <span className="lb grow">重複</span>
                <select value={addForm.recurring || ''} onChange={e => setAddForm(v => ({ ...v, recurring: e.target.value }))}>
                  <option value="">永不</option>
                  <option value="weekly">每週（固定課表）</option>
                </select>
              </div>
            </div>

            {!addForm.allDay && (
              <div className="ev-group" style={{ padding: '4px 14px 10px' }}>
                <ColorPicker value={addForm.color} onPick={c => setAddForm(v => ({ ...v, color: c }))} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
