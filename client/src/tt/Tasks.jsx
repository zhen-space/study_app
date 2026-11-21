import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { matchView, groupTasks, defaultSort, overdueSince, PRI, today, addDays, thisWeekend, nextWeek } from './helpers';
import { relativeDay, zhDateShort } from './dateSemantics';
import VocabCard from './VocabCard';
import MemoCard from './MemoCard';
import { SegmentedControl } from './ui';
import DatePickSheet from './DatePickSheet';
import { LONG_PRESS_MS, LONG_PRESS_SLOP, PICK_DATE, DRAG_HINT, dragHintStyle, dropZoneStyle, useTouchDrag } from './touchDrag';
import { clearTaskCreateFence, createRequestId, currentUserId, loadTaskCreateFence, saveTaskCreateFence } from './taskCreateFence';

const WDC = '日一二三四五六';

// 快速新增／複製在送出後先留下 session fence。重新掛載時以 userId 隔離帳號，
// 並沿用同一把 client_request_id 確認或重送，不保存登入 token。
const QUICK_CREATE_FENCE_KEY = 'tt-task-quick-create-fence-v1';
const DUPLICATE_CREATE_FENCE_KEY = 'tt-task-duplicate-create-fence-v1';

const taskMatchesQuickCreate = (candidate, body) => {
  const tags = value => [...(value || [])].map(String).sort().join('\u0000');
  const listId = value => value == null ? null : String(value);
  return candidate.title === body.title
    && listId(candidate.list_id) === listId(body.list_id)
    && (candidate.notes || '') === (body.notes || '')
    && (candidate.due_date || null) === (body.due_date || null)
    && (candidate.due_time || null) === (body.due_time || null)
    && (Number(candidate.priority) || 0) === (Number(body.priority) || 0)
    && (candidate.recurring || null) === (body.recurring || null)
    && tags(candidate.tags) === tags(body.tags);
};

// 明細 PATCH 回應遺失時，用伺服器讀回值確認是否其實已寫入。
// undefined 不會進 JSON request，不能拿來要求伺服器欄位也必須是 undefined。
const taskMatchesPatch = (candidate, body) => Object.entries(body).every(([key, value]) => {
  if (value === undefined) return true;
  if (Array.isArray(value)) return JSON.stringify(candidate[key] || []) === JSON.stringify(value);
  if (value === null) return candidate[key] == null;
  return candidate[key] === value;
});

// 一科的項數與逾期數。逾期是紅的，其餘是次要資訊——這一行要能一眼看出
// 「哪一科欠最多」，而不是變成又一排同樣重的數字。
export function overdueCount(list, td = today()) {
  return list.filter(t => overdueSince(t, td)).length;
}
export function SubjectCounts({ list }) {
  const od = overdueCount(list);
  return (
    <>
      <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>{list.length} 項</span>
      {od > 0 && <span style={{ marginLeft: 6, color: 'var(--red)', fontWeight: 400 }}>逾期 {od}</span>}
    </>
  );
}

// 任務頁的 Quick Find 只做畫面內篩選，不改 route、也不發 API。
// NFKC 讓全形英數與一般英數能互相找到；標題、備註、標籤、科目都可搜。
export function taskMatchesQuery(task, query, listName = '') {
  const q = String(query || '').normalize('NFKC').trim().toLocaleLowerCase('zh-Hant');
  if (!q) return true;
  return [task.title, task.notes, ...(task.tags || []), listName]
    .filter(Boolean)
    .some(value => String(value).normalize('NFKC').toLocaleLowerCase('zh-Hant').includes(q));
}
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

// 重複任務 v1 開放。domain 一直都在（nextDate()、recurring 欄位、miss_policy、
// 完成後自動長出下一筆），先前只是把 UI 入口關掉。開回來不需要任何 schema 變更。
const RECURRING_UI = true;

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

function TaskRow({ t, lists, sel, onSel, onToggle, onDragStart, onDropOn, onSwipeDelete, onLongPressDrag, onMoveDate, dragging = false, mutationBusy = false, mutationError = '' }) {
  const list = lists.find(l => l.id === t.list_id);
  const pastDue = t.due_date && t.due_date < today() && !t.completed;
  // 已逾期：日期／截止日／最後安排日早於今天且未完成（含 due_date 已因排程歷史變成 NULL 的計畫任務）。
  const overdueDay = overdueSince(t);
  // §M：計畫任務的 due_date 是 AI 排的每日進度——過了原定日是「未完成進度」（warning），
  // 不是「逾期」（danger）。逾期紅只留給非計畫任務的使用者截止。
  const overdue = pastDue && t.plan_id == null;
  const missedProgress = pastDue && t.plan_id != null;
  // 依 iOS 清單慣例，破壞性動作從列尾端向左滑出；刪除後仍可用底部的「復原」救回。
  const sw = useRef(null);
  const [dx, setDx] = useState(0);
  const rowRef = useRef(null);
  const start = e => { if (!onSwipeDelete) return; const p = e.touches[0]; sw.current = { x: p.clientX, y: p.clientY, on: false }; };
  const move = e => {
    const s = sw.current; if (!s) return;
    const p = e.touches[0];
    const ax = p.clientX - s.x, ay = p.clientY - s.y;
    if (!s.on) { if (Math.abs(ax) > 12 && Math.abs(ax) > Math.abs(ay) * 1.5) s.on = true; else if (Math.abs(ay) > 12) { sw.current = null; return; } }
    if (s.on) { e.preventDefault(); setDx(Math.min(0, ax)); }   // 只往左滑
  };
  const end = () => {
    const s = sw.current; sw.current = null;
    if (s?.on && dx < -90) { setDx(0); onSwipeDelete(t); return; }
    setDx(0);
  };
  // 長按拖曳：手指不動按住才啟動；先動了就是捲動或左滑，兩者互不搶。
  // 勾選框與按鈕上不啟動，點擊勾選維持原本行為。啟動後的移動與放下交給清單統一處理。
  const lp = useRef(null);
  const suppressClick = useRef(false);
  useEffect(() => () => clearTimeout(lp.current?.timer), []);
  const touchStart = e => {
    const p = e.touches[0];
    if (onLongPressDrag && !e.target.closest?.('input,button,select,textarea,a')) {
      clearTimeout(lp.current?.timer);
      const l = { x: p.clientX, y: p.clientY, fired: false };
      l.timer = setTimeout(() => {
        if (lp.current !== l) return;
        l.fired = true;
        sw.current = null; setDx(0);
        onLongPressDrag(t);
      }, LONG_PRESS_MS);
      lp.current = l;
    }
    start(e);
  };
  const touchMove = e => {
    const l = lp.current;
    if (l?.fired) return;
    if (l) {
      const p = e.touches[0];
      if (Math.hypot(p.clientX - l.x, p.clientY - l.y) > LONG_PRESS_SLOP) { clearTimeout(l.timer); lp.current = null; }
    }
    move(e);
  };
  const touchEnd = e => {
    const l = lp.current; lp.current = null;
    if (l) {
      clearTimeout(l.timer);
      // 拖曳結束後瀏覽器仍會補一個 click，不能因此打開明細。
      if (l.fired) { suppressClick.current = true; return; }
    }
    end(e);
  };
  return (
    <div style={{ position: 'relative', overflow: 'hidden' }}>
      {dx < 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 14, borderRadius: 10, background: dx < -90 ? 'var(--red)' : 'var(--fill-strong)', color: dx < -90 ? '#fff' : 'var(--muted)', fontSize: 13, fontWeight: 600 }}>
          {dx < -90 ? '放開就刪除' : '再滑一點'} 🗑
        </div>
      )}
      <div ref={rowRef} className={'trow' + (t.completed ? ' done' : '') + (sel ? ' sel' : '') + (dragging ? ' dragging' : '')}
        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (dx < 6) onSel(t); }}
        onContextMenu={onLongPressDrag ? e => e.preventDefault() : undefined}
        draggable={!!onDragStart}
        onDragStart={onDragStart ? () => onDragStart(t) : undefined}
        onDragOver={onDropOn ? e => e.preventDefault() : undefined}
        onDrop={onDropOn ? () => onDropOn(t) : undefined}
        onTouchStart={touchStart} onTouchMove={touchMove} onTouchEnd={touchEnd} onTouchCancel={touchEnd}
        aria-grabbed={onLongPressDrag ? dragging : undefined}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? 'none' : 'transform .18s', position: 'relative', background: 'var(--card)',
          ...(onLongPressDrag ? { WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' } : {}),
          ...(dragging ? { opacity: 0.55, outline: '2px dashed var(--primary)' } : {}) }}>
        <input type="checkbox" checked={!!t.completed} disabled={mutationBusy}
          aria-label={t.completed ? `取消完成「${t.title}」` : `完成「${t.title}」`}
          onClick={e => e.stopPropagation()} onChange={() => onToggle(t)} />
        {/* §E：兩層資訊。第一層＝標題（主角）；第二層＝科目名＋日期（次要）。
            過去只有一顆神秘色點代表科目，要記得色碼才知道是哪一科；改成直接寫科目名。 */}
        <div className="trow-main">
          <div className="trow-line1">
            {t.priority > 0 && <span className={PRI[t.priority][1]}>⚑</span>}
            <span className="title">{t.title}</span>
            {t.subtasks.length > 0 && <span className="chip">{t.subtasks.filter(s => s.done).length}/{t.subtasks.length}</span>}
            {/* chip--tag：手機上要收起來。每一筆排進來的讀書任務都掛著同一個
                「讀書計劃」標籤，那一格寬度換不到任何資訊，卻把長標題擠成好幾行。 */}
            {t.tags.map(tag => <span key={tag} className="chip chip--tag">#{tag}</span>)}
          </div>
          {(list || t.due_date || overdueDay || onMoveDate) && (
            <div className="trow-line2">
              {list && <span className="trow-subject"><span className="trow-swatch" style={{ background: list.color }} />{list.name}</span>}
              {overdueDay && <span className="trow-status" style={{ color: 'var(--red)', fontWeight: 600 }}>已逾期</span>}
              {overdueDay && !t.due_date && <span className="trow-due" style={{ color: 'var(--red)' }}>{t.deadline_date === overdueDay ? '截止' : '原定'} {relativeDay(overdueDay, today())}</span>}
              {t.due_date && <span className="trow-due" style={overdue ? { color: 'var(--red)' } : missedProgress ? { color: 'var(--warning, #b7791f)' } : undefined} title={missedProgress ? '未完成進度（原定日期已過）' : undefined}>{relativeDay(t.due_date, today())}{t.due_time ? ' ' + t.due_time : ''}</span>}
              {/* 不靠長按也能改日期（鍵盤／VoiceOver）；長按拖曳只是捷徑。 */}
              {onMoveDate && <button type="button" className="row-move" aria-label={`改「${t.title}」的日期`}
                onClick={e => { e.stopPropagation(); onMoveDate(t); }}>改日期</button>}
            </div>
          )}
        </div>
      </div>
      {mutationError && <div role="alert" className="ui-error" style={{ margin: '4px 8px 0' }}>{mutationError}</div>}
    </div>
  );
}

// §F 任務明細：分成「任務資訊／安排／實際讀書／其他」四區，不再是一長條扁平表單。
// 刪除收進右上「•••」（不再一顆紅按鈕擺在最下面誤觸）；標籤改 chips（非開發者式逗號字串）；
// 多出一個「實際讀書」摘要（讀了多久），把 generic 的「日期」歸到「安排」語意底下。
export function Detail({ task, lists, onSave, onDelete, onDuplicate, onClose, saveBusy = false, saveError = '', refreshCommitted = false, onRetryRefresh }) {
  const [t, setT] = useState(task);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const draftRef = useRef(task);
  const up = (patch, save = true) => {
    const nt = { ...draftRef.current, ...patch };
    draftRef.current = nt;
    setT(nt);
    if (save && !composingRef.current) onSave(nt);
  };
  const startComposition = () => { composingRef.current = true; setComposing(true); };
  const finishComposition = patch => {
    composingRef.current = false;
    setComposing(false);
    up(patch);
  };
  const finishEditing = () => { if (!composingRef.current) onClose(); };
  const [newSub, setNewSub] = useState('');
  const newSubComposingRef = useRef(false);
  const [newTag, setNewTag] = useState('');
  const [menu, setMenu] = useState(false);

  // 附件
  const [atts, setAtts] = useState([]);
  const [attBusy, setAttBusy] = useState(false);
  const [attMutation, setAttMutation] = useState(null); // { operation, committed, error }
  const attBusyRef = useRef(false);
  const attOpenBusyRef = useRef(false);
  const [attOpenBusyId, setAttOpenBusyId] = useState(null);
  const [attOpenError, setAttOpenError] = useState(null); // { id, message }
  const attRowsRef = useRef([]);
  const attLoadedRef = useRef(false);
  const attLoadPromiseRef = useRef(null);
  const loadAtts = async () => {
    const request = api(`/tasks/${task.id}/attachments`);
    attLoadPromiseRef.current = request;
    try {
      const rows = await request;
      attRowsRef.current = rows;
      attLoadedRef.current = true;
      setAtts(rows);
      return rows;
    } finally {
      if (attLoadPromiseRef.current === request) attLoadPromiseRef.current = null;
    }
  };
  // 一定要包成 { }：箭頭函式直接回傳 Promise 的話，React 會把那個 Promise 當成
  // 清理函式，關掉任務時就會 destroy() → 「l is not a function」整頁掛掉
  useEffect(() => { loadAtts().catch(() => {}); }, [task.id]);
  // 實際讀書：這個任務累計讀了多久（只算 completed 的 StudySession；來源是 GET /study-sessions）
  const [sessions, setSessions] = useState([]);
  useEffect(() => {
    api('/study-sessions').then(rows => setSessions((rows || []).filter(s => Number(s.task_id) === Number(task.id) && s.status === 'completed'))).catch(() => {});
  }, [task.id]);
  const studyMin = sessions.reduce((a, s) => a + (s.actual_minutes || 0), 0);

  async function addAtt(e) {
    const file = e.target.files[0];
    if (!file || attBusyRef.current || attMutation?.committed) return;
    if (file.size > 3 * 1024 * 1024) { alert('檔案太大（上限 3MB）'); e.target.value = ''; return; }
    const input = e.target;
    attBusyRef.current = true;
    setAttBusy(true);
    setAttMutation(null);
    let knownIds;
    try {
      // 上傳前一定要有完整 baseline，否則首屏附件清單還在載入時，同名舊附件
      // 可能被誤當成這次 POST 已成功的證據。
      if (attLoadPromiseRef.current) await attLoadPromiseRef.current;
      else if (!attLoadedRef.current) await loadAtts();
      knownIds = new Set(attRowsRef.current.map(row => Number(row.id)));
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await api(`/tasks/${task.id}/attachments`, { method: 'POST', body: { name: file.name, mime: file.type, data: btoa(bin) } });
    } catch (err) {
      // POST 可能已寫入、只有回應遺失。用上傳前的 id 集合與檔名／mime 找出
      // 唯一新附件；確認成功就直接採用正式清單，避免重選同檔造成重複上傳。
      try {
        const rows = await api(`/tasks/${task.id}/attachments`);
        if (!Array.isArray(rows)) throw new Error('附件清單格式不正確');
        const matches = rows.filter(row => !knownIds.has(Number(row.id))
          && row.name === file.name && (row.mime || '') === (file.type || ''));
        if (matches.length === 1) {
          input.value = '';
          attRowsRef.current = rows;
          attLoadedRef.current = true;
          setAtts(rows);
          setAttMutation(null);
          attBusyRef.current = false;
          setAttBusy(false);
          return;
        }
        if (matches.length > 1) throw new Error('上傳結果不唯一');
      } catch (checkError) {
        // baseline 本身載入失敗時 POST 尚未送出，可安全讓使用者重試；只有 POST
        // 已送出後的讀回失敗才需要鎖定，避免重複上傳。
        if (!attLoadedRef.current) {
          input.value = '';
          setAttMutation({ operation: 'upload', committed: false,
            error: '無法載入現有附件，尚未上傳；請重新選取檔案再試一次。' });
          attBusyRef.current = false;
          setAttBusy(false);
          return;
        }
        input.value = '';
        setAttMutation({ operation: 'upload', committed: true, uncertain: true,
          error: '無法確認附件是否已上傳，請重新載入附件；確認前請勿再次上傳。' });
        attBusyRef.current = false;
        setAttBusy(false);
        return;
      }
      input.value = ''; // 讓同一個檔案可以重新選取並觸發 change
      setAttMutation({ operation: 'upload', committed: false, error: err.message || '附件上傳失敗，請重新選取檔案再試一次。' });
      attBusyRef.current = false;
      setAttBusy(false);
      return;
    }
    input.value = '';
    setAttMutation({ operation: 'upload', committed: true, error: '' });
    try {
      await loadAtts();
      setAttMutation(null);
    } catch (err) {
      setAttMutation({ operation: 'upload', committed: true, error: err.message || '附件已上傳，但清單暫時無法更新。' });
    } finally {
      attBusyRef.current = false;
      setAttBusy(false);
    }
  }
  async function retryAtts() {
    if (attBusyRef.current) return;
    attBusyRef.current = true;
    setAttBusy(true);
    try {
      await loadAtts();
      setAttMutation(null);
    } catch (err) {
      setAttMutation(m => ({ operation: m?.operation || 'refresh', committed: true,
        error: err.message || '仍然無法更新附件清單，請稍後再試。' }));
    } finally {
      attBusyRef.current = false;
      setAttBusy(false);
    }
  }
  async function openAtt(a) {
    if (attOpenBusyRef.current) return;
    attOpenBusyRef.current = true;
    setAttOpenBusyId(a.id);
    setAttOpenError(null);
    try {
      const full = await api(`/attachments/${a.id}`);
      const bin = atob(full.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: full.mime || 'application/octet-stream' }));
      const aEl = document.createElement('a');
      aEl.href = url;
      aEl.download = full.name;
      aEl.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      setAttOpenError({ id: a.id, message: err.message || '附件下載失敗，請再試一次。' });
    } finally {
      attOpenBusyRef.current = false;
      setAttOpenBusyId(null);
    }
  }
  async function deleteAtt(a) {
    if (attBusyRef.current || attMutation?.committed) return;
    if (!window.confirm(`刪除附件「${a.name}」？此動作無法復原。`)) return;
    attBusyRef.current = true;
    setAttBusy(true);
    setAttMutation(null);
    let confirmedRows = null;
    try {
      await api(`/attachments/${a.id}`, { method: 'DELETE' });
    } catch (err) {
      // DELETE 回應遺失時，先讀回附件清單確認是否其實已提交；附件刪除不可逆，
      // 不能只因連線錯誤就讓使用者再次送出同一個刪除。
      try {
        const rows = await api(`/tasks/${task.id}/attachments`);
        if (!Array.isArray(rows)) throw new Error('附件清單格式不正確');
        if (rows.some(row => Number(row.id) === Number(a.id))) {
          setAttMutation({ operation: 'delete', committed: false, error: err.message || '附件刪除失敗，請再試一次。' });
          attBusyRef.current = false;
          setAttBusy(false);
          return;
        }
        confirmedRows = rows;
      } catch {
        setAttMutation({ operation: 'delete', committed: true, uncertain: true,
          error: '無法確認附件是否已刪除，請重新載入附件；確認前請勿再次操作。' });
        attBusyRef.current = false;
        setAttBusy(false);
        return;
      }
    }
    // DELETE 已提交就立刻移除本地投影，避免刷新失敗時再次送出不可逆刪除。
    setAtts(rows => confirmedRows || rows.filter(row => Number(row.id) !== Number(a.id)));
    setAttMutation({ operation: 'delete', committed: true, error: '' });
    if (confirmedRows) {
      setAttMutation(null);
      attBusyRef.current = false;
      setAttBusy(false);
      return;
    }
    try {
      await loadAtts();
      setAttMutation(null);
    } catch (err) {
      setAttMutation({ operation: 'delete', committed: true, error: err.message || '附件已刪除，但清單暫時無法更新。' });
    } finally {
      attBusyRef.current = false;
      setAttBusy(false);
    }
  }
  const addTag = raw => { const v = raw.trim(); if (!v || t.tags.includes(v)) return; up({ tags: [...t.tags, v] }); };
  const isSchoolAssignment = t.task_kind === 'school_assignment';
  const scheduleManaged = !isSchoolAssignment && t.plan_id != null;
  const canDuplicate = !isSchoolAssignment && t.plan_id == null;

  return (
    <div className="detail">
      <div className="drow" style={{ justifyContent: 'space-between' }}>
        <button className="btn sm" onClick={refreshCommitted ? onRetryRefresh : finishEditing} disabled={composing || saveBusy || attBusy || attOpenBusyId != null} title="完成編輯">
          {saveBusy ? '儲存中…' : refreshCommitted ? '重新載入並關閉' : (attBusy || attOpenBusyId != null) ? '附件處理中…' : '✓ 完成'}
        </button>
        <div style={{ position: 'relative' }}>
          <button className="icon-btn" aria-label="更多" disabled={attBusy || attOpenBusyId != null} onClick={() => setMenu(m => !m)}>⋯</button>
          {menu && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setMenu(false)} />
              <div className="sa-menu" role="menu">
                {canDuplicate && <button role="menuitem" onClick={() => { setMenu(false); onDuplicate(t); }}>複製任務</button>}
                <button role="menuitem" className="sa-menu-danger" onClick={() => { setMenu(false); onDelete(t); }}>刪除任務</button>
              </div>
            </>
          )}
        </div>
      </div>
      <input className="title" value={t.title}
        onCompositionStart={startComposition}
        onCompositionEnd={e => finishComposition({ title: e.currentTarget.value })}
        onChange={e => up({ title: e.target.value }, !e.nativeEvent.isComposing)} />

      {/* ── 任務資訊 ── */}
      <div className="detail-sec-t">任務資訊</div>
      <div className="drow">
        <label>科目</label>
        <select value={t.list_id || ''} onChange={e => up({ list_id: e.target.value ? +e.target.value : null })}>
          <option value="">願望清單</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      <div className="drow">
        <label>優先級</label>
        <select value={t.priority} onChange={e => up({ priority: +e.target.value })}>
          {[0, 1, 2, 3].map(p => <option key={p} value={p}>{PRI[p][0]}</option>)}
        </select>
      </div>
      <div className="drow" style={{ alignItems: 'flex-start' }}>
        <label>標籤</label>
        <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {t.tags.map(tag => (
            <span key={tag} className="chip chip--tag" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>#{tag}
              <button className="icon-btn" style={{ padding: 0, lineHeight: 1 }} aria-label={`移除標籤 ${tag}`}
                onClick={() => up({ tags: t.tags.filter(x => x !== tag) })}>✕</button>
            </span>
          ))}
          <input placeholder="＋標籤" value={newTag} onChange={e => setNewTag(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addTag(newTag); setNewTag(''); } }} style={{ width: 92 }} />
        </div>
      </div>
      <div>
        <label className="muted">子任務</label>
        {t.subtasks.map((s, i) => (
          <div key={i} className={'subtask' + (s.done ? ' done' : '')}>
            <input type="checkbox" checked={s.done} onChange={() => up({ subtasks: t.subtasks.map((x, j) => j === i ? { ...x, done: !x.done } : x) })} />
            <input type="text" value={s.title}
              onCompositionStart={startComposition}
              onCompositionEnd={e => finishComposition({ subtasks: draftRef.current.subtasks.map((x, j) => j === i ? { ...x, title: e.currentTarget.value } : x) })}
              onChange={e => up({ subtasks: draftRef.current.subtasks.map((x, j) => j === i ? { ...x, title: e.target.value } : x) }, !e.nativeEvent.isComposing)} />
            <button className="icon-btn" onClick={() => up({ subtasks: t.subtasks.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <form onSubmit={e => { e.preventDefault(); if (newSubComposingRef.current) return; if (newSub.trim()) { up({ subtasks: [...t.subtasks, { title: newSub.trim(), done: false }] }); setNewSub(''); } }}>
          <input placeholder="＋新增子任務" value={newSub}
            onCompositionStart={() => { newSubComposingRef.current = true; }}
            onCompositionEnd={() => { newSubComposingRef.current = false; }}
            onChange={e => setNewSub(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
        </form>
      </div>

      {/* ── 安排 ── */}
      <div className="detail-sec-t">安排</div>
      {saveError && <div role="alert" className="ui-error" style={{ marginBottom: 8 }}>{saveError}{refreshCommitted ? '' : '，請確認後再按「完成」重試。'}</div>}
      <div className="drow">
        <label>{isSchoolAssignment ? '繳交日期' : '日期'}</label>
        <input type="date" aria-label={isSchoolAssignment ? '繳交日期' : '日期'} disabled={scheduleManaged}
          value={(isSchoolAssignment ? t.deadline_date : t.due_date) || ''}
          onChange={e => up(isSchoolAssignment ? { deadline_date: e.target.value || null } : { due_date: e.target.value || null })} />
      </div>
      {!scheduleManaged && (
        <div className="drow" aria-label="日期快捷選項">
          <label />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[
              ['今天', today()],
              ['明天', addDays(today(), 1)],
              ['本週末', thisWeekend()],
              ['下週', nextWeek()],
              ['清除日期', null],
            ].map(([label, value]) => {
              const field = isSchoolAssignment ? 'deadline_date' : 'due_date';
              const active = (isSchoolAssignment ? t.deadline_date : t.due_date) === value;
              return <button key={label} type="button" className={'chip' + (active ? ' on' : '')}
                aria-pressed={active} onClick={() => up({ [field]: value })}>{label}</button>;
            })}
          </div>
        </div>
      )}
      <div className="drow">
        <label>{isSchoolAssignment ? '繳交時間' : '時間'}</label>
        <input type="time" aria-label={isSchoolAssignment ? '繳交時間' : '時間'} disabled={scheduleManaged}
          value={(isSchoolAssignment ? t.deadline_time : t.due_time) || ''}
          onChange={e => up(isSchoolAssignment ? { deadline_time: e.target.value || null } : { due_time: e.target.value || null })} />
      </div>
      {isSchoolAssignment && (
        <div className="drow">
          <label>預估時間</label>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input aria-label="預估時間（分鐘）" type="number" min="1" max="1440" inputMode="numeric"
              value={t.estimated_minutes ?? ''}
              onChange={e => up({ estimated_minutes: e.target.value === '' ? null : Number(e.target.value) })} />
            <span className="muted">分鐘</span>
          </div>
        </div>
      )}
      {RECURRING_UI && !isSchoolAssignment && (
        <RepeatPicker value={t.recurring} dueDate={t.due_date} missPolicy={t.miss_policy}
          onChange={(recurring, miss_policy) => up({ recurring, miss_policy })} />
      )}
      {t.plan_id != null && <div className="ui-meta" style={{ marginTop: 6 }}>已加入讀書計畫；排定日期由計畫管理，要改安排請到「計畫」裡調整。</div>}
      {isSchoolAssignment && t.plan_id == null && <div className="ui-meta" style={{ marginTop: 6 }}>尚未加入讀書計畫</div>}

      {/* ── 實際讀書 ── */}
      <div className="detail-sec-t">實際讀書</div>
      <div className="ui-meta">{studyMin > 0 ? `累計讀了 ${studyMin} 分鐘（${sessions.length} 次）` : '還沒有讀書紀錄'}</div>

      {/* ── 其他 ── */}
      <div className="detail-sec-t">其他</div>
      <textarea placeholder="備註..." value={t.notes} onChange={e => up({ notes: e.target.value })} />
      <div>
        <label className="muted">📎 附件</label>
        {atts.map(a => (
          <div key={a.id}>
            <div className="subtask">
              <button type="button" aria-label={`下載附件「${a.name}」`}
                disabled={attOpenBusyId != null}
                onClick={() => openAtt(a)}
                style={{ flex: 1, cursor: 'pointer', color: 'var(--primary)', textAlign: 'left', background: 'none', border: 0, padding: 0 }}>
                {attOpenBusyId === a.id ? '下載中…' : a.name}
              </button>
              <span className="muted">{Math.round(a.size * 0.75 / 1024)}KB</span>
              <button className="icon-btn" aria-label={`刪除附件「${a.name}」`}
                disabled={attBusy || attOpenBusyId != null || !!attMutation?.committed}
                onClick={() => deleteAtt(a)}>✕</button>
            </div>
            {attOpenError?.id === a.id && (
              <div role="alert" className="ui-error" style={{ margin: '4px 0 0' }}>{attOpenError.message}</div>
            )}
          </div>
        ))}
        <input type="file" aria-label="新增附件" disabled={attBusy || attOpenBusyId != null || !!attMutation?.committed}
          onChange={addAtt} style={{ marginTop: 4, width: '100%' }} />
        {attMutation?.error && (
          <div role="alert" className="ui-error" style={{ marginTop: 6 }}>
            {attMutation.committed
              ? (attMutation.uncertain ? attMutation.error
                : attMutation.operation === 'delete' ? '附件已刪除，但清單暫時無法更新。' : '附件已上傳，但清單暫時無法更新。')
              : attMutation.error}
            {attMutation.committed && (
              <button type="button" disabled={attBusy} onClick={retryAtts} style={{ marginLeft: 8 }}>
                {attBusy ? '重新載入中…' : '重新載入附件'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// AddSheet／saForm 已移除：新增一律走 Shell 的 Global Add（§A）；列表內只保留 inline quick-add。

export default function Tasks({ view, tasks, lists, filters, habits = [], reload, title, subtitle = '', listLabel = '', goVocab, goMemo, topSlot = null, onNav }) {
  const [selId, setSelId] = useState(null);
  const [restoredQuick] = useState(() => loadTaskCreateFence(QUICK_CREATE_FENCE_KEY));
  const [restoredDuplicateFence] = useState(() => loadTaskCreateFence(DUPLICATE_CREATE_FENCE_KEY));
  const [quick, setQuick] = useState(restoredQuick?.body?.title ?? '');
  const [quickErr, setQuickErr] = useState(restoredQuick ? '正在確認剛才的任務是否已新增；確認前不會再次送出。' : '');
  const [quickBusy, setQuickBusy] = useState(!!restoredQuick);
  const [quickDue, setQuickDue] = useState(restoredQuick?.body?.due_date ?? '');
  const [quickTime, setQuickTime] = useState(restoredQuick?.body?.due_time ?? '');
  const [quickListId, setQuickListId] = useState(restoredQuick?.body?.list_id == null ? '' : String(restoredQuick.body.list_id));
  const [quickPriority, setQuickPriority] = useState(restoredQuick?.body?.priority ?? 0);
  const [quickTag, setQuickTag] = useState(restoredQuick?.body?.tags?.[0] ?? '');
  const [quickNotes, setQuickNotes] = useState(restoredQuick?.body?.notes ?? '');
  const [quickRecurring, setQuickRecurring] = useState(restoredQuick?.body?.recurring ?? '');
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('taskCollapsedGroups') || '[]');
      return new Set(Array.isArray(saved) ? saved.filter(x => typeof x === 'string') : []);
    } catch { return new Set(); }
  });
  // 科目清單是否顯示已完成任務是使用者的檢視偏好；切換科目或重新開啟 App
  // 時保留，避免每次都要重新點一次。
  const [showCompletedInList, setShowCompletedInList] = useState(() => {
    try { return localStorage.getItem('taskShowCompletedInList') === 'true'; } catch { return false; }
  });
  const toggleCompletedInList = () => setShowCompletedInList(value => {
    const next = !value;
    try { localStorage.setItem('taskShowCompletedInList', String(next)); } catch {}
    return next;
  });
  const quickBusyRef = useRef(!!restoredQuick);
  const quickPendingRef = useRef(restoredQuick ? { ...restoredQuick, error: null } : null);
  const quickRestoreStartedRef = useRef(false);
  const quickComposing = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (restoredQuick && !quickRestoreStartedRef.current) {
      quickRestoreStartedRef.current = true;
      confirmQuickCreate();
    }
  // 只承接本次掛載前留下的 fence；一般 tasks 更新不能觸發重送。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // §E 第一層 filters（只在「任務」總表出現）：全部／今天／逾期／未排程。記在 localStorage。
  const [taskFilter, setTaskFilter] = useState(() => {
    try { return localStorage.getItem('taskFilter') || 'all'; } catch { return 'all'; }
  });
  const pickFilter = v => { setTaskFilter(v); try { localStorage.setItem('taskFilter', v); } catch {} };
  // §K：科目過濾（''＝全部科目）。custom lists 從側欄移到這裡。
  const [subjFilter, setSubjFilter] = useState(() => {
    try { return localStorage.getItem('taskSubjectFilter') || ''; } catch { return ''; }
  });
  const pickSubjectFilter = v => { setSubjFilter(v); try { localStorage.setItem('taskSubjectFilter', v); } catch {} };
  // Todoist／Things 都把標籤當成清單的第二個切面；沿用既有 tags domain，
  // 只做畫面內篩選，不新增 API 或改動任務資料。
  const [tagFilter, setTagFilter] = useState(() => {
    try { return localStorage.getItem('taskTagFilter') || ''; } catch { return ''; }
  });
  const pickTagFilter = v => { setTagFilter(v); try { localStorage.setItem('taskTagFilter', v); } catch {} };
  // 成熟待辦 App 都把 Quick Find 放在清單本身。手機不必先開側欄，
  // 而且可和日期、科目、排序疊加使用。
  const [quickFind, setQuickFind] = useState('');
  const hasActiveFilters = taskFilter !== 'all' || subjFilter || tagFilter || quickFind.trim();
  const clearTaskFilters = () => {
    pickFilter('all');
    pickSubjectFilter('');
    pickTagFilter('');
    setQuickFind('');
  };
  // 分區方式（依日期／依科目）與組內排序分開記：以前同一個選單同時放「依科目」與
  // 「照科目分堆」、「預設」與「依時間」，語意重複。舊偏好 taskSort=subjectGroup 視為依科目。
  const [groupMode, setGroupMode] = useState(() => {
    try {
      const saved = localStorage.getItem('taskGroupMode');
      if (saved === 'date' || saved === 'subject') return saved;
      return localStorage.getItem('taskSort') === 'subjectGroup' ? 'subject' : 'date';
    } catch { return 'date'; }
  });
  const pickGroupMode = v => { setGroupMode(v); try { localStorage.setItem('taskGroupMode', v); } catch {} };
  // 組內排序（只在依日期時出現）：time | priority | title，記起來下次開啟還是同一個。
  const [sortBy, setSortBy] = useState(() => {
    try {
      const saved = localStorage.getItem('taskSort');
      return ['time', 'priority', 'title'].includes(saved) ? saved : 'time';
    } catch { return 'time'; }
  });
  const pickSort = v => { setSortBy(v); try { localStorage.setItem('taskSort', v); } catch {} };
  const bySubject = groupMode === 'subject' && !['completed', 'trash'].includes(view.type);
  const toggleGroup = label => setCollapsedGroups(groups => {
    const next = new Set(groups);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    try { localStorage.setItem('taskCollapsedGroups', JSON.stringify([...next])); } catch {}
    return next;
  });
  const expandAllGroups = () => {
    setCollapsedGroups(new Set());
    try { localStorage.setItem('taskCollapsedGroups', '[]'); } catch {}
  };

  // 科目（＝清單）在側邊欄的順序，拿來當「依科目」的第一層排序
  const subjOrd = {};
  lists.forEach((l, i) => { subjOrd[String(l.id)] = i; });
  // numeric：課名裡的數字要照數值比大小，不然「單元10」會排在「單元2」前面
  const byLesson = new Intl.Collator('zh-Hant', { numeric: true }).compare;

  const sortFns = {
    time: defaultSort, // 依時間，同一天依課序
    priority: (a, b) => b.priority - a.priority || defaultSort(a, b),
    title: (a, b) => a.title.localeCompare(b.title, 'zh-Hant') || defaultSort(a, b),
  };
  // 依科目：科目已經是分組標題了，組內只要照課名排。
  const subjectSort = (a, b) => byLesson(a.title, b.title) || defaultSort(a, b);
  const applySort = list => [...list].sort(bySubject ? subjectSort : sortFns[sortBy]);
  // 已完成是歷史時間線，不應承接「任務」頁記住的科目分堆或優先級排序。
  // completed_at 是伺服器完成任務時寫入的 ISO 時間；舊資料沒有時間時以 id 新到舊穩定退化。
  const sortCompleted = list => [...list].sort((a, b) =>
    String(b.completed_at || '').localeCompare(String(a.completed_at || '')) || Number(b.id) - Number(a.id));

  // 「照科目分堆」用科目當分組標題，不看日期（日期還是顯示在每一列右邊）
  const groupBySubject = list => {
    const by = new Map();
    for (const t of list) {
      const k = String(t.list_id ?? '');
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(t);
    }
    return [...by.entries()]
      // 同序（例如科目已刪除）再依科目 id，避免分組順序隨 API 回應順序跳動。
      .sort((a, b) => ((subjOrd[a[0]] ?? 99) - (subjOrd[b[0]] ?? 99)) || a[0].localeCompare(b[0], 'en', { numeric: true }))
      .map(([k, l]) => [lists.find(x => String(x.id) === k)?.name || '未分科目', l]);
  };

  // 刪除/勾選立即從畫面消失，不等伺服器
  const [hidden, setHidden] = useState(new Set());
  // 樂觀覆蓋：編輯後畫面立刻變，不用等「存檔→重抓」兩趟往返；重抓回來就清掉
  const [over, setOver] = useState({});
  // id → { due_date, due_time }：長按拖曳到其他日期分區後，寫入完成前先顯示在新位置。
  const [dateMoves, setDateMoves] = useState({});
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
    // 拖曳改日期的樂觀位置：伺服器資料已是同一個日期才放掉，舊資料晚到時不會跳回原位。
    setDateMoves(m => {
      const ids = Object.keys(m);
      if (!ids.length) return m;
      const keep = ids.filter(id => {
        const t = tasks.find(x => String(x.id) === id);
        return t && (t.due_date || null) !== m[id].due_date;
      });
      return keep.length === ids.length ? m : Object.fromEntries(keep.map(id => [id, m[id]]));
    });
  }, [tasks]);
  const tvBase = Object.keys(over).length ? tasks.map(t => over[t.id] ? { ...t, ...over[t.id] } : t) : tasks;
  const tv = Object.keys(dateMoves).length ? tvBase.map(t => dateMoves[t.id] ? { ...t, ...dateMoves[t.id] } : t) : tvBase;
  const completedInList = view.type === 'list'
    ? tv.filter(t => !t.deleted && t.completed && Number(t.list_id) === Number(view.id) && !hidden.has(t.id))
    : [];
  const shownAll = tv.filter(t => matchView(t, view, { filters }) && !hidden.has(t.id));
  // 第一層 filters 只用在「任務」總表（tasks/all）；其餘視圖語意已由 view 決定，不套。
  const showChips = ['tasks', 'all'].includes(view.type);
  // 已完成與垃圾桶會累積大量歷史資料，也要能在手機上直接查找；只開搜尋，
  // 不把進行中任務的日期／科目／標籤篩選語意帶進封存視圖。
  const showQuickFind = ['tasks', 'all', 'completed', 'trash'].includes(view.type);
  const tdF = today();
  const weekEnd = addDays(tdF, 6);
  const chipFn = {
    all: () => true,
    today: t => t.due_date === tdF,
    week: t => t.due_date && t.due_date >= tdF && t.due_date <= weekEnd,
    overdue: t => !!overdueSince(t, tdF),
    priority: t => Number(t.priority) > 0,
    recurring: t => Boolean(t.recurring),
    // 過去排過、仍未完成的計畫任務 due_date 會是 NULL，但它是已逾期，不是未排程。
    unscheduled: t => !t.due_date && !overdueSince(t, tdF),
  };
  const availableTags = [...new Set(shownAll.flatMap(t => t.tags || []))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  const tagOptions = tagFilter && !availableTags.includes(tagFilter)
    ? [tagFilter, ...availableTags]
    : availableTags;
  // §K：科目（清單）過濾移進「任務」頁（取代側欄的 per-subject 清單）
  const matchesSubjectFilter = t => subjFilter === '__none__' ? t.list_id == null : String(t.list_id) === subjFilter;
  const subjFiltered = showChips && subjFilter ? shownAll.filter(matchesSubjectFilter) : shownAll;
  const chipFiltered = showChips ? subjFiltered.filter(chipFn[taskFilter] || chipFn.all) : shownAll;
  const tagFiltered = showChips && tagFilter ? chipFiltered.filter(t => (t.tags || []).includes(tagFilter)) : chipFiltered;
  const searchable = view.type === 'list' && showCompletedInList ? [...tagFiltered, ...completedInList] : tagFiltered;
  const shown = showQuickFind
    ? searchable.filter(t => taskMatchesQuery(t, quickFind, lists.find(l => Number(l.id) === Number(t.list_id))?.name))
    : searchable;
  // 排程計畫與學校作業各自有專屬日期 domain，不能用一般任務 PATCH 批次繞過。
  const reschedulableOverdue = shown.filter(t => !t.completed && t.due_date && t.due_date < tdF
    && t.plan_id == null && t.task_kind !== 'school_assignment');
  // 計畫任務與學校作業完成後仍是學習歷史的一部分；批次整理只碰一般任務。
  const clearableCompleted = shown.filter(t => t.completed && t.plan_id == null && t.task_kind !== 'school_assignment');
  const chipCount = k => (subjFilter ? shownAll.filter(matchesSubjectFilter) : shownAll).filter(chipFn[k]).length;
  const hasUnassigned = shownAll.some(t => t.list_id == null);
  // 和標籤篩選一樣：目前的篩選值即使不在選項裡（科目被刪、清單還沒載入、最後一筆未分科目
  // 被移走）也要保留成選項。否則下拉會視覺上退回「全部科目」但清單仍被濾空，再選「全部科目」
  // 也不會觸發 change。不自動清除，因為可能只是暫時零結果的合法篩選。
  const showUnassignedOption = hasUnassigned || subjFilter === '__none__';
  const subjFilterMissing = subjFilter && subjFilter !== '__none__'
    && !lists.some(l => String(l.id) === subjFilter);
  const sel = tv.find(t => t.id === selId);
  const trashMutationIds = useRef(new Set());
  const [trashPendingIds, setTrashPendingIds] = useState(new Set());
  const [trashErrors, setTrashErrors] = useState({});
  const emptyTrashBusyRef = useRef(false);
  const [emptyTrashBusy, setEmptyTrashBusy] = useState(false);
  const [emptyTrashError, setEmptyTrashError] = useState('');
  const clearCompletedBusyRef = useRef(false);
  const [clearCompletedBusy, setClearCompletedBusy] = useState(false);
  const beginTrashMutation = id => {
    // 清空垃圾桶和單筆還原／永久刪除會改同一批資料，必須同步互斥；只靠 disabled
    // 會留下一個 React 尚未重繪前的快速連點視窗，結果會由請求抵達順序決定。
    if (emptyTrashBusyRef.current) return false;
    if (trashMutationIds.current.has(id)) return false;
    trashMutationIds.current.add(id);
    setTrashPendingIds(ids => new Set([...ids, id]));
    setTrashErrors(errors => ({ ...errors, [id]: '' }));
    return true;
  };
  const finishTrashMutation = id => {
    trashMutationIds.current.delete(id);
    setTrashPendingIds(ids => { const next = new Set(ids); next.delete(id); return next; });
  };

  async function restore(t) {
    if (!beginTrashMutation(t.id)) return;
    try {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { deleted: false } });
    } catch (e) {
      // PATCH 回應遺失時先讀回確認；任務若已離開垃圾桶，就不要誤報失敗。
      try {
        const latest = await api('/tasks');
        const saved = Array.isArray(latest) && latest.find(item => Number(item.id) === Number(t.id));
        if (!saved || Boolean(saved.deleted)) {
          setTrashErrors(errors => ({ ...errors, [t.id]: e.message || '還原失敗，請再試一次。' }));
          finishTrashMutation(t.id);
          return;
        }
      } catch {
        setTrashErrors(errors => ({ ...errors, [t.id]: '無法確認任務是否已還原，請重新載入後再確認。' }));
        finishTrashMutation(t.id);
        return;
      }
    }
    setHidden(ids => new Set([...ids, t.id]));
    await reload('tasks').catch(() => setRefreshError('任務已還原，但畫面暫時無法重新載入。'));
    finishTrashMutation(t.id);
  }
  async function hardDel(t) {
    if (!window.confirm(`永久刪除「${t.title}」？無法復原`)) return;
    if (!beginTrashMutation(t.id)) return;
    try {
      await api(`/tasks/${t.id}?hard=1`, { method: 'DELETE' });
    } catch (e) {
      if (e.status >= 400 && e.status < 500) {
        setTrashErrors(errors => ({ ...errors, [t.id]: e.message || '永久刪除失敗，請再試一次。' }));
        finishTrashMutation(t.id);
        return;
      }
      // DELETE 可能已提交、只有回應遺失；讀回確認不存在後就視為成功，避免誤導重刪。
      try {
        const latest = await api('/tasks');
        if (!Array.isArray(latest)) throw new Error('任務資料不完整');
        if (latest.some(item => Number(item.id) === Number(t.id))) {
          setTrashErrors(errors => ({ ...errors, [t.id]: e.message || '永久刪除失敗，請再試一次。' }));
          finishTrashMutation(t.id);
          return;
        }
      } catch {
        setTrashErrors(errors => ({ ...errors, [t.id]: '無法確認任務是否已永久刪除，請重新載入後再確認。' }));
        finishTrashMutation(t.id);
        return;
      }
    }
    setHidden(ids => new Set([...ids, t.id]));
    await reload('tasks').catch(() => setRefreshError('任務已永久刪除，但畫面暫時無法重新載入。'));
    finishTrashMutation(t.id);
  }
  async function emptyTrash() {
    if (!window.confirm('清空垃圾桶？所有項目將永久刪除')) return;
    if (emptyTrashBusyRef.current || trashMutationIds.current.size > 0) return;
    emptyTrashBusyRef.current = true;
    setEmptyTrashBusy(true);
    setEmptyTrashError('');
    try {
      await api('/trash', { method: 'DELETE' });
    } catch (e) {
      if (e.status >= 400 && e.status < 500) {
        setEmptyTrashError(e.message || '清空垃圾桶失敗，請再試一次。');
        emptyTrashBusyRef.current = false;
        setEmptyTrashBusy(false);
        return;
      }
      // 清空只會永久刪除一般任務；Plan Task tombstone 會保留。回應遺失時依同一
      // 範圍讀回確認，避免已清空卻再要求使用者執行一次破壞性操作。
      try {
        const latest = await api('/tasks');
        if (!Array.isArray(latest)) throw new Error('任務資料不完整');
        if (latest.some(item => Boolean(item.deleted) && item.plan_id == null)) {
          setEmptyTrashError(e.message || '清空垃圾桶失敗，請再試一次。');
          emptyTrashBusyRef.current = false;
          setEmptyTrashBusy(false);
          return;
        }
      } catch {
        setEmptyTrashError('無法確認垃圾桶是否已清空，請重新載入後再確認。');
        emptyTrashBusyRef.current = false;
        setEmptyTrashBusy(false);
        return;
      }
    }
    // 本地投影要和伺服器實際刪除的範圍一致：整個垃圾桶（不受 Quick Find 影響）
    // 的一般待辦；計畫任務伺服器會保留 tombstone，畫面也必須留著可還原。
    setHidden(ids => new Set([...ids, ...shownAll.filter(t => t.plan_id == null).map(t => t.id)]));
    await reload('tasks').catch(() => setRefreshError('垃圾桶已清空，但畫面暫時無法重新載入。'));
    emptyTrashBusyRef.current = false;
    setEmptyTrashBusy(false);
  }
  // 拖曳排序（預設排序時才能拖）
  const [dragT, setDragT] = useState(null);
  // 新順序是從畫面上的清單算出來的；上一次排序還沒寫入並重新載入前，畫面仍是舊順序。
  // 這時再拖一次會用舊順序算出整批 ids，蓋掉剛寫入的那一次，所以同步上鎖到刷新結束。
  const reorderBusyRef = useRef(false);
  const reorderUncertainRef = useRef(false);
  async function dropOn(target, list) {
    if (!dragT || dragT.id === target.id) return;
    if (reorderBusyRef.current) { setDragT(null); return; }
    const ids = list.map(x => x.id).filter(id => id !== dragT.id);
    ids.splice(ids.indexOf(target.id), 0, dragT.id);
    setDragT(null);
    reorderBusyRef.current = true;
    setRefreshError('');
    try {
      await api('/tasks/reorder', { method: 'POST', body: { ids } });
    } catch (e) {
      // POST 可能已提交、只有回應遺失。依 GET /tasks 的正式 order_index 順序
      // 核對這批 id，避免使用者重拖後用舊畫面順序覆蓋已成功的排序。
      try {
        const latest = await api('/tasks');
        const wanted = ids.map(String);
        const wantedSet = new Set(wanted);
        const saved = Array.isArray(latest)
          ? latest.map(task => String(task.id)).filter(id => wantedSet.has(id)) : [];
        if (saved.length !== wanted.length || saved.some((id, index) => id !== wanted[index])) {
          setRefreshError(e.message || '排序沒有儲存成功，請再試一次。');
          reorderBusyRef.current = false;
          return;
        }
      } catch {
        reorderUncertainRef.current = true;
        setRefreshError('無法確認排序是否已儲存，請先重新載入；確認前請勿再次拖曳。');
        return;
      }
    }
    // 寫入成功和重新載入是兩個邊界：刷新失敗時順序其實已存好，不能誤報成排序失敗。
    try { await reload('tasks'); }
    catch { setRefreshError('排序已儲存，但畫面暫時無法重新載入。'); }
    reorderBusyRef.current = false;
  }

  // 底部小提示（可復原，防誤按）
  const [toast, setToast] = useState(null);
  const [toastBusy, setToastBusy] = useState(false);
  const toastTimer = useRef(null);
  function showToast(msg, undo) {
    clearTimeout(toastTimer.current);
    setToast({ msg, undo });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }
  async function clearCompletedTasks() {
    if (!clearableCompleted.length || clearCompletedBusyRef.current) return;
    if (!window.confirm(`將 ${clearableCompleted.length} 項已完成的一般任務移到垃圾桶？`)) return;
    clearCompletedBusyRef.current = true;
    setClearCompletedBusy(true);
    setRefreshError('');
    const results = await Promise.allSettled(clearableCompleted.map(t => api(`/tasks/${t.id}`, { method: 'DELETE' })));
    const movedIds = new Set(clearableCompleted
      .filter((_, index) => results[index].status === 'fulfilled')
      .map(t => t.id));
    // 批次中個別 DELETE 可能已提交、只有回應遺失。用一次讀回核對所有失敗項，
    // 已進垃圾桶的照成功處理，避免畫面誤報失敗並讓使用者重做整批操作。
    if (results.some(result => result.status === 'rejected')) {
      try {
        const latest = await api('/tasks');
        if (Array.isArray(latest)) {
          for (const task of clearableCompleted) {
            const saved = latest.find(item => Number(item.id) === Number(task.id));
            if (saved?.deleted) movedIds.add(task.id);
          }
        }
      } catch { /* 保留原失敗結果；soft delete 可安全重試 */ }
    }
    const moved = clearableCompleted.filter(t => movedIds.has(t.id));
    const failed = results.length - moved.length;
    setHidden(ids => new Set([...ids, ...moved.map(t => t.id)]));
    if (moved.length) showToast(`已將 ${moved.length} 項已完成任務移到垃圾桶`, async () => {
      const restored = await Promise.allSettled(moved.map(t =>
        api(`/tasks/${t.id}`, { method: 'PATCH', body: { deleted: false } })));
      const restoredIds = new Set(moved
        .filter((_, index) => restored[index].status === 'fulfilled')
        .map(t => t.id));
      // 批次復原也可能只有回應遺失；一次讀回核對所有 rejected 項，避免其實已
      // 復原卻留在隱藏狀態並誤報失敗。
      if (restored.some(result => result.status === 'rejected')) {
        try {
          const latest = await api('/tasks');
          if (Array.isArray(latest)) {
            for (const task of moved) {
              const saved = latest.find(item => Number(item.id) === Number(task.id));
              if (saved && !saved.deleted) restoredIds.add(task.id);
            }
          }
        } catch { /* 保留原失敗結果；restore PATCH 可安全重試 */ }
      }
      const restoredTasks = moved.filter(t => restoredIds.has(t.id));
      const restoreFailed = moved.length - restoredTasks.length;
      if (restoredTasks.length) {
        setHidden(ids => { const next = new Set(ids); restoredTasks.forEach(t => next.delete(t.id)); return next; });
        await reload('tasks').catch(() => setRefreshError('任務已復原，但畫面暫時無法重新載入。'));
      }
      if (restoreFailed) throw new Error(`有 ${restoreFailed} 項無法復原，請到垃圾桶重試`);
    });
    try { await reload('tasks'); }
    catch { setRefreshError('任務已移到垃圾桶，但畫面暫時無法重新載入。'); }
    if (failed) setRefreshError(`已移動 ${moved.length} 項，另有 ${failed} 項失敗，請再試一次。`);
    clearCompletedBusyRef.current = false;
    setClearCompletedBusy(false);
  }
  async function undoToast() {
    if (!toast?.undo || toastBusy) return;
    clearTimeout(toastTimer.current);
    setToastBusy(true);
    try {
      await toast.undo();
      setToast(null);
    } catch (e) {
      setToast(t => t ? { ...t, error: e.message || '復原失敗，請再試一次' } : t);
    } finally {
      setToastBusy(false);
    }
  }
  const mutationIds = useRef(new Set());
  const [pendingIds, setPendingIds] = useState(new Set());
  const [mutationErrors, setMutationErrors] = useState({});
  const uncertainMutationIds = useRef(new Set());
  const [refreshError, setRefreshError] = useState(restoredDuplicateFence
    ? '正在確認剛才的任務是否已複製；確認前請勿再次複製。' : '');
  const [refreshBusy, setRefreshBusy] = useState(false);
  // 錯誤列的「重新載入」預設只重抓 tasks scope；習慣打卡刷新失敗時要整包重抓才看得到習慣。
  // 這個旗標在成功整包重抓前都保留，之後其他任務錯誤蓋掉文案也照樣整包重抓（tasks 是子集，不會漏）。
  const [refreshNeedsAll, setRefreshNeedsAll] = useState(false);
  const overdueRescheduleBusyRef = useRef(false);
  const overdueRescheduleUncertainRef = useRef(false);
  const [overdueRescheduleBusy, setOverdueRescheduleBusy] = useState(false);
  const duplicateBusyRef = useRef(Boolean(restoredDuplicateFence));
  const duplicateRestoreStartedRef = useRef(false);
  const duplicateTags = value => [...(value || [])].map(String).sort().join('\u0000');
  const duplicateSubtasks = value => JSON.stringify((value || []).map(item => ({
    title: String(item.title || ''), done: Boolean(item.done),
  })));
  const duplicateMatches = (candidate, body) => candidate.title === body.title
    && (candidate.list_id == null ? null : String(candidate.list_id)) === (body.list_id == null ? null : String(body.list_id))
    && (candidate.notes || '') === body.notes
    && (candidate.due_date || null) === body.due_date
    && (candidate.due_time || null) === body.due_time
    && (Number(candidate.priority) || 0) === body.priority
    && duplicateTags(candidate.tags) === duplicateTags(body.tags)
    && duplicateSubtasks(candidate.subtasks) === duplicateSubtasks(body.subtasks)
    && (candidate.recurring || null) === body.recurring
    && (candidate.miss_policy || 'keep') === body.miss_policy
    && (candidate.estimated_minutes ?? null) === body.estimated_minutes
    && (candidate.task_kind || 'task') === body.task_kind;
  useEffect(() => {
    if (!restoredDuplicateFence || duplicateRestoreStartedRef.current) return undefined;
    duplicateRestoreStartedRef.current = true;
    let cancelled = false;
    const confirmRestoredDuplicate = async () => {
      try {
        const latest = await api('/tasks');
        if (!Array.isArray(latest)) throw new Error('任務清單格式不正確');
        const committed = latest.some(candidate => !restoredDuplicateFence.beforeIds.includes(String(candidate.id))
          && duplicateMatches(candidate, restoredDuplicateFence.body));
        if (cancelled) return;
        if (committed) {
          clearTaskCreateFence(DUPLICATE_CREATE_FENCE_KEY, restoredDuplicateFence.owner);
          duplicateBusyRef.current = false;
          setRefreshError('');
          await reload('tasks').catch(() => {
          if (!cancelled) setRefreshError('任務已複製，但畫面暫時無法重新載入。');
          });
          return;
        }
        // 第一次讀回為空不能證明原請求沒有稍後完成；只用同一把 key 安全重送。
        await api('/tasks', { method: 'POST', body: restoredDuplicateFence.body });
        if (cancelled) return;
        clearTaskCreateFence(DUPLICATE_CREATE_FENCE_KEY, restoredDuplicateFence.owner);
        duplicateBusyRef.current = false;
        setRefreshError('');
        await reload('tasks').catch(() => {
          if (!cancelled) setRefreshError('任務已複製，但畫面暫時無法重新載入。');
        });
      } catch (error) {
        if (error?.status && error.status !== 409) {
          clearTaskCreateFence(DUPLICATE_CREATE_FENCE_KEY, restoredDuplicateFence.owner);
          duplicateBusyRef.current = false;
        }
        if (!cancelled) {
          setRefreshError(error?.status && error.status !== 409
            ? (error.message || '複製任務失敗，請再試一次。')
            : '仍無法確認任務是否已複製，請稍後重新載入；確認前請勿再次複製。');
        }
      }
    };
    confirmRestoredDuplicate();
    return () => { cancelled = true; };
  // 只處理掛載時承接的 fence；一般 tasks/reload 變化不能重送確認請求。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const beginMutation = id => {
    if (mutationIds.current.has(id)) return false;
    mutationIds.current.add(id);
    setPendingIds(s => new Set([...s, id]));
    setMutationErrors(e => ({ ...e, [id]: '' }));
    return true;
  };
  const finishMutation = id => {
    mutationIds.current.delete(id);
    setPendingIds(s => { const n = new Set(s); n.delete(id); return n; });
  };
  async function toggle(t) {
    if (!beginMutation(t.id)) return;
    const completed = !t.completed;
    try {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed } });
    } catch (e) {
      // 連線中斷不代表 PATCH 未提交；讀回確認後才決定是否允許再次切換。
      try {
        const latest = await api('/tasks');
        const saved = Array.isArray(latest) && latest.find(item => Number(item.id) === Number(t.id));
        if (!saved || Boolean(saved.completed) !== completed) {
          setMutationErrors(errors => ({ ...errors, [t.id]: e.message || '更新任務失敗，請再試一次' }));
          finishMutation(t.id);
          return;
        }
      } catch {
        uncertainMutationIds.current.add(t.id);
        const message = '無法確認任務是否已更新，請重新載入；確認前請勿再次切換。';
        setMutationErrors(errors => ({ ...errors, [t.id]: message }));
        setRefreshError(message);
        return;
      }
    }
    if (!(view.type === 'list' && showCompletedInList)) {
      setHidden(h => new Set([...h, t.id]));
    } else {
      setOver(o => ({ ...o, [t.id]: { ...t, completed: !t.completed } }));
    }
    if (!t.completed) showToast(`已完成「${t.title}」`, async () => {
      try {
        await api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: false } });
      } catch (e) {
        // 「復原」很常緊接在完成後使用；PATCH 回應遺失不代表沒有提交。
        // 先讀回確認，避免其實已復原卻顯示失敗並要求使用者再按一次。
        try {
          const latest = await api('/tasks');
          const saved = Array.isArray(latest) && latest.find(item => Number(item.id) === Number(t.id));
          if (!saved || Boolean(saved.completed)) throw e;
        } catch (checkError) {
          if (checkError === e) throw e;
          throw new Error('無法確認任務是否已復原，請重新載入後再確認。');
        }
      }
      setHidden(h => { const n = new Set(h); n.delete(t.id); return n; });
      await reload('tasks').catch(() => setRefreshError('任務已復原，但畫面暫時無法重新載入。'));
    });
    await reload('tasks').catch(() => setRefreshError('任務已更新，但畫面暫時無法重新載入。'));
    finishMutation(t.id);
  }
  // ── 長按拖曳改日期（375px 觸控）─────────────────────────────
  // 只動一般任務的 due_date／due_time：計畫任務的日期屬於 ScheduleVersion（generic PATCH
  // 會被伺服器以 409 拒絕），學校作業的 deadline 是老師給的期限，都不能用拖曳改。
  // 明細開著的那一筆也不行：明細自動儲存會把整份草稿（含舊 due_date）再送一次，蓋掉拖曳結果。
  const dateDragEnabled = !bySubject && !['completed', 'trash'].includes(view.type);
  const canMoveDate = t => dateDragEnabled && !t.completed && !t.deleted
    && t.plan_id == null && t.task_kind !== 'school_assignment'
    && t.id !== selId && !mutationIds.current.has(t.id) && !uncertainMutationIds.current.has(t.id);
  async function moveTaskDate(t, date) {
    const body = { due_date: date || null, due_time: date ? (t.due_time || null) : null };
    if (body.due_date === (t.due_date || null) || !canMoveDate(t)) return;
    if (!beginMutation(t.id)) return;
    setRefreshError('');
    setDateMoves(m => ({ ...m, [t.id]: body }));
    const rollback = message => {
      setDateMoves(m => { const next = { ...m }; delete next[t.id]; return next; });
      setMutationErrors(errors => ({ ...errors, [t.id]: message }));
    };
    try {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body });
    } catch (e) {
      if (e.status >= 400 && e.status < 500) {
        rollback(e.message || '日期沒有更新，已移回原位。');
        finishMutation(t.id);
        return;
      }
      // 回應遺失不代表沒有寫入：讀回核對後才決定成功或回復，絕不自動重送。
      try {
        const latest = await api('/tasks');
        const saved = Array.isArray(latest) && latest.find(item => Number(item.id) === Number(t.id));
        if (!saved || (saved.due_date || null) !== body.due_date || (saved.due_time || null) !== body.due_time) {
          rollback(e.message || '日期沒有更新，已移回原位。');
          finishMutation(t.id);
          return;
        }
      } catch {
        // 無法確認：畫面回到伺服器最後已知的位置，並鎖住這一筆直到重新載入。
        uncertainMutationIds.current.add(t.id);
        const message = '無法確認日期是否已更新，請重新載入；確認前請勿再次移動。';
        rollback(message);
        setRefreshError(message);
        return;
      }
    }
    // 新位置由 [tasks] effect 在伺服器資料確認同一日期後才放掉；舊回應晚到不會拉回原位。
    try {
      await reload('tasks');
    } catch {
      // 已寫入：保留新位置，只提示畫面暫時無法同步。
      setRefreshError('日期已更新，但畫面暫時無法重新載入。');
    }
    finishMutation(t.id);
  }
  // 拖到「其他日期…」：先開日期選擇器，選好才寫入。
  const [pickFor, setPickFor] = useState(null);
  const { drag: touchDrag, start: startTouchDrag0, justEnded } = useTouchDrag((t, target) => {
    if (target === PICK_DATE) { if (canMoveDate(t)) setPickFor(t); return; }
    moveTaskDate(t, target);
  });
  // 拖曳 overlay 只是視覺；狀態另外用 sr-only live region 宣告。
  const [dragAnnounce, setDragAnnounce] = useState('');
  const startTouchDrag = t => {
    if (!canMoveDate(t)) return;
    startTouchDrag0(t);
    setDragAnnounce(`已拿起「${t.title}」，拖到日期分區後放開`);
  };
  const selectFromRow = x => { if (justEnded()) return; selectTask(x); };
  // 拖曳中讓「今天／明天／無日期」即使沒有任務也出現，當作放置目標。
  const dropKeepEmpty = touchDrag ? [today(), addDays(today(), 1), ''] : [];
  // 清單控制列：375px 標題列只放標題與項數，分區切換與排序另起一列，不再擠在同一行。
  // 「依日期／依科目」決定怎麼分區；「排序方式」只在依日期時出現，決定每一區裡的順序。
  const listControls = !['trash', 'completed'].includes(view.type) && shown.length > 0 ? (
    <div className="row task-list-controls" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap', alignItems: 'center', margin: 'var(--sp-2) 0' }}>
      <SegmentedControl ariaLabel="分區方式" value={groupMode}
        options={[{ value: 'date', label: '依日期' }, { value: 'subject', label: '依科目' }]}
        onChange={pickGroupMode} />
      {!bySubject && shown.length > 1 && (
        <select aria-label="排序方式" value={sortBy} onChange={e => pickSort(e.target.value)} style={{ fontSize: 13 }}>
          <option value="time">依時間</option>
          <option value="priority">依優先級</option>
          <option value="title">依標題</option>
        </select>
      )}
      {collapsedGroups.size > 0 && (
        <button type="button" className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={expandAllGroups}>展開全部分組</button>
      )}
      {dateDragEnabled && shown.some(canMoveDate) && (
        <span className="ui-meta" style={{ flexBasis: '100%', fontSize: 12 }}>長按任務可移動日期</span>
      )}
    </div>
  ) : null;

  async function duplicateTask(t) {
    if (duplicateBusyRef.current) return;
    duplicateBusyRef.current = true;
    const body = {
      title: t.title,
      list_id: t.list_id ?? null,
      notes: t.notes || '',
      due_date: t.due_date || null,
      due_time: t.due_time || null,
      priority: Number(t.priority) || 0,
      tags: [...(t.tags || [])],
      subtasks: (t.subtasks || []).filter(s => !s.done).map(s => ({ ...s, done: false })),
      recurring: t.recurring || null,
      miss_policy: t.miss_policy || 'keep',
      estimated_minutes: t.estimated_minutes ?? null,
      task_kind: 'task',
      client_request_id: createRequestId('duplicate'),
    };
    // API 與畫面資料的 id 可能一邊是 number、一邊是 string；統一後才能排除原任務，
    // 否則回應遺失時可能把原任務誤認成「新複製成功」。
    const beforeIds = new Set(tasks.map(task => String(task.id)));
    const owner = currentUserId();
    if (owner) saveTaskCreateFence(DUPLICATE_CREATE_FENCE_KEY, { owner, body, beforeIds: [...beforeIds] });
    let committed = false;
    try {
      await api('/tasks', { method: 'POST', body });
      committed = true;
    } catch (e) {
      // POST 可能已寫入、只有回應遺失。先讀回確認，避免使用者重按後多一筆。
      try {
        const latest = await api('/tasks');
        committed = Array.isArray(latest)
          && latest.some(candidate => !beforeIds.has(String(candidate.id)) && duplicateMatches(candidate, body));
        if (!committed) {
          // 讀回暫時為空時，只能用同一把 key 重送，不能解鎖產生新 key。
          if (!owner) {
            setRefreshError(e.message || '複製任務失敗，請再試一次。');
            duplicateBusyRef.current = false;
            return;
          }
          try {
            await api('/tasks', { method: 'POST', body });
            committed = true;
          } catch (retryError) {
            if (retryError?.status && retryError.status !== 409) {
              if (owner) clearTaskCreateFence(DUPLICATE_CREATE_FENCE_KEY, owner);
              setRefreshError(retryError.message || '複製任務失敗，請再試一次。');
              duplicateBusyRef.current = false;
            } else {
              setRefreshError('無法確認任務是否已複製，請先重新載入；重新載入前請勿再次複製。');
            }
            return;
          }
        }
      } catch {
        // 無法判定是否已寫入時維持鎖定；重新載入成功後才允許下一次複製。
        setRefreshError('無法確認任務是否已複製，請先重新載入；重新載入前請勿再次複製。');
        return;
      }
    }
    showToast(`已複製「${t.title}」`);
    if (owner) clearTaskCreateFence(DUPLICATE_CREATE_FENCE_KEY, owner);
    try {
      await reload('tasks');
    } catch {
      setRefreshError('任務已複製，但畫面暫時無法重新載入。');
    }
    duplicateBusyRef.current = false;
  }
  const clearQuickDraft = () => {
    setQuick('');
    setQuickDue('');
    setQuickTime('');
    setQuickListId('');
    setQuickPriority(0);
    setQuickTag('');
    setQuickNotes('');
    setQuickRecurring('');
    setQuickErr('');
  };
  async function finishQuickCreate() {
    const owner = quickPendingRef.current?.owner;
    quickPendingRef.current = null;
    if (owner) clearTaskCreateFence(QUICK_CREATE_FENCE_KEY, owner);
    if (!mountedRef.current) return;
    clearQuickDraft();
    try { await reload('tasks'); }
    catch { setRefreshError('任務已新增，但畫面暫時無法重新載入。'); }
    quickBusyRef.current = false;
    setQuickBusy(false);
  }
  async function confirmQuickCreate(pending = quickPendingRef.current) {
    if (!pending) return;
    try {
      const latest = await api('/tasks');
      const committed = Array.isArray(latest)
        && latest.some(candidate => !pending.beforeIds.includes(String(candidate.id))
          && taskMatchesQuickCreate(candidate, pending.body));
      if (committed) {
        await finishQuickCreate();
        return;
      }
      // 讀回為空仍可能是原 POST 尚在完成；只以同一 key 重送。
      if (pending.owner && !pending.error?.status) {
        try {
          await api('/tasks', { method: 'POST', body: pending.body });
          await finishQuickCreate();
          return;
        } catch (retryError) {
          pending.error = retryError;
          if (retryError?.status && retryError.status !== 409) {
            clearTaskCreateFence(QUICK_CREATE_FENCE_KEY, pending.owner);
            quickPendingRef.current = null;
            quickBusyRef.current = false;
            if (mountedRef.current) {
              setQuickBusy(false);
              setQuickErr(retryError.message || '新增任務失敗');
            }
          } else if (mountedRef.current) {
            setQuickErr('仍無法確認任務是否已新增，請稍後再確認；確認前請勿重複送出。');
          }
          return;
        }
      }
    } catch {
      if (mountedRef.current) {
        setQuickErr('仍無法確認任務是否已新增，請稍後再確認；確認前請勿重複送出。');
      }
      return;
    }
    if (pending.owner) clearTaskCreateFence(QUICK_CREATE_FENCE_KEY, pending.owner);
    quickPendingRef.current = null;
    quickBusyRef.current = false;
    if (mountedRef.current) {
      setQuickBusy(false);
      setQuickErr(pending.error?.message || pending.error || '新增任務失敗');
    }
  }
  async function quickAdd(e) {
    e.preventDefault();
    if (quickComposing.current || !quick.trim() || quickBusyRef.current) return;
    const body = { title: quick.trim() };
    body.client_request_id = createRequestId('quick');
    if (view.type === 'list') body.list_id = view.id;
    if (view.type === 'today') body.due_date = today();
    const quickTags = new Set(view.type === 'tag' ? [view.tag] : []);
    // 先套目前檢視的預設值，再讓使用者於快速新增列明確覆寫。
    // 只送既有 Task 欄位，不引入文字猜測或新的資料語意。
    if (quickDue) body.due_date = quickDue;
    if (quickTime) {
      body.due_time = quickTime;
      // 時間必須落在某一天；只選時間時視為今天，和行動清單的快速輸入習慣一致。
      if (!body.due_date) body.due_date = today();
    }
    if (quickListId) body.list_id = Number(quickListId);
    if (quickPriority) body.priority = quickPriority;
    if (quickTag.trim()) quickTags.add(quickTag.trim());
    if (quickTags.size) body.tags = [...quickTags];
    if (quickNotes.trim()) body.notes = quickNotes.trim();
    if (quickRecurring) {
      body.recurring = quickRecurring;
      // 重複規則需要一個起算日；未選日期時從今天開始，避免建立後無法產生下一筆。
      if (!body.due_date) body.due_date = today();
    }
    // React state 要等重新 render 才生效；同步 ref 先上鎖，避免手機連點或同一輪
    // submit 重入建立兩筆相同任務。
    quickBusyRef.current = true;
    setQuickBusy(true); setQuickErr('');
    // api() 同步讀取 token 帶進這次請求；在同一個 tick 記下，草稿就屬於發出請求的那個身分。
    const owner = currentUserId();
    // 讀回資料的 id 可能是字串，畫面資料則是數字；統一後才能排除原有同內容任務，
    // 避免 POST 真正失敗時把舊任務誤認成這次快速新增成功。
    const beforeIds = tasks.map(task => String(task.id));
    const pending = { body, beforeIds, owner, error: null };
    quickPendingRef.current = pending;
    if (owner) saveTaskCreateFence(QUICK_CREATE_FENCE_KEY, { owner, body, beforeIds });
    try {
      await api('/tasks', { method: 'POST', body });
    } catch (err) {
      pending.error = err;
      await confirmQuickCreate(pending);
      return;
    }
    // 寫入成功和重新載入是兩個邊界。refresh 失敗時任務已存在，不能把它
    // 誤報成新增失敗或讓使用者重送 POST。
    await finishQuickCreate();
  }
  async function rescheduleOverdueToToday() {
    if (overdueRescheduleBusyRef.current || !reschedulableOverdue.length) return;
    overdueRescheduleBusyRef.current = true;
    setOverdueRescheduleBusy(true);
    setRefreshError('');
    const results = await Promise.allSettled(reschedulableOverdue.map(t =>
      api(`/tasks/${t.id}`, { method: 'PATCH', body: { due_date: tdF } })));
    let failed = results.filter(result => result.status === 'rejected').length;
    if (failed) {
      // PATCH 可能已寫入、只有回應遺失。批次操作若直接解鎖，使用者重按會把
      // 已成功的項目再送一次；先讀回正式值，只把仍未移到今天的項目算失敗。
      try {
        const latest = await api('/tasks');
        failed = results.reduce((count, result, index) => {
          if (result.status !== 'rejected') return count;
          const wanted = reschedulableOverdue[index];
          const saved = Array.isArray(latest) && latest.find(item => Number(item.id) === Number(wanted.id));
          return count + (!saved || saved.due_date !== tdF ? 1 : 0);
        }, 0);
      } catch {
        overdueRescheduleUncertainRef.current = true;
        setRefreshError('無法確認逾期任務是否已重新安排，請先重新載入；確認前請勿再次操作。');
        return;
      }
    }
    try { await reload('tasks'); }
    catch { setRefreshError('日期已更新，但畫面暫時無法重新載入。'); }
    if (failed) setRefreshError(`已重新安排 ${results.length - failed} 項，另有 ${failed} 項失敗，請再試一次。`);
    overdueRescheduleBusyRef.current = false;
    setOverdueRescheduleBusy(false);
  }
  // 儲存去抖動：不再每敲一個字就打 API＋全量重載（造成又慢又容易出錯）
  const saveTimer = useRef(null);
  const pendingSave = useRef(null);
  const saveChain = useRef(Promise.resolve());
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [closeRefreshCommitted, setCloseRefreshCommitted] = useState(false);
  function flushSave() {
    const t = pendingSave.current;
    pendingSave.current = null;
    if (!t) return saveChain.current;
    const { id, title, notes, due_date, due_time, deadline_date, deadline_time, estimated_minutes,
      priority, tags, subtasks, recurring, miss_policy, list_id, task_kind, school_assignment_type, plan_id } = t;
    const school = task_kind === 'school_assignment';
    const body = { title, notes, priority, tags, subtasks, list_id, task_kind };
    if (school) {
      Object.assign(body, { deadline_date, deadline_time, estimated_minutes, school_assignment_type });
    } else {
      Object.assign(body, { recurring, miss_policy });
      // Plan Task 的日期只能由 ScheduleVersion 改；即使值沒變也不能送 generic PATCH。
      if (plan_id == null) Object.assign(body, { due_date, due_time });
    }
    setSaveBusy(true);
    setSaveError('');
    const request = saveChain.current.catch(() => {}).then(() => api(`/tasks/${id}`, { method: 'PATCH', body }));
    saveChain.current = request;
    return request.then(() => {
      setSaveError('');
    }).catch(async err => {
      // PATCH 可能已提交但只有回應遺失。先讀回比對完整草稿，避免把成功誤報成失敗。
      try {
        const latest = await api('/tasks');
        const saved = Array.isArray(latest) && latest.find(item => Number(item.id) === Number(id));
        if (saved && taskMatchesPatch(saved, body)) {
          setSaveError('');
          return;
        }
      } catch {
        // PATCH 是覆寫同一組欄位，重試仍具冪等性；保留草稿並清楚說明目前無法確認。
        err = new Error('無法確認任務是否已儲存');
      }
      // 只有「目前最後一筆」失敗才能把自己的草稿放回待存區。若後面已有
      // 較新的 PATCH 排隊，舊失敗回應不能復活舊草稿，否則關閉明細時會再送
      // 舊內容並覆蓋已成功寫入的新版本。
      if (saveChain.current === request && !pendingSave.current) pendingSave.current = t;
      setSaveError(err?.message || '儲存失敗');
      throw err;
    }).finally(() => {
      if (saveChain.current === request) setSaveBusy(false);
    });
  }
  function save(t) {
    setCloseRefreshCommitted(false);
    setOver(o => ({ ...o, [t.id]: t }));   // 先讓畫面反映
    pendingSave.current = t;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { flushSave().catch(() => {}); }, 400);
  }
  async function closeDetail() {
    clearTimeout(saveTimer.current);
    try {
      await flushSave();
    } catch { return; }
    try {
      await reload('tasks');
      setSelId(null);
    } catch {
      setCloseRefreshCommitted(true);
      setSaveError('任務已儲存，但畫面暫時無法更新');
    }
  }
  async function retryCloseRefresh() {
    if (saveBusy) return;
    setSaveBusy(true);
    try {
      await reload('tasks');
      setCloseRefreshCommitted(false);
      setSaveError('');
      setSelId(null);
    } catch {
      setSaveError('任務已儲存，但畫面暫時無法更新');
    } finally { setSaveBusy(false); }
  }
  // 桌面版明細是側欄，清單列仍可點。待存區只放得下一筆草稿：直接切到別筆再編輯，
  // 會把上一筆還沒寫入（去抖動中、進行中或失敗待重試）的草稿擠掉而無聲遺失。
  // 所以切換和「完成」走同一道關卡：先把目前這筆寫入，失敗就留在原任務顯示錯誤。
  const selectBusyRef = useRef(false);
  async function selectTask(x) {
    if (selId == null || x.id === selId) { setSelId(x.id); return; }
    if (selectBusyRef.current) return;
    selectBusyRef.current = true;
    clearTimeout(saveTimer.current);
    try {
      await flushSave();
    } catch { return; }
    finally { selectBusyRef.current = false; }
    setCloseRefreshCommitted(false);
    setSaveError('');
    setSelId(x.id);
  }
  async function del(t) {
    if (!beginMutation(t.id)) return;
    try {
      await api(`/tasks/${t.id}`, { method: 'DELETE' });
    } catch (e) {
      // DELETE 可能已提交但回應遺失；讀回確認後才允許再次刪除。
      try {
        const latest = await api('/tasks');
        if (!Array.isArray(latest)) throw new Error('任務清單格式不正確');
        const saved = latest.find(item => Number(item.id) === Number(t.id));
        if (saved && !saved.deleted) {
          setMutationErrors(errors => ({ ...errors, [t.id]: e.message || '刪除任務失敗，請再試一次' }));
          finishMutation(t.id);
          return;
        }
      } catch {
        uncertainMutationIds.current.add(t.id);
        const message = '無法確認任務是否已刪除，請重新載入；確認前請勿再次操作。';
        setMutationErrors(errors => ({ ...errors, [t.id]: message }));
        setRefreshError(message);
        return;
      }
    }
    setHidden(h => new Set([...h, t.id]));
    setSelId(null);
    showToast(`已刪除「${t.title}」`, async () => {
      try {
        await api(`/tasks/${t.id}`, { method: 'PATCH', body: { deleted: false } });
      } catch (e) {
        // 復原刪除的 PATCH 也可能已提交、只有回應遺失。先讀回確認，避免任務
        // 其實已回到清單，卻誤報失敗並讓使用者再次送出同一個復原操作。
        try {
          const latest = await api('/tasks');
          const saved = Array.isArray(latest) && latest.find(item => Number(item.id) === Number(t.id));
          if (!saved || saved.deleted) throw e;
        } catch (checkError) {
          if (checkError === e) throw e;
          throw new Error('無法確認任務是否已復原，請重新載入後再確認。');
        }
      }
      setHidden(h => { const n = new Set(h); n.delete(t.id); return n; });
      await reload('tasks').catch(() => setRefreshError('任務已復原，但畫面暫時無法重新載入。'));
    });
    await reload('tasks').catch(() => setRefreshError('任務已刪除，但畫面暫時無法重新載入。'));
    finishMutation(t.id);
  }

  async function retryTaskRefresh() {
    if (refreshBusy) return;
    setRefreshBusy(true);
    const needsAll = refreshNeedsAll;
    try {
      await (needsAll ? reload() : reload('tasks'));
      setRefreshError('');
      const owner = currentUserId();
      if (owner) clearTaskCreateFence(DUPLICATE_CREATE_FENCE_KEY, owner);
      duplicateBusyRef.current = false;
      if (reorderUncertainRef.current) {
        reorderUncertainRef.current = false;
        reorderBusyRef.current = false;
      }
      if (overdueRescheduleUncertainRef.current) {
        overdueRescheduleUncertainRef.current = false;
        overdueRescheduleBusyRef.current = false;
        setOverdueRescheduleBusy(false);
      }
      for (const id of uncertainMutationIds.current) finishMutation(id);
      uncertainMutationIds.current.clear();
      if (needsAll) setRefreshNeedsAll(false);
    }
    catch { setRefreshError('仍然無法重新載入，請稍後再試。'); }
    finally { setRefreshBusy(false); }
  }

  // 今日習慣打卡：勾選框的狀態來自 props，要等刷新回來才會變。這段期間再點一次，
  // 送出的 undo 仍是舊畫面算的，使用者想「取消」會被當成再打一次卡，所以同步上鎖到刷新結束。
  const habitBusyRef = useRef(new Set());
  const [habitBusy, setHabitBusy] = useState(new Set());
  async function checkinHabit(h, done) {
    if (habitBusyRef.current.has(h.id)) return;
    habitBusyRef.current.add(h.id);
    setHabitBusy(s => new Set([...s, h.id]));
    const release = () => {
      habitBusyRef.current.delete(h.id);
      setHabitBusy(s => { const n = new Set(s); n.delete(h.id); return n; });
    };
    setRefreshError('');
    try {
      await api(`/habits/${h.id}/checkin`, { method: 'POST', body: { date: today(), undo: done } });
    } catch (e) {
      setRefreshError(e.message || '打卡沒有儲存成功，請再試一次。');
      release();
      return;
    }
    // 習慣不在 scope='tasks' 的重抓範圍內，要整包 reload 才看得到打卡結果。
    // 寫入成功和重新載入是兩個邊界：刷新失敗時打卡其實已存好，不能誤報成打卡失敗。
    try { await reload(); setRefreshNeedsAll(false); }
    catch {
      setRefreshNeedsAll(true);
      setRefreshError(done ? '已取消打卡，但畫面暫時無法重新載入。' : '已打卡，但畫面暫時無法重新載入。');
    }
    release();
  }

  // 願望清單：想做/要記得的事（無日期、無清單）
  const [wish, setWish] = useState('');
  const [wishBusy, setWishBusy] = useState(false);
  const [wishError, setWishError] = useState('');
  const wishBusyRef = useRef(false);
  const wishPendingRef = useRef(null);
  const wishComposing = useRef(false);
  const wishes = tv.filter(t => !t.list_id && !t.completed && !t.due_date && !t.deleted);
  async function finishWishCreate() {
    wishPendingRef.current = null;
    setWish('');
    setWishError('');
    try {
      await reload('tasks');
    } catch {
      setRefreshError('願望已新增，但畫面暫時無法重新載入。');
    }
    wishBusyRef.current = false;
    setWishBusy(false);
  }
  async function confirmWishCreate() {
    const pending = wishPendingRef.current;
    if (!pending) return;
    try {
      const latest = await api('/tasks');
      const committed = Array.isArray(latest) && latest.some(task =>
        !pending.beforeIds.includes(String(task.id))
        && task.title === pending.title
        && !task.list_id
        && !task.due_date);
      if (committed) {
        await finishWishCreate();
        return;
      }
    } catch {
      setWishError('仍無法確認願望是否已新增，請稍後再確認；確認前請勿重複送出。');
      return;
    }
    wishPendingRef.current = null;
    wishBusyRef.current = false;
    setWishBusy(false);
    setWishError(pending.error || '新增願望失敗，請再試一次。');
  }
  async function addWish(e) {
    e.preventDefault();
    if (wishComposing.current || wishBusyRef.current || !wish.trim()) return;
    wishBusyRef.current = true;
    setWishBusy(true);
    setWishError('');
    const title = wish.trim();
    // API／測試資料可能混用數字與字串 id；baseline 一律正規化，避免把既有
    // 同名願望誤認成這次 POST 已成功，進而清掉其實尚未建立的輸入。
    const beforeIds = tasks.map(task => String(task.id));
    try {
      await api('/tasks', { method: 'POST', body: { title } });
    } catch (e) {
      const pending = { title, beforeIds, error: e.message || '新增願望失敗，請再試一次。' };
      wishPendingRef.current = pending;
      try {
        const latest = await api('/tasks');
        const committed = Array.isArray(latest) && latest.some(task =>
          !beforeIds.includes(String(task.id))
          && task.title === title
          && !task.list_id
          && !task.due_date);
        if (committed) {
          await finishWishCreate();
          return;
        }
        wishPendingRef.current = null;
      } catch {
        setWishError('無法確認願望是否已新增，請先重新確認；確認前請勿重複送出。');
        return;
      }
      setWishError(e.message || '新增願望失敗，請再試一次。');
      wishBusyRef.current = false;
      setWishBusy(false);
      return;
    }
    await finishWishCreate();
  }

  return (
    <>
      <div className="main">
        <div className="main-head">
          {/* 大標題區只放標題與副標。數量與排序會擠掉大標題的份量，
              有 listLabel 的頁面（Today）改放到清單那一行去。 */}
          <div className="page-head-text">
            <h2>{title}</h2>
            {subtitle && <div className="head-sub">{subtitle}</div>}
          </div>
          {!listLabel && <span className="muted">{shown.length} 項</span>}
          {!listLabel && collapsedGroups.size > 0 && view.type === 'completed' && (
            <button type="button" className="btn sm ghost" onClick={expandAllGroups}>展開全部分組</button>
          )}
          {!listLabel && view.type === 'list' && completedInList.length > 0 && (
            <button type="button" className="btn sm ghost" aria-pressed={showCompletedInList}
              onClick={toggleCompletedInList}>
              {showCompletedInList ? '隱藏已完成' : `顯示已完成（${completedInList.length}）`}
            </button>
          )}
          {view.type === 'trash' && shown.length > 0 && (
            <button className="btn sm ghost" style={{ marginLeft: 'auto' }} disabled={emptyTrashBusy || trashPendingIds.size > 0}
              onClick={emptyTrash}>{emptyTrashBusy ? '清空中…' : '清空垃圾桶'}</button>
          )}
          {view.type === 'completed' && clearableCompleted.length > 0 && (
            <button className="btn sm ghost" style={{ marginLeft: 'auto' }} disabled={clearCompletedBusy}
              onClick={clearCompletedTasks}>
              {clearCompletedBusy ? '整理中…' : `移到垃圾桶（${clearableCompleted.length}）`}
            </button>
          )}
        </div>
        {/* §K：舊 Todo IA（學校作業／已完成／垃圾桶）從側欄移進「任務」頁的視圖切換列 */}
        {onNav && ['tasks', 'all', 'completed', 'trash'].includes(view.type) && (
          <div className="task-viewtabs" role="tablist" aria-label="任務視圖">
            {[['tasks', '任務', ['tasks', 'all']], ['school', '學校作業', ['school']], ['completed', '已完成', ['completed']], ['trash', '垃圾桶', ['trash']]].map(([type, label, actives]) => (
              <button key={type} role="tab" aria-selected={actives.includes(view.type)}
                className={'seg-tab' + (actives.includes(view.type) ? ' on' : '')} onClick={() => onNav({ type })}>{label}</button>
            ))}
          </div>
        )}
        {showQuickFind && (
          <>
            <div className="task-quick-find" role="search">
              <span aria-hidden="true">⌕</span>
              <input aria-label="搜尋目前任務" placeholder="搜尋標題、備註、標籤或科目" value={quickFind}
                onChange={e => setQuickFind(e.target.value)} />
              {quickFind && <button type="button" className="icon-btn" aria-label="清除任務搜尋" onClick={() => setQuickFind('')}>✕</button>}
            </div>
            {showChips && <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="task-filter" role="tablist" aria-label="任務篩選">
              {[['all', '全部'], ['today', '今天'], ['week', '本週'], ['overdue', '逾期'], ['priority', '有優先級'], ['recurring', '重複'], ['unscheduled', '未排程']].map(([k, label]) => {
                const n = k === 'all' ? 0 : chipCount(k);
                return (
                  <button key={k} role="tab" aria-selected={taskFilter === k}
                    className={'chip filter-chip' + (taskFilter === k ? ' on' : '')} onClick={() => pickFilter(k)}>
                    {label}{n > 0 ? <span className="filter-chip-n">{n}</span> : ''}
                  </button>
                );
              })}
              </div>
              {(lists.length > 0 || showUnassignedOption || subjFilterMissing) && (
                <select aria-label="依科目篩選" value={subjFilter} onChange={e => pickSubjectFilter(e.target.value)}
                  style={{ marginLeft: 'auto', fontSize: 13 }}>
                  <option value="">全部科目</option>
                  {subjFilterMissing && <option value={subjFilter}>找不到的科目</option>}
                  {showUnassignedOption && <option value="__none__">未分科目</option>}
                  {lists.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                </select>
              )}
              {tagOptions.length > 0 && (
                <select aria-label="依標籤篩選" value={tagFilter} onChange={e => pickTagFilter(e.target.value)}
                  style={{ fontSize: 13 }}>
                  <option value="">全部標籤</option>
                  {tagOptions.map(tag => <option key={tag} value={tag}>標籤：{tag}</option>)}
                </select>
              )}
              {hasActiveFilters && (
                <button type="button" className="btn sm ghost" onClick={clearTaskFilters}>清除篩選</button>
              )}
              {taskFilter === 'overdue' && reschedulableOverdue.length > 0 && (
                <button type="button" className="btn sm" disabled={overdueRescheduleBusy}
                  onClick={rescheduleOverdueToToday}>
                  {overdueRescheduleBusy ? '重新安排中…' : `全部移到今天（${reschedulableOverdue.length}）`}
                </button>
              )}
            </div>}
          </>
        )}
        {!['completed', 'trash', 'search'].includes(view.type) && (
          <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
            <form className="quick-add task-quick-add" style={{ flex: 1 }} onSubmit={quickAdd}>
              <input placeholder="＋ 新增任務，按 Enter 儲存" value={quick}
                onChange={e => { setQuick(e.target.value); if (quickErr) setQuickErr(null); }}
                onCompositionStart={() => { quickComposing.current = true; }}
                onCompositionEnd={() => { quickComposing.current = false; }}
                onKeyDown={e => { if (e.key === 'Enter' && (e.isComposing || e.nativeEvent?.isComposing)) e.preventDefault(); }}
                aria-invalid={quickErr ? 'true' : undefined} disabled={quickBusy} />
              {quick.trim() && (
                <div className="task-quick-actions" aria-label="快速新增選項">
                  <button type="button" className={'chip' + (quickDue === today() ? ' on' : '')}
                    aria-pressed={quickDue === today()} onClick={() => setQuickDue(d => d === today() ? '' : today())}>今天</button>
                  <button type="button" className={'chip' + (quickDue === addDays(today(), 1) ? ' on' : '')}
                    aria-pressed={quickDue === addDays(today(), 1)} onClick={() => setQuickDue(d => d === addDays(today(), 1) ? '' : addDays(today(), 1))}>明天</button>
                  <button type="button" className={'chip' + (quickDue === thisWeekend() ? ' on' : '')}
                    aria-pressed={quickDue === thisWeekend()} onClick={() => setQuickDue(d => d === thisWeekend() ? '' : thisWeekend())}>本週末</button>
                  <button type="button" className={'chip' + (quickDue === nextWeek() ? ' on' : '')}
                    aria-pressed={quickDue === nextWeek()} onClick={() => setQuickDue(d => d === nextWeek() ? '' : nextWeek())}>下週</button>
                  <input type="date" aria-label="快速新增日期" value={quickDue} onChange={e => setQuickDue(e.target.value)} />
                  <input type="time" aria-label="快速新增時間" value={quickTime} onChange={e => setQuickTime(e.target.value)} />
                  {lists.length > 0 && (
                    <select aria-label="快速新增科目" value={quickListId} onChange={e => setQuickListId(e.target.value)}>
                      <option value="">不分科目</option>
                      {lists.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                    </select>
                  )}
                  <select aria-label="快速新增優先級" value={quickPriority} onChange={e => setQuickPriority(Number(e.target.value))}>
                    <option value="0">一般</option>
                    <option value="3">高優先</option>
                    <option value="2">中優先</option>
                    <option value="1">低優先</option>
                  </select>
                  <select aria-label="快速新增重複規則" value={quickRecurring} onChange={e => setQuickRecurring(e.target.value)}>
                    <option value="">不重複</option>
                    <option value="daily">每天</option>
                    <option value="weekly">每週</option>
                    <option value="monthly">每月</option>
                    <option value="yearly">每年</option>
                    <option value="weekdays">平日</option>
                  </select>
                  <input aria-label="快速新增標籤" list="task-quick-tag-options" placeholder="標籤（可新增）"
                    value={quickTag} onChange={e => setQuickTag(e.target.value)} />
                  <datalist id="task-quick-tag-options">
                    {availableTags.map(tag => <option key={tag} value={tag} />)}
                  </datalist>
                  <input aria-label="快速新增備註" placeholder="備註（選填）" value={quickNotes}
                    onChange={e => setQuickNotes(e.target.value)} />
                </div>
              )}
              {quickErr && (
                <div role="alert" className="ui-error" style={{ marginTop: 6 }}>
                  {quickErr}
                  {quickPendingRef.current && (
                    <button type="button" onClick={() => confirmQuickCreate()} style={{ marginLeft: 8 }}>
                      重新確認
                    </button>
                  )}
                </div>
              )}
            </form>
          </div>
        )}
        <div className="main-body">
          {emptyTrashError && <div role="alert" className="ui-error" style={{ marginBottom: 'var(--sp-3)' }}>{emptyTrashError}</div>}
          {refreshError && (
            <div role="alert" className="ui-error" style={{ marginBottom: 'var(--sp-3)' }}>
              {refreshError}
              <button type="button" disabled={refreshBusy} onClick={retryTaskRefresh} style={{ marginLeft: 8 }}>
                {refreshBusy ? '重新載入中…' : '重新載入'}
              </button>
            </div>
          )}
          {topSlot}
          {view.type === 'today' && <MemoCard goMemo={goMemo} />}
          {listLabel && shown.length > 0 && (
            <div className="row" style={{ marginTop: 'var(--section-gap)', marginBottom: 'var(--sp-2)' }}>
              <div className="ui-section-title" style={{ marginBottom: 0 }}>{listLabel}</div>
              <span className="muted">{shown.length} 項</span>
            </div>
          )}
          {listControls}
          {touchDrag && <div aria-hidden="true" className="ui-meta" style={dragHintStyle}>{DRAG_HINT}</div>}
          <div role="status" aria-live="polite" className="sr-only">{dragAnnounce}</div>
          {view.type === 'trash'
            ? shown.map(t => (
              <div key={t.id}>
                <div className="trow" style={{ cursor: 'default' }}>
                  <span className="title" style={{ color: 'var(--muted)' }}>{t.title}</span>
                  {t.due_date && <span className="muted">{zhDateShort(t.due_date)}</span>}
                  <button className="btn sm ghost" disabled={emptyTrashBusy || trashPendingIds.has(t.id)}
                    onClick={() => restore(t)}>{trashPendingIds.has(t.id) ? '處理中…' : '還原'}</button>
                  <button className="icon-btn" aria-label={`永久刪除「${t.title}」`}
                    disabled={emptyTrashBusy || trashPendingIds.has(t.id)} onClick={() => hardDel(t)}>✕</button>
                </div>
                {trashErrors[t.id] && <div role="alert" className="ui-error" style={{ margin: '4px 8px 0' }}>{trashErrors[t.id]}</div>}
              </div>
            ))
            : (view.type === 'list' && showCompletedInList
              ? [...groupTasks(shown.filter(t => !t.completed), view.type), ['已完成', shown.filter(t => t.completed)]]
              : (bySubject
                ? groupBySubject(shown) : groupTasks(shown, view.type, { keepEmpty: dropKeepEmpty }))).map(([label, list, dropDate]) => {
              const sorted = view.type === 'completed' ? sortCompleted(list) : applySort(list);
              // 桌機拖放排序寫入 order_index；只有「依日期＋依時間」時畫面順序才等於 order_index。
              const canDrag = !bySubject && sortBy === 'time';
              // 拖曳中展開所有可放置的分區，收合的分區也能放進去。
              const collapsed = collapsedGroups.has(label) && !(touchDrag && dropDate !== undefined);
              const isDropZone = dateDragEnabled && dropDate !== undefined;
              const dropOver = touchDrag && isDropZone && touchDrag.target === dropDate;
              return (
                <div className={'tgroup' + (dropOver ? ' drop-over' : '')} key={label}
                  data-drop-date={isDropZone ? dropDate : undefined}
                  style={touchDrag && isDropZone ? dropZoneStyle(dropOver) : undefined}>
                  <button type="button" className="glabel task-group-toggle" aria-expanded={!collapsed}
                    aria-label={`${collapsed ? '展開' : '收合'}${label}`} onClick={() => toggleGroup(label)}>
                    <span className="task-group-chevron" aria-hidden="true">⌄</span>
                    {label}
                    {/* 照科目分堆時，日期分組不見了，「這一科欠了幾項」就沒地方看。
                        分堆的用途正是這個，所以把每一科的項數與逾期數寫在標頭上。 */}
                    {bySubject && <SubjectCounts list={sorted} />}
                  </button>
                  {!collapsed && sorted.map(t => <TaskRow key={t.id} t={t} lists={lists} sel={t.id === selId} onSel={selectFromRow} onToggle={toggle}
                    onDragStart={canDrag ? setDragT : undefined}
                    onDropOn={canDrag ? x => dropOn(x, sorted) : undefined}
                    onLongPressDrag={canMoveDate(t) ? startTouchDrag : undefined} dragging={touchDrag?.id === t.id}
                    onMoveDate={canMoveDate(t) ? x => { if (!justEnded() && canMoveDate(x)) setPickFor(x); } : undefined}
                    onSwipeDelete={del} mutationBusy={pendingIds.has(t.id)} mutationError={mutationErrors[t.id]} />)}
                </div>
              );
            })}
          {touchDrag && dateDragEnabled && (
            <div className="tgroup" data-drop-date={PICK_DATE} style={dropZoneStyle(touchDrag.target === PICK_DATE)}>
              <div className="glabel">其他日期…</div>
            </div>
          )}
          {pickFor && <DatePickSheet title={pickFor.title} initial={pickFor.due_date || ''}
            onClose={() => setPickFor(null)}
            onPick={date => { const t = pickFor; setPickFor(null); moveTaskDate(t, date); }} />}
          {shown.length === 0 && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>
            {showQuickFind && quickFind.trim() ? '找不到符合搜尋的任務' : '沒有任務'}
          </div>}

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
                    <input type="checkbox" checked={done} aria-label={`${h.name} 今日打卡`}
                      disabled={habitBusy.has(h.id)} aria-busy={habitBusy.has(h.id)}
                      onChange={() => checkinHabit(h, done)} />
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
              {wishes.map(t => <TaskRow key={t.id} t={t} lists={lists} sel={t.id === selId} onSel={selectTask} onToggle={toggle} onSwipeDelete={del} />)}
              <form onSubmit={addWish} aria-busy={wishBusy} style={{ marginTop: 6 }}>
                <input placeholder="＋ 記一件想做的事…" value={wish} disabled={wishBusy}
                  aria-invalid={wishError ? 'true' : undefined}
                  onChange={e => { setWish(e.target.value); if (wishError) setWishError(''); }}
                  onCompositionStart={() => { wishComposing.current = true; }}
                  onCompositionEnd={() => { wishComposing.current = false; }}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.isComposing || e.nativeEvent?.isComposing)) e.preventDefault(); }}
                  style={{ width: '100%', background: 'var(--bg)', border: '1px dashed var(--border)' }} />
                {wishError && (
                  <div role="alert" className="ui-error" style={{ marginTop: 6 }}>
                    {wishError}
                    {wishPendingRef.current && (
                      <button type="button" onClick={confirmWishCreate} style={{ marginLeft: 8 }}>重新確認</button>
                    )}
                  </div>
                )}
              </form>
            </div>
          )}

          {view.type === 'today' && <VocabCard goVocab={goVocab} />}
        </div>
      </div>
      {sel && <Detail key={sel.id} task={sel} lists={lists} onSave={save} onDelete={del} onDuplicate={duplicateTask} onClose={closeDetail}
        saveBusy={saveBusy} saveError={saveError} refreshCommitted={closeRefreshCommitted} onRetryRefresh={retryCloseRefresh} />}
      {toast && (
        <div className="toast" role={toast.error ? 'alert' : 'status'}>
          <span>{toast.msg}</span>
          {toast.error && <span>{toast.error}</span>}
          <button disabled={toastBusy} onClick={undoToast}>{toastBusy ? '復原中…' : '復原'}</button>
        </div>
      )}
    </>
  );
}
