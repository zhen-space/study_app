import { useState } from 'react';
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
function QuickTaskSheet({ onClose, onSaved }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('today');   // today | tomorrow | none
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e?.preventDefault?.();
    if (!title.trim() || busy) return;
    setBusy(true);
    const body = { title: title.trim() };
    if (due === 'today') body.due_date = today();
    else if (due === 'tomorrow') body.due_date = addDays(today(), 1);
    try { await api('/tasks', { method: 'POST', body }); await onSaved?.(); onClose?.(); }
    catch { setBusy(false); }
  };
  return (
    <BottomSheet onClose={onClose} label="新增任務">
      <form onSubmit={submit} className="ga-quick">
        <h3 style={{ margin: '0 0 var(--sp-3)' }}>新增任務</h3>
        <input aria-label="任務標題" value={title} placeholder="要做什麼？"
          onChange={e => setTitle(e.target.value)} style={{ width: '100%' }} />
        <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-3)', flexWrap: 'wrap' }}>
          {[['today', '今天'], ['tomorrow', '明天'], ['none', '不指定日期']].map(([v, l]) => (
            <button type="button" key={v} className={'tag-pill' + (due === v ? ' on' : '')} onClick={() => setDue(v)}>{l}</button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 'var(--sp-4)', gap: 'var(--sp-2)' }}>
          <Button type="button" variant="tertiary" onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" style={{ marginLeft: 'auto' }} disabled={!title.trim() || busy}>
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
export default function GlobalAdd({ lists = [], reload, defaultReminderTime, onPlan, onCalendarAdd }) {
  const [open, setOpen] = useState(false);     // 第一層選單
  const [flow, setFlow] = useState(null);      // 'school' | 'task'

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
        <SchoolAssignmentForm lists={lists} defaultReminderTime={defaultReminderTime}
          onClose={() => setFlow(null)} onSaved={async () => { await reload?.(); }} />
      )}
      {flow === 'task' && (
        <QuickTaskSheet onClose={() => setFlow(null)} onSaved={async () => { await reload?.(); }} />
      )}
    </>
  );
}
