import { useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { BottomSheet, Button, SurfaceCard } from './ui';

// 確切安排裡的輕量任務編輯器。排定日期仍由 ScheduledBlock 管理，這裡只改
// Task 自己的內容／硬期限／預估時間；因此不會繞過 ScheduleVersion 交易。
export default function TimelineTaskEditSheet({ item, task, onSaved, onReload, onClose }) {
  const original = task || item || {};
  const [draft, setDraft] = useState({
    title: original.title || '',
    deadline_date: original.deadline_date || '',
    estimated_minutes: original.estimated_minutes == null ? '' : String(original.estimated_minutes),
  });
  const [saving, setSaving] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const composing = useRef(false);

  const body = () => ({
    title: draft.title.trim(),
    deadline_date: draft.deadline_date || null,
    estimated_minutes: draft.estimated_minutes === '' ? null : Number(draft.estimated_minutes),
  });

  async function save() {
    if (busy.current || composing.current || committed) return;
    const next = body();
    if (!next.title) { setError('任務名稱不能空白'); return; }
    if (next.estimated_minutes != null && (!Number.isInteger(next.estimated_minutes) || next.estimated_minutes < 1 || next.estimated_minutes > 1440)) {
      setError('預估時間需介於 1 到 1440 分鐘'); return;
    }
    busy.current = true; setSaving(true); setError('');
    try {
      await api(`/tasks/${item.task_id}`, { method: 'PATCH', body: next });
    } catch (e) {
      if (e.status >= 400 && e.status < 500) {
        setError(e.message || '儲存失敗，請確認後再試。');
        busy.current = false; setSaving(false); return;
      }
      // 行動網路可能只遺失回應；先讀回確認，不能誘導重送同一筆修改。
      try {
        const rows = await api('/tasks');
        const saved = Array.isArray(rows) && rows.find(t => Number(t.id) === Number(item.task_id));
        const matches = saved && saved.title === next.title
          && (saved.deadline_date || null) === next.deadline_date
          && (saved.estimated_minutes ?? null) === next.estimated_minutes;
        // 成功讀回且內容不符，才明確證明這次沒有提交，可以開放修正後重試。
        if (!matches) {
          setError(e.message || '儲存失敗，請稍後再試。');
          busy.current = false; setSaving(false); return;
        }
      } catch {
        // PATCH 與唯讀確認都失敗時，結果未知。不得再送 PATCH，只能重新載入或關閉。
        setCommitted(true); setUncertain(true);
        setError('無法確認任務是否已儲存；確認前不會再次送出。');
        busy.current = false; setSaving(false); return;
      }
    }
    setCommitted(true);
    try {
      await onSaved(next);
      onClose();
    } catch (e) {
      setError(e.message || '任務已儲存，但畫面暫時無法更新。');
      busy.current = false; setSaving(false);
    }
  }

  async function reloadToConfirm() {
    if (busy.current || !uncertain) return;
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

  return (
    <BottomSheet onClose={saving ? undefined : onClose} label="編輯任務">
      <div className="row">
        <b>編輯任務</b>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="關閉" disabled={saving} onClick={saving ? undefined : onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {committed ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <b>{uncertain ? '暫時無法確認儲存結果' : '任務已儲存'}</b>
          {error && <SurfaceCard tone="warning" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{error}</SurfaceCard>}
          <div className="row" style={{ marginTop: 'var(--sp-4)', gap: 'var(--sp-2)' }}>
            <Button variant="tertiary" disabled={saving} onClick={onClose}>先關閉</Button>
            {uncertain && <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={saving} onClick={reloadToConfirm}>
              {saving ? '載入中…' : '重新載入確認'}
            </Button>}
          </div>
        </div>
      ) : <>
        <label className="sheet-sec" htmlFor="timeline-task-title" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>任務名稱</label>
        <input id="timeline-task-title" value={draft.title}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={e => { composing.current = false; setDraft(d => ({ ...d, title: e.currentTarget.value })); }}
          onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
        <label className="sheet-sec" htmlFor="timeline-task-deadline" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>最晚完成日</label>
        <input id="timeline-task-deadline" type="date" value={draft.deadline_date}
          onChange={e => setDraft(d => ({ ...d, deadline_date: e.target.value }))} />
        <label className="sheet-sec" htmlFor="timeline-task-estimate" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>預估時間（分鐘）</label>
        <input id="timeline-task-estimate" type="number" min="1" max="1440" inputMode="numeric"
          value={draft.estimated_minutes} onChange={e => setDraft(d => ({ ...d, estimated_minutes: e.target.value }))} />
        <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>排定日期請回到這一項，按「改日期／時間」調整。</div>
        {error && <SurfaceCard tone="warning" role="alert" style={{ marginTop: 'var(--sp-4)' }}>{error}</SurfaceCard>}
        <Button variant="primary" block style={{ marginTop: 'var(--sp-4)' }} disabled={saving} onClick={save}>
          {saving ? '儲存中…' : '儲存任務'}
        </Button>
      </>}
    </BottomSheet>
  );
}
