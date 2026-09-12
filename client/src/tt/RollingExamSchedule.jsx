import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { BottomSheet, Button } from './ui';
import { sectionize, INFEASIBLE_OPTIONS, buildFreezePayload, applyPayload, canConfirm } from './rollingSchedule';

// 段考滾動重排的預覽→（override）→再預覽→確認→套用流程。
//
// 硬性：任何 override 都必須「回到 preview 產生新 candidate、使用者再 confirm」，
// 不能直接 apply；前端不直接建立 ScheduledBlock，一律走 /rolling/apply。
export default function RollingExamSchedule({ planId, triggerTaskId = null, onClose, onApplied }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);      // SELECT_MOVABLE_BLOCKS 選取中
  const [movable, setMovable] = useState([]);          // 使用者勾選可移動的 frozen block id

  const doPreview = useCallback(async (freeze) => {
    setLoading(true); setError('');
    try {
      const body = { plan_id: planId };
      if (triggerTaskId != null) body.trigger_task_id = triggerTaskId;
      if (freeze) body.freeze = freeze;
      const p = await api('/schedule/rolling/preview', { method: 'POST', body });
      setPreview({ ...p, plan_id: planId });
    } catch (e) {
      setError(e.message || '預覽失敗'); setPreview(null);
    } finally { setLoading(false); }
  }, [planId, triggerTaskId]);

  useEffect(() => { doPreview(null); }, [doPreview]);

  const chooseOption = async (value) => {
    if (value === 'KEEP_CURRENT') { onClose?.(); return; }
    if (value === 'RELAX_FREEZE') { setPicking(false); await doPreview(buildFreezePayload('RELAX_FREEZE')); return; }
    if (value === 'SELECT_MOVABLE_BLOCKS') { setPicking(true); setMovable([]); }
  };

  const rePreviewWithSelection = async () => {
    setPicking(false);
    await doPreview(buildFreezePayload('SELECT_MOVABLE_BLOCKS', { movableBlockIds: movable }));
  };

  const confirmApply = async () => {
    if (!canConfirm(preview)) return;
    setApplying(true); setError('');
    try {
      await api('/schedule/rolling/apply', { method: 'POST', body: applyPayload(preview) });
      await onApplied?.();
      onClose?.();
    } catch (e) {
      // §12 STALE_SCHEDULE_PREVIEW：排程在預覽後被別的變更取代 → 自動重新預覽。
      // 訊息在 doPreview 之後才設，因為 doPreview 一開始會清掉 error。
      if (e.payload?.code === 'STALE_SCHEDULE_PREVIEW' || e.code === 'STALE_SCHEDULE_PREVIEW') {
        await doPreview(null);
        setError('排程已被其他變更取代，已為你重新預覽，請再確認一次。');
      } else {
        setError(e.message || '套用失敗');
      }
      setApplying(false);
    }
  };

  const sec = preview ? sectionize(preview) : null;
  const allFrozenPins = preview ? [...(preview.frozen || []), ...(preview.movable || [])] : [];

  return (
    <BottomSheet onClose={onClose} label="段考滾動重排">
      <div className="rolling">
        <h3 style={{ margin: '0 0 var(--sp-3)' }}>這次段考安排・滾動重排</h3>
        {error && <div className="ui-card ui-card--warning" role="alert" style={{ marginBottom: 'var(--sp-3)' }}>{error}</div>}
        {loading && <div className="ui-meta">預覽中…</div>}

        {preview && !loading && (
          <>
            <div className="ui-meta" style={{ marginBottom: 'var(--sp-2)' }}>
              今天（{preview.window?.freeze_start}）與明天（{preview.window?.freeze_through}）維持不變；
              後天（{preview.window?.rolling_start}）起重新安排。
            </div>

            {preview.infeasible ? (
              <div className="ui-card ui-card--warning rolling-infeasible" role="alert">
                <b>在不動今天／明天的前提下排不進來</b>
                <div className="ui-meta">
                  {preview.infeasible.deadline_date
                    ? `這件工作的期限是 ${preview.infeasible.deadline_date}${preview.infeasible.deadline_time ? ' ' + preview.infeasible.deadline_time : ''}，太近了。`
                    : '可用時間不足。'}
                </div>
                <div className="rolling-options" style={{ marginTop: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                  {INFEASIBLE_OPTIONS.map(o => (
                    <Button key={o.value} variant={o.value === 'KEEP_CURRENT' ? 'tertiary' : 'secondary'}
                      onClick={() => chooseOption(o.value)}>{o.label}</Button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <RollingSection title={`今天／明天・維持不變（${sec.frozen.length}）`} items={sec.frozen} tone="frozen" />
                <RollingSection title={`新加入（${sec.added.length}）`} items={sec.added} tone="added" />
                <RollingSection title={`重新安排（${sec.moved.length}）`} items={sec.moved} tone="moved" />
                {preview.unplaced && <div className="ui-meta" style={{ color: 'var(--warning)' }}>有部分工作這次排不進去（unplaced）。</div>}
              </>
            )}

            {picking && (
              <div className="rolling-movable" style={{ marginTop: 'var(--sp-3)' }}>
                <div className="ui-section-title">選擇可以移動的今天／明天安排</div>
                {allFrozenPins.map(b => (
                  <label key={b.id} className="ui-row" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" aria-label={`可移動 ${b.id}`} checked={movable.includes(b.id)}
                      onChange={() => setMovable(m => m.includes(b.id) ? m.filter(x => x !== b.id) : [...m, b.id])} />
                    <span className="ui-row-main">{b.date} {b.start_time || ''}{b.end_time ? `–${b.end_time}` : ''}</span>
                  </label>
                ))}
                <Button variant="primary" size="sm" style={{ marginTop: 'var(--sp-2)' }}
                  disabled={!movable.length} onClick={rePreviewWithSelection}>用這些可移動的安排重新預覽</Button>
              </div>
            )}

            <div className="row" style={{ marginTop: 'var(--sp-4)', gap: 'var(--sp-2)' }}>
              <Button variant="tertiary" onClick={onClose}>取消</Button>
              <Button variant="primary" style={{ marginLeft: 'auto' }}
                disabled={!canConfirm(preview) || applying} onClick={confirmApply}>
                {applying ? '套用中…' : '確認套用'}
              </Button>
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  );
}

function RollingSection({ title, items, tone }) {
  if (!items?.length) return null;
  return (
    <section className={'ui-section rolling-sec rolling-sec--' + tone}>
      <div className="ui-section-title">{title}</div>
      {items.map((it, i) => {
        const b = it.after_blocks?.[0] || it.before_blocks?.[0] || {};
        return <div key={i} className="ui-row"><span className="ui-row-main">{b.date} {b.start_time || ''}{b.end_time ? `–${b.end_time}` : ''}</span></div>;
      })}
    </section>
  );
}
