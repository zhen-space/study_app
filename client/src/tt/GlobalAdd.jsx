import { useRef, useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';
import { BottomSheet, Button } from './ui';
import Icon from './Icons';
import SchoolAssignmentForm from './SchoolAssignmentForm';

// 全 App 統一的 Global Add（Phase 1 §A）。
//
// 右下角 ＋ 是**唯一**的新增入口——Today / Plans / Tasks / Calendar 共用同一顆，
// 各頁不再各自擺 ＋。第一層是固定順序的選單（不記住上次、不依最近使用重排、
// 不直接跳進 Quick Task、不自動叫鍵盤）：
//
//   1. 學校作業   2. 任務   3. 計畫   4. 行程   5. 重要日子
//
// 「開始讀書 / 匯入課表 / Google 連結」刻意不在這裡（§A1）。
const FIRST_LEVEL = [
  { kind: 'school', icon: 'book', label: '學校作業' },
  { kind: 'task', icon: 'all', label: '任務' },
  { kind: 'plan', icon: 'wizard', label: '計畫' },
  { kind: 'event', icon: 'calendar', label: '行程' },
  { kind: 'anniversary', icon: 'calendar', label: '重要日子' },
];

// 任務的第二層＝既有 Quick Task（沿用，不重寫）。日期用「今天／明天／不指定」，
// 不自動叫鍵盤前先讓使用者選好，Enter 或按鈕都能送出。
// 寫入成功和重新載入是兩個邊界：POST 成功後一律交給 onCreated（關閉＋刷新），
// 刷新失敗不能讓表單留著可再按，否則使用者以為沒存到、再按一次就多一筆。
const sameQuickTask = (task, body) => task.title === body.title
  && (task.due_date || '') === (body.due_date || '')
  && (task.due_time || '') === (body.due_time || '')
  && String(task.list_id ?? '') === String(body.list_id ?? '')
  && Number(task.priority || 0) === Number(body.priority || 0)
  && (task.notes || '') === (body.notes || '');

function QuickTaskSheet({ onClose, onCreated, tasks = [], lists = [] }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('today');   // today | tomorrow | none
  const [customDate, setCustomDate] = useState('');
  const [time, setTime] = useState('');
  const [listId, setListId] = useState('');
  const [priority, setPriority] = useState(0);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // state 要等重新 render 才生效；手機連點會在 busy 變 true 前再進來，用 ref 同步上鎖。
  const busyRef = useRef(false);
  const pendingRef = useRef(null);
  const resolvePending = (latestTasks, originalError) => {
    const pending = pendingRef.current;
    if (!pending) return false;
    const committed = latestTasks.some(task => !pending.beforeIds.has(String(task.id))
      && sameQuickTask(task, pending.body));
    pendingRef.current = null;
    if (committed) { onCreated?.(); return true; }
    setErr(originalError?.message || '任務沒有新增成功，已重新載入；可再次新增。');
    busyRef.current = false; setBusy(false);
    return false;
  };
  const submit = async e => {
    e?.preventDefault?.();
    if (!title.trim() || busyRef.current || pendingRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr('');
    const body = { title: title.trim() };
    if (due === 'today') body.due_date = today();
    else if (due === 'tomorrow') body.due_date = addDays(today(), 1);
    else if (due === 'custom' && customDate) body.due_date = customDate;
    if (time) {
      body.due_time = time;
      if (!body.due_date) body.due_date = today();
    }
    if (listId) body.list_id = Number(listId);
    if (priority) body.priority = priority;
    if (notes.trim()) body.notes = notes.trim();
    pendingRef.current = { body, beforeIds: new Set(tasks.map(task => String(task.id))) };
    try {
      await api('/tasks', { method: 'POST', body });
    } catch (e2) {
      try { resolvePending(await api('/tasks'), e2); }
      catch {
        setErr('無法確認任務是否新增，請重新載入；重新載入前請勿再次新增。');
        busyRef.current = false; setBusy(false);
      }
      return;
    }
    pendingRef.current = null;
    onCreated?.();
  };
  const retryConfirm = async () => {
    if (busyRef.current || !pendingRef.current) return;
    busyRef.current = true; setBusy(true);
    try { resolvePending(await api('/tasks')); }
    catch { setErr('仍然無法重新載入，請稍後再試。'); busyRef.current = false; setBusy(false); }
  };
  return (
    <BottomSheet onClose={busy ? undefined : onClose} label="新增任務">
      <form onSubmit={submit} className="ga-quick">
        <h3 style={{ margin: '0 0 var(--sp-3)' }}>新增任務</h3>
        {err && <div role="alert" className="ui-error" style={{ marginBottom: 'var(--sp-3)' }}>{err}{pendingRef.current && <button type="button" disabled={busy} onClick={retryConfirm}>{busy ? '重新載入中…' : '重新載入'}</button>}</div>}
        <input aria-label="任務標題" value={title} placeholder="要做什麼？"
          onChange={e => setTitle(e.target.value)} style={{ width: '100%' }} />
        <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-3)', flexWrap: 'wrap' }}>
          {[['today', '今天'], ['tomorrow', '明天'], ['none', '不指定日期']].map(([v, l]) => (
            <button type="button" key={v} className={'tag-pill' + (due === v ? ' on' : '')}
              aria-pressed={due === v} onClick={() => { setDue(v); setCustomDate(''); }}>{l}</button>
          ))}
        </div>
        <details className="ga-quick-more" style={{ marginTop: 'var(--sp-3)' }}>
          <summary>更多選項</summary>
          <div style={{ display: 'grid', gap: 'var(--sp-3)', marginTop: 'var(--sp-3)' }}>
            <label className="ui-field"><span className="ui-meta">日期</span>
              <input aria-label="任務日期" type="date" value={customDate}
                onChange={e => { setCustomDate(e.target.value); setDue(e.target.value ? 'custom' : 'none'); }} /></label>
            <label className="ui-field"><span className="ui-meta">時間</span>
              <input aria-label="任務時間" type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
            {lists.length > 0 && <label className="ui-field"><span className="ui-meta">科目</span>
              <select aria-label="任務科目" value={listId} onChange={e => setListId(e.target.value)}>
                <option value="">不分科目</option>
                {lists.map(list => <option key={list.id} value={String(list.id)}>{list.name}</option>)}
              </select></label>}
            <label className="ui-field"><span className="ui-meta">優先級</span>
              <select aria-label="任務優先級" value={priority} onChange={e => setPriority(Number(e.target.value))}>
                <option value="0">一般</option><option value="3">高優先</option>
                <option value="2">中優先</option><option value="1">低優先</option>
              </select></label>
            <label className="ui-field"><span className="ui-meta">備註</span>
              <textarea aria-label="任務備註" value={notes} rows="2" placeholder="補充頁碼、要帶的東西…"
                onChange={e => setNotes(e.target.value)} /></label>
          </div>
        </details>
        <div className="row" style={{ marginTop: 'var(--sp-4)', gap: 'var(--sp-2)' }}>
          <Button type="button" variant="tertiary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" style={{ marginLeft: 'auto' }} disabled={!title.trim() || busy || !!pendingRef.current}>
            {busy ? '新增中…' : '新增任務'}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

// props：
//   lists / reload            —— 建立學校作業用（沿用既有 SchoolAssignmentForm）
//   defaultReminderTime       —— 學校作業預設提醒時間
//   onPlan()                  —— 建立計畫（導向精靈）
//   onCalendarAdd('event'|'anniversary') —— 行程 / 重要日子（導向行事曆並開對應表單）
export default function GlobalAdd({ lists = [], tasks = [], reload, defaultReminderTime, onPlan, onCalendarAdd }) {
  const [open, setOpen] = useState(false);     // 第一層選單
  const [flow, setFlow] = useState(null);      // 'school' | 'task'
  // 已寫入但畫面刷新失敗：表單已關閉，這裡提示並只提供「重新載入」，不重送寫入。
  const [refreshError, setRefreshError] = useState('');
  const [refreshBusy, setRefreshBusy] = useState(false);
  const refreshAfterSave = async message => {
    setRefreshError('');
    try { await reload?.(); }
    catch { setRefreshError(message); }
  };
  const retryRefresh = async () => {
    if (refreshBusy) return;
    setRefreshBusy(true);
    try { await reload?.(); setRefreshError(''); }
    catch { setRefreshError('仍然無法重新載入，請稍後再試。'); }
    finally { setRefreshBusy(false); }
  };

  const pick = kind => {
    setOpen(false);
    if (kind === 'plan') { onPlan?.(); return; }
    if (kind === 'event' || kind === 'anniversary') { onCalendarAdd?.(kind); return; }
    setFlow(kind);   // school / task 在 Shell 層開 sheet
  };

  return (
    <>
      <button className="fab" aria-label="新增" onClick={() => setOpen(true)}><Icon name="plus" size={26} /></button>

      {open && (
        <BottomSheet onClose={() => setOpen(false)} label="新增">
          <h3 style={{ margin: '0 0 var(--sp-3)' }}>新增</h3>
          <div className="ga-list">
            {FIRST_LEVEL.map(o => (
              <button key={o.kind} type="button" className="ga-item" aria-label={'新增' + o.label} onClick={() => pick(o.kind)}>
                <Icon name={o.icon} size={18} style={{ opacity: .8 }} />
                <span>{o.label}</span>
                <Icon name="chevron" size={16} style={{ marginLeft: 'auto', opacity: .4 }} />
              </button>
            ))}
          </div>
        </BottomSheet>
      )}

      {flow === 'school' && (
        <SchoolAssignmentForm lists={lists} tasks={tasks} defaultReminderTime={defaultReminderTime}
          onClose={() => setFlow(null)} onSaved={() => refreshAfterSave('作業已儲存，但畫面暫時無法重新載入。')} />
      )}
      {flow === 'task' && (
        <QuickTaskSheet tasks={tasks} lists={lists} onClose={() => setFlow(null)}
          onCreated={() => { setFlow(null); refreshAfterSave('任務已新增，但畫面暫時無法重新載入。'); }} />
      )}
      {refreshError && (
        <div className="toast" role="alert">
          <span>{refreshError}</span>
          <button type="button" disabled={refreshBusy} onClick={retryRefresh}>
            {refreshBusy ? '重新載入中…' : '重新載入'}
          </button>
        </div>
      )}
    </>
  );
}
