import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { BottomSheet, Button, SegmentedControl } from './ui';
import {
  SCHOOL_ASSIGNMENT_TYPES, TYPE_LABEL, REMINDER_OPTIONS, DEFAULT_REMINDER_TIME,
  deadlineLabelText, reminderSelectionToFields, reminderFieldsToSelection, isTime,
} from './schoolAssignment';

const CREATE_FENCE_KEY = 'tt-school-assignment-create-fence-v1';
const currentUserId = () => {
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const id = JSON.parse(json)?.userId;
    return id == null ? null : String(id);
  } catch { return null; }
};
const loadCreateFence = () => {
  try {
    const raw = sessionStorage.getItem(CREATE_FENCE_KEY);
    if (!raw) return null;
    const fence = JSON.parse(raw);
    const owner = currentUserId();
    if (!owner || fence?.owner !== owner || !fence?.body?.client_request_id || !Array.isArray(fence?.beforeIds)) {
      sessionStorage.removeItem(CREATE_FENCE_KEY);
      return null;
    }
    return fence;
  } catch {
    try { sessionStorage.removeItem(CREATE_FENCE_KEY); } catch {}
    return null;
  }
};
const saveCreateFence = fence => {
  try { sessionStorage.setItem(CREATE_FENCE_KEY, JSON.stringify(fence)); } catch {}
};
const clearCreateFence = owner => {
  try {
    const fence = JSON.parse(sessionStorage.getItem(CREATE_FENCE_KEY) || 'null');
    if (!fence || fence.owner === owner) sessionStorage.removeItem(CREATE_FENCE_KEY);
  } catch { try { sessionStorage.removeItem(CREATE_FENCE_KEY); } catch {} }
};
const createRequestId = () => globalThis.crypto?.randomUUID?.()
  || `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;

// 新增／編輯學校作業。走既有的 POST /api/tasks 與 PATCH /api/tasks/:id，
// task_kind='school_assignment'——沒有專屬 endpoint、沒有第二套 domain。
//
// 期限一律走 deadline_date / deadline_time，絕不寫 due_date / due_time（後者是
// 排程結果的鏡射）。清單只列自己的科目：學校作業不能建立在分享進來的清單上。
export default function SchoolAssignmentForm({ lists = [], tasks = [], task = null, defaultReminderTime = DEFAULT_REMINDER_TIME, onClose, onSaved }) {
  const editing = !!task;
  const ownLists = useMemo(() => lists.filter(l => !l.shared_in), [lists]);
  const [restoredFence] = useState(() => editing ? null : loadCreateFence());
  const initial = task || restoredFence?.body || {};
  const [f, setF] = useState(() => ({
    list_id: initial.list_id != null ? String(initial.list_id) : (ownLists[0]?.id != null ? String(ownLists[0].id) : ''),
    title: initial.title || '',
    school_assignment_type: SCHOOL_ASSIGNMENT_TYPES.includes(initial.school_assignment_type) ? initial.school_assignment_type : 'homework',
    deadline_date: initial.deadline_date || '',
    deadline_time: initial.deadline_time || '',
    notes: initial.notes || '',
    estimated_minutes: initial.estimated_minutes != null ? String(initial.estimated_minutes) : '',
    reminder_sel: reminderFieldsToSelection(initial),
    reminder_custom_date: initial.reminder_custom_date || '',
    reminder_time_override: initial.reminder_time_override || '',
  }));
  const [err, setErr] = useState(restoredFence ? '正在確認剛才的作業是否已建立；確認前不會再次送出。' : '');
  const [busy, setBusy] = useState(false);
  // state 要等 React 重新 render 才會更新；手機連點或同一輪事件內重複 submit
  // 可能在 busy 變成 true 前再進來。ref 在第一個請求前同步上鎖。
  const submitBusy = useRef(Boolean(restoredFence));
  const pendingSave = useRef(restoredFence ? {
    body: restoredFence.body, beforeIds: new Set(restoredFence.beforeIds), owner: restoredFence.owner, error: null,
  } : null);
  const up = patch => setF(v => ({ ...v, ...patch }));

  const needsCustomDate = f.reminder_sel === 'custom';
  const remindsAtAll = f.reminder_sel !== 'none';

  const matchesSave = (candidate, body) => candidate.task_kind === 'school_assignment'
    && Number(candidate.list_id) === body.list_id
    && candidate.title === body.title
    && candidate.school_assignment_type === body.school_assignment_type
    && candidate.deadline_date === body.deadline_date
    && (candidate.deadline_time || null) === body.deadline_time;

  async function finishSaved(saved) {
    const owner = pendingSave.current?.owner;
    pendingSave.current = null;
    if (owner) clearCreateFence(owner);
    try { await onSaved?.(saved); } catch { /* 資料已寫入；下次 reload 仍會讀回 */ }
    onClose?.();
  }

  async function resolvePending() {
    const pending = pendingSave.current;
    if (!pending) return;
    setBusy(true);
    try {
      const latest = await api('/tasks');
      const saved = Array.isArray(latest) && latest.find(candidate =>
        (editing ? candidate.id === task.id : !pending.beforeIds.has(candidate.id))
        && matchesSave(candidate, pending.body));
      if (saved) { await finishSaved(saved); return; }
      // 網路中斷時，讀回暫時沒看到資料仍不能證明原 POST 不會稍後完成。
      // 建立作業只能用同一把 client_request_id 重送；伺服器會回原 Task，
      // 絕不能產生新 key，否則兩個延遲請求可能各自 INSERT 一筆。
      if (!editing && pending.owner && !pending.error?.status) {
        try {
          const retried = await api('/tasks', { method: 'POST', body: pending.body });
          await finishSaved(retried);
          return;
        } catch (retryError) {
          pending.error = retryError;
          saveCreateFence({
            owner: pending.owner, body: pending.body, beforeIds: [...pending.beforeIds],
          });
          setErr(retryError?.status && retryError.status !== 409
            ? (retryError.message || '儲存失敗')
            : '仍然無法確認作業是否已儲存，請稍後再重新載入。');
          if (retryError?.status && retryError.status !== 409) {
            clearCreateFence(pending.owner);
            pendingSave.current = null;
            submitBusy.current = false;
          }
          setBusy(false);
          return;
        }
      }
      if (pending.owner) clearCreateFence(pending.owner);
      pendingSave.current = null;
      setErr(pending.error?.message || '儲存失敗');
      submitBusy.current = false;
      setBusy(false);
    } catch {
      if (pending.owner) saveCreateFence({
        owner: pending.owner, body: pending.body, beforeIds: [...pending.beforeIds],
      });
      setErr('仍然無法確認作業是否已儲存，請稍後再重新載入。');
      setBusy(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (submitBusy.current) return;
    setErr('');
    if (!f.title.trim()) return setErr('請輸入標題');
    if (!f.list_id) return setErr('請選擇科目');
    if (!f.deadline_date) return setErr(`請填寫${deadlineLabelText(f)}日期`);
    if (f.deadline_time && !isTime(f.deadline_time)) return setErr('截止時間格式不正確');
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
    const owner = editing ? null : currentUserId();
    if (!editing) body.client_request_id = createRequestId();
    submitBusy.current = true;
    setBusy(true);
    pendingSave.current = { body, beforeIds: new Set(tasks.map(item => item.id)), owner, error: null };
    // 先落下 fence 再送 POST：即使請求已送達伺服器後立刻刷新／卸載，
    // 下一次掛載也只會先讀回確認，不會因為看不到回應就再建立一筆。
    if (!editing && owner) saveCreateFence({
      owner, body, beforeIds: [...pendingSave.current.beforeIds],
    });
    let saved;
    try {
      saved = editing
        ? await api(`/tasks/${task.id}`, { method: 'PATCH', body })
        : await api('/tasks', { method: 'POST', body });
    } catch (e2) {
      pendingSave.current.error = e2;
      try { await resolvePending(); }
      catch { /* resolvePending 會保留可重新確認的狀態 */ }
      return;
    }
    // 寫入成功和重新整理是兩個不同邊界。reload 失敗不代表 POST/PATCH 失敗；
    // 若把兩者放在同一 catch，表單會留下並鼓勵重試，新增路徑就會建立重複作業。
    await finishSaved(saved);
  }

  useEffect(() => {
    if (!restoredFence) return;
    resolvePending();
  // 只確認本次掛載承接的 fence；表單欄位或 tasks 更新都不能重送。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deadlineLabel = deadlineLabelText(f);
  const unresolved = !!pendingSave.current;

  return (
    <BottomSheet onClose={busy || unresolved ? undefined : onClose} label={editing ? '編輯學校作業' : '新增學校作業'}>
      {/* §G2：鍵盤導覽與送出分離——在文字/日期/時間/數字欄位按 Enter 只是換行/移動，
          不會意外送出整張表單；只有明確按「新增作業／儲存」才送出（textarea/select 不受影響）。 */}
      <form onSubmit={submit} className="sa-form"
        onKeyDown={e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); }}>
        <h3 style={{ margin: '0 0 var(--sp-3)' }}>{editing ? '編輯學校作業' : '新增學校作業'}</h3>
        {err && <div className="ui-card ui-card--warning" role="alert" style={{ marginBottom: 'var(--sp-3)' }}>{err}{pendingSave.current && <button type="button" disabled={busy} onClick={resolvePending} style={{ marginLeft: 8 }}>{busy ? '重新載入中…' : '重新載入'}</button>}</div>}

        <label className="sa-field">
          <span>科目</span>
          <select value={f.list_id} onChange={e => up({ list_id: e.target.value })} required>
            <option value="">請選擇科目</option>
            {ownLists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {ownLists.length === 0 && <span className="ui-meta">還沒有科目。請先到「設定 → 科目」新增一個科目。</span>}
        </label>

        <label className="sa-field">
          <span>標題</span>
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
          <span>{deadlineLabel}日期</span>
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <input type="date" aria-label={`${deadlineLabel}日期`} value={f.deadline_date}
              onChange={e => up({ deadline_date: e.target.value })} />
            <input type="time" aria-label={`${deadlineLabel}時間（選填）`} value={f.deadline_time}
              onChange={e => up({ deadline_time: e.target.value })} />
          </div>
          <span className="ui-meta">不填時間＝當天結束以前都可以（不會顯示假的 23:59）。</span>
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
          <Button type="button" variant="tertiary" disabled={busy || unresolved} onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" style={{ marginLeft: 'auto' }} disabled={busy || unresolved}>
            {busy ? '儲存中…' : (editing ? '儲存' : '新增作業')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}
