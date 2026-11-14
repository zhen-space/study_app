import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { conflictText } from './scheduleAdjust';
import { BottomSheet, Button, SurfaceCard } from './ui';

const HM = t => (t || '').slice(0, 5);

// 確切安排的單一編輯入口：任務內容、排定日期與時段都在這裡修改。
// Task 欄位仍走 PATCH；日期／時段仍走 ScheduleVersion manual transaction。
export default function TimelineTaskEditSheet({ item, block, task, versionId, onSaved, onReload, onUncertain, onClose }) {
  const original = task || item || {};
  const [draft, setDraft] = useState({
    title: original.title || '',
    deadline_date: original.deadline_date || '',
    deadline_time: HM(original.deadline_time) || '',
    estimated_minutes: original.estimated_minutes == null ? '' : String(original.estimated_minutes),
    date: block?.date || '',
    timed: !!block?.start_time,
    start: HM(block?.start_time) || '19:00',
    end: HM(block?.end_time) || '20:00',
  });
  const [conflicts, setConflicts] = useState([]);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const composing = useRef(false);

  const taskBody = () => ({
    title: draft.title.trim(),
    deadline_date: draft.deadline_date || null,
    deadline_time: draft.deadline_date ? (draft.deadline_time || null) : null,
    estimated_minutes: draft.estimated_minutes === '' ? null : Number(draft.estimated_minutes),
  });
  const taskChanged = draft.title.trim() !== (original.title || '')
    || (draft.deadline_date || null) !== (original.deadline_date || null)
    || (draft.deadline_date ? (draft.deadline_time || null) : null) !== (original.deadline_time ? HM(original.deadline_time) : null)
    || (draft.estimated_minutes === '' ? null : Number(draft.estimated_minutes)) !== (original.estimated_minutes ?? null);
  const scheduleChanged = !!block && (draft.date !== block.date
    || draft.timed !== !!block.start_time
    || (draft.timed && (draft.start !== HM(block.start_time) || draft.end !== HM(block.end_time))));
  const move = () => ({
    block_id: block.block_id, date: draft.date,
    ...(draft.timed ? { start_time: draft.start, end_time: draft.end } : {}),
  });

  // 日期或時間停下 400ms 後，以既有 manual dry-run 做同一套衝突檢查。
  useEffect(() => {
    if (!scheduleChanged) { setConflicts([]); setChecking(false); setCheckFailed(false); return undefined; }
    let alive = true;
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const r = await api('/schedule/manual', {
          method: 'POST', body: { base_version_id: versionId, moves: [move()], dry_run: true },
        });
        if (alive) { setConflicts(r.conflicts || []); setCheckFailed(false); setError(''); }
      } catch (e) {
        if (alive) { setConflicts(e.conflicts || []); setCheckFailed(true); setError(e.message || '無法確認這個時間'); }
      } finally { if (alive) setChecking(false); }
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [draft.date, draft.timed, draft.start, draft.end, scheduleChanged, versionId]);

  async function save() {
    if (busy.current || composing.current || committed || checking || conflicts.length) return;
    const next = taskBody();
    if (!next.title) { setError('任務名稱不能空白'); return; }
    if (next.estimated_minutes != null && (!Number.isInteger(next.estimated_minutes) || next.estimated_minutes < 1 || next.estimated_minutes > 1440)) {
      setError('預估時間需介於 1 到 1440 分鐘'); return;
    }
    if (!taskChanged && !scheduleChanged) { onClose(); return; }
    busy.current = true; setSaving(true); setError('');

    // 先提交 stale-gated ScheduleVersion；成功後絕不重送同一 move。
    if (scheduleChanged) {
      try {
        await api('/schedule/manual', { method: 'POST', body: { base_version_id: versionId, moves: [move()] } });
      } catch (e) {
        // 409/4xx 或有結構化 conflicts 代表伺服器明確拒絕，可以修正後再試。
        // 網路錯誤則可能已提交，不能重送相同 move。
        if (!(e.status >= 400 && e.status < 500) && !e.conflicts?.length) {
          setCommitted(true); setUncertain(true);
          setError('日期／時間是否已儲存暫時無法確認，確認前不會再次送出。');
          busy.current = false; setSaving(false); return;
        }
        // 409 且沒有 conflicts 是 stale gate：畫面上的版本已過期，舊 block 不能再送，只能重新載入。
        if (e.status === 409 && !e.conflicts?.length) {
          setStale(true);
          setError(e.message || '排程已被其他變更更新，請重新載入後再編輯。');
          busy.current = false; setSaving(false); return;
        }
        setConflicts(e.conflicts || []);
        setError(e.message || '日期／時間儲存失敗');
        busy.current = false; setSaving(false); return;
      }
    }

    if (taskChanged) {
      try {
        await api(`/tasks/${item.task_id}`, { method: 'PATCH', body: next });
      } catch (e) {
        if (e.status >= 400 && e.status < 500) {
          if (scheduleChanged) {
            setCommitted(true);
            setError(`日期／時間已儲存，但任務內容未儲存：${e.message || '請重新開啟後再修改'}`);
          } else setError(e.message || '儲存失敗，請確認後再試。');
          busy.current = false; setSaving(false); return;
        }
        try {
          const rows = await api('/tasks');
          const saved = Array.isArray(rows) && rows.find(t => Number(t.id) === Number(item.task_id));
          const matches = saved && saved.title === next.title
            && (saved.deadline_date || null) === next.deadline_date
            && (saved.deadline_time ? HM(saved.deadline_time) : null) === next.deadline_time
            && (saved.estimated_minutes ?? null) === next.estimated_minutes;
          if (!matches) {
            if (scheduleChanged) {
              setCommitted(true);
              setError('日期／時間已儲存，但任務內容未儲存。請重新開啟後再修改。');
            } else setError(e.message || '儲存失敗，請稍後再試。');
            busy.current = false; setSaving(false); return;
          }
        } catch {
          setCommitted(true); setUncertain(true);
          setError(scheduleChanged
            ? '日期／時間已儲存；任務內容是否已儲存暫時無法確認，確認前不會再次送出。'
            : '無法確認任務是否已儲存；確認前不會再次送出。');
          busy.current = false; setSaving(false); return;
        }
      }
    }

    setCommitted(true);
    try {
      if (taskChanged) await onSaved(next);
      if (scheduleChanged && (await onReload?.()) === false) throw new Error('最新安排暫時無法載入');
      onClose();
    } catch (e) {
      setError(e.message || '變更已儲存，但畫面暫時無法更新。');
      busy.current = false; setSaving(false);
    }
  }

  // 結果未知時關閉：交給時間軸鎖住這一項，確認前不能再從列表重新送出。
  const close = () => {
    if (uncertain) onUncertain?.();
    onClose();
  };

  async function reloadToConfirm() {
    if (busy.current || (!committed && !stale)) return;
    busy.current = true; setSaving(true); setError('');
    try {
      const ok = await onReload?.();
      if (ok === false) throw new Error('仍然無法載入最新任務');
      onClose();
    } catch (e) {
      setError(e.message || '仍然無法載入最新任務，確認前不會再次送出。');
      busy.current = false; setSaving(false);
    }
  }

  const blocked = stale || checking || checkFailed || conflicts.length > 0 || (!taskChanged && !scheduleChanged);
  return (
    <BottomSheet onClose={saving ? undefined : close} label="編輯任務">
      <div className="row">
        <b>編輯任務</b>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="關閉" disabled={saving} onClick={saving ? undefined : close}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {committed ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <b>{uncertain ? '暫時無法確認儲存結果' : '變更已儲存'}</b>
          {error && <SurfaceCard tone="warning" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{error}</SurfaceCard>}
          <div className="row" style={{ marginTop: 'var(--sp-4)', gap: 'var(--sp-2)' }}>
            <Button variant="tertiary" disabled={saving} onClick={close}>先關閉</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={saving} onClick={reloadToConfirm}>
              {saving ? '載入中…' : '重新載入確認'}
            </Button>
          </div>
        </div>
      ) : <>
        <label className="sheet-sec" htmlFor="timeline-task-title" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>任務名稱</label>
        <input id="timeline-task-title" value={draft.title}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={e => { composing.current = false; setDraft(d => ({ ...d, title: e.currentTarget.value })); }}
          onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />

        {block && <>
          <label className="sheet-sec" htmlFor="timeline-task-date" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>日期</label>
          <input id="timeline-task-date" type="date" value={draft.date} onChange={e => setDraft(d => ({ ...d, date: e.target.value }))} />
          <label className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
            <input type="checkbox" checked={draft.timed} onChange={e => setDraft(d => ({ ...d, timed: e.target.checked }))} />
            <span>指定時間</span>
          </label>
          {draft.timed && <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
            <input type="time" aria-label="開始時間" value={draft.start} onChange={e => setDraft(d => ({ ...d, start: e.target.value }))} />
            <span className="ui-meta">至</span>
            <input type="time" aria-label="結束時間" value={draft.end} onChange={e => setDraft(d => ({ ...d, end: e.target.value }))} />
          </div>}
        </>}

        <label className="sheet-sec" htmlFor="timeline-task-deadline" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>最晚完成日</label>
        <input id="timeline-task-deadline" type="date" value={draft.deadline_date}
          onChange={e => setDraft(d => ({ ...d, deadline_date: e.target.value }))} />
        <label className="sheet-sec" htmlFor="timeline-task-deadline-time" style={{ display: 'block', marginTop: 'var(--sp-3)' }}>最晚完成時間</label>
        <input id="timeline-task-deadline-time" type="time" value={draft.deadline_time}
          disabled={!draft.deadline_date}
          onChange={e => setDraft(d => ({ ...d, deadline_time: e.target.value }))} />
        {!block && <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
          這項目前沒有每日排程；可先修改最晚完成日期與時間。
        </div>}
        <label className="sheet-sec" htmlFor="timeline-task-estimate" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>預估時間（分鐘）</label>
        <input id="timeline-task-estimate" type="number" min="1" max="1440" inputMode="numeric"
          value={draft.estimated_minutes} onChange={e => setDraft(d => ({ ...d, estimated_minutes: e.target.value }))} />

        {conflicts.length > 0 && <SurfaceCard tone="warning" role="alert" style={{ marginTop: 'var(--sp-4)' }}>
          <b>這個時間放不下</b>
          {conflicts.map((c, i) => <div key={i} className="ui-meta">・{conflictText(c)}</div>)}
        </SurfaceCard>}
        {error && <SurfaceCard tone="warning" role="alert" style={{ marginTop: 'var(--sp-4)' }}>{error}</SurfaceCard>}
        {stale ? <Button variant="primary" block style={{ marginTop: 'var(--sp-4)' }} disabled={saving} onClick={reloadToConfirm}>
          {saving ? '載入中…' : '重新載入'}
        </Button> : <Button variant="primary" block style={{ marginTop: 'var(--sp-4)' }} disabled={saving || blocked} onClick={save}>
          {saving ? '儲存中…' : checking ? '確認時間中…' : '儲存變更'}
        </Button>}
      </>}
    </BottomSheet>
  );
}
