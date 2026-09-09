import { useMemo, useState } from 'react';
import { api } from '../api';
import { BottomSheet, Button, SegmentedControl } from './ui';
import {
  SCHOOL_ASSIGNMENT_TYPES, TYPE_LABEL, REMINDER_OPTIONS, DEFAULT_REMINDER_TIME,
  deadlineLabelText, reminderSelectionToFields, reminderFieldsToSelection, isTime,
} from './schoolAssignment';

// 新增／編輯學校作業。走既有的 POST /api/tasks 與 PATCH /api/tasks/:id，
// task_kind='school_assignment'——沒有專屬 endpoint、沒有第二套 domain。
//
// 期限一律走 deadline_date / deadline_time，絕不寫 due_date / due_time（後者是
// 排程結果的鏡射）。清單只列自己的科目：學校作業不能建立在分享進來的清單上。
export default function SchoolAssignmentForm({ lists = [], task = null, defaultReminderTime = DEFAULT_REMINDER_TIME, onClose, onSaved }) {
  const editing = !!task;
  const ownLists = useMemo(() => lists.filter(l => !l.shared_in), [lists]);
  const [f, setF] = useState(() => ({
    list_id: task?.list_id != null ? String(task.list_id) : (ownLists[0]?.id != null ? String(ownLists[0].id) : ''),
    title: task?.title || '',
    school_assignment_type: SCHOOL_ASSIGNMENT_TYPES.includes(task?.school_assignment_type) ? task.school_assignment_type : 'homework',
    deadline_date: task?.deadline_date || '',
    deadline_time: task?.deadline_time || '',
    notes: task?.notes || '',
    estimated_minutes: task?.estimated_minutes != null ? String(task.estimated_minutes) : '',
    reminder_sel: reminderFieldsToSelection(task),
    reminder_custom_date: task?.reminder_custom_date || '',
    reminder_time_override: task?.reminder_time_override || '',
  }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const up = patch => setF(v => ({ ...v, ...patch }));

  const needsCustomDate = f.reminder_sel === 'custom';
  const remindsAtAll = f.reminder_sel !== 'none';

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!f.title.trim()) return setErr('請輸入作業名稱');
    if (!f.list_id) return setErr('請選擇科目');
    if (!f.deadline_date) return setErr(`請填寫${deadlineLabelText(f)}的日期`);
    if (f.deadline_time && !isTime(f.deadline_time)) return setErr('繳交時間格式不正確');
    if (needsCustomDate && !f.reminder_custom_date) return setErr('請選擇自訂提醒日期');
    const rem = reminderSelectionToFields(f.reminder_sel, {
      customDate: f.reminder_custom_date, timeOverride: f.reminder_time_override,
    });
    const body = {
      task_kind: 'school_assignment',
      list_id: +f.list_id,
      title: f.title.trim(),
      school_assignment_type: f.school_assignment_type,
      deadline_date: f.deadline_date,
      deadline_time: f.deadline_time || null,
      notes: f.notes || '',
      estimated_minutes: f.estimated_minutes === '' ? null : Number(f.estimated_minutes),
      ...rem,
    };
    setBusy(true);
    try {
      if (editing) await api(`/tasks/${task.id}`, { method: 'PATCH', body });
      else await api('/tasks', { method: 'POST', body });
      await onSaved?.();
      onClose?.();
    } catch (e2) {
      setErr(e2.message || '儲存失敗');
      setBusy(false);
    }
  }

  const deadlineLabel = deadlineLabelText(f);

  return (
    <BottomSheet onClose={onClose} label={editing ? '編輯學校作業' : '新增學校作業'}>
      <form onSubmit={submit} className="sa-form">
        <h3 style={{ margin: '0 0 var(--sp-3)' }}>{editing ? '編輯學校作業' : '新增學校作業'}</h3>
        {err && <div className="ui-card ui-card--warning" role="alert" style={{ marginBottom: 'var(--sp-3)' }}>{err}</div>}

        <label className="sa-field">
          <span>科目</span>
          <select value={f.list_id} onChange={e => up({ list_id: e.target.value })} required>
            <option value="">請選擇科目</option>
            {ownLists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {ownLists.length === 0 && <span className="ui-meta">還沒有科目。請先在側邊「清單」新增一個科目。</span>}
        </label>

        <label className="sa-field">
          <span>名稱</span>
          <input type="text" autoFocus value={f.title} placeholder="例如：第 3 章習題"
            onChange={e => up({ title: e.target.value })} />
        </label>

        <div className="sa-field">
          <span>類型</span>
          <SegmentedControl block ariaLabel="作業類型" value={f.school_assignment_type}
            onChange={v => up({ school_assignment_type: v })}
            options={SCHOOL_ASSIGNMENT_TYPES.map(t => ({ value: t, label: TYPE_LABEL[t] }))} />
        </div>

        <label className="sa-field">
          <span>{deadlineLabel}</span>
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <input type="date" aria-label={`${deadlineLabel}日期`} value={f.deadline_date}
              onChange={e => up({ deadline_date: e.target.value })} />
            <input type="time" aria-label={`${deadlineLabel}時間（可留空）`} value={f.deadline_time}
              onChange={e => up({ deadline_time: e.target.value })} />
          </div>
          <span className="ui-meta">不填時間＝當天結束以前都可以。</span>
        </label>

        <label className="sa-field">
          <span>提醒</span>
          <select value={f.reminder_sel} onChange={e => up({ reminder_sel: e.target.value })}>
            {REMINDER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {needsCustomDate && (
            <input type="date" aria-label="自訂提醒日期" value={f.reminder_custom_date}
              onChange={e => up({ reminder_custom_date: e.target.value })} style={{ marginTop: 'var(--sp-2)' }} />
          )}
          {remindsAtAll && (
            <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-2)', alignItems: 'center' }}>
              <span className="ui-meta" style={{ flex: 1 }}>提醒時間（留空用預設 {defaultReminderTime}）</span>
              <input type="time" aria-label="提醒時間" value={f.reminder_time_override}
                onChange={e => up({ reminder_time_override: e.target.value })} />
            </div>
          )}
          {remindsAtAll && (
            <span className="ui-meta">提醒只在 App 開著時出現；關掉分頁不會通知。可靠的背景通知還沒做。</span>
          )}
        </label>

        <label className="sa-field">
          <span>預計需要時間（分鐘，選填）</span>
          <input type="number" min="1" max="1440" value={f.estimated_minutes} placeholder="例如：60"
            onChange={e => up({ estimated_minutes: e.target.value })} />
        </label>

        <label className="sa-field">
          <span>備註（選填）</span>
          <textarea value={f.notes} rows={2} onChange={e => up({ notes: e.target.value })} />
        </label>

        <div className="row" style={{ marginTop: 'var(--sp-3)', gap: 'var(--sp-2)' }}>
          <Button type="button" variant="tertiary" onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" style={{ marginLeft: 'auto' }} disabled={busy}>
            {busy ? '儲存中…' : (editing ? '儲存' : '新增作業')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}
