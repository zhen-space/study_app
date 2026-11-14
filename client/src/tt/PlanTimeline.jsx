import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api';
import { md } from './plans';
import { SurfaceCard, Button, EmptyState } from './ui';
import AdjustBlockSheet from './AdjustBlockSheet';
import TimelineTaskEditSheet from './TimelineTaskEditSheet';

// 排程摘要（確切安排 B 層）：讀後端 projection（/schedule/timeline/:planId），
// 把「已排定的每日安排」按日期區間、科目分組直接呈現，不必再開 Calendar。
// 這是「確切安排」的摘要，不是「段考進度」——段考進度（哪天以前讀完哪些範圍）由
// ProgressPlan（plan_progress_segments）負責。這裡完全不自己重算排程，也不冒充
// 完成，一切以後端投影的 CURRENT world 為準；寫入沿用 Task PATCH 與 manual schedule
// 交易，沒有 active 排程就顯示空狀態。

const RANGE_LABEL = (a, b) => (a === b ? md(a) : `${md(a)}–${md(b)}`);
const dueLabel = it => (it.deadline_time ? `${md(it.deadline_date)} ${it.deadline_time} 前` : `${md(it.deadline_date)} 前`);

// 一個 item 的顯示標題：Material 用「教材末節 · 內容」，其餘用 task title。
function itemTitle(it) {
  if (it.material && (it.material.item_title || (it.material.path || []).length)) {
    const leaf = (it.material.path || []).slice(-1)[0]?.title;
    return [it.material.book_title, leaf, it.material.item_title].filter(Boolean).join(' · ') || it.title;
  }
  return it.kind === 'manual' ? `老師指定：${it.title}` : it.title;
}

const STATUS_LABEL = {
  today: '今天', past_due: '已逾期', upcoming: '接下來', schedule_gap: '安排有缺口',
};
const REASON_LABEL = {
  missing_estimate: '尚未填預估時間',
  schedule_gap: '尚未排入目前生效的日期安排',
  deadline_violation: '目前安排超過期限',
};

function StatusLabel({ status }) {
  if (!STATUS_LABEL[status]) return null;
  const warning = status === 'past_due' || status === 'schedule_gap';
  return <span className="ui-meta" style={{ color: warning ? 'var(--warning, #b7791f)' : undefined }}>{STATUS_LABEL[status]}</span>;
}

function CompletionButton({ it, busy, disabled, onToggle }) {
  const done = it.completion === 'completed';
  return <button type="button" className={'timeline-check' + (done ? ' is-done' : '')}
    aria-label={done ? `取消完成「${itemTitle(it)}」` : `完成「${itemTitle(it)}」`}
    aria-pressed={done} disabled={disabled || busy} onClick={() => onToggle(it)}>
    <span aria-hidden="true">{busy ? '…' : done ? '✓' : it.completion === 'in_progress' ? '◐' : ''}</span>
  </button>;
}

function itemScheduleMeta(it) {
  if (it.display_mode === 'deadline' && it.deadline_date) return dueLabel(it);
  if (it.display_mode === 'gap') {
    return it.warnings?.includes('deadline_violation') ? REASON_LABEL.deadline_violation : REASON_LABEL.schedule_gap;
  }
  if (it.display_mode === 'unscheduled') {
    return it.warnings?.map(w => REASON_LABEL[w]).filter(Boolean)[0] || REASON_LABEL.schedule_gap;
  }
  if (it.range_start && it.range_end) return RANGE_LABEL(it.range_start, it.range_end);
  if (it.day_blocks?.length) {
    const dates = it.day_blocks.map(b => b.date).filter(Boolean).sort();
    if (dates.length) return RANGE_LABEL(dates[0], dates[dates.length - 1]);
  }
  return null;
}

function ItemLine({ it, expanded, busy, uncertain, readOnly, onToggle, onEdit, onAdjustBlock }) {
  const scheduleMeta = itemScheduleMeta(it);
  const warning = it.display_mode === 'gap' || it.display_mode === 'unscheduled';
  return (
    <div className="timeline-item">
      <CompletionButton it={it} busy={busy} disabled={readOnly || uncertain} onToggle={onToggle} />
      <div className="timeline-item-main">
        <div className="timeline-item-title" style={{ textDecoration: it.completion === 'completed' ? 'line-through' : 'none' }}>{itemTitle(it)}</div>
        <div className="timeline-item-meta">
          {it.subject_name && <span className="ui-meta">{it.subject_name}</span>}
          <StatusLabel status={it.time_status} />
          {warning && <span aria-hidden="true">⚠️</span>}
          {scheduleMeta && <span className="ui-meta" style={{ color: warning ? 'var(--warning, #b7791f)' : undefined }}>{scheduleMeta}</span>}
          {it.locked && <span className="ui-meta" title="已鎖定">🔒 已鎖定</span>}
        </div>
        <div className="timeline-item-actions">
          {!readOnly && <button type="button" className="timeline-action" onClick={() => onEdit(it)}>編輯任務</button>}
          {!readOnly && it.day_blocks?.length > 0 && (
            <button type="button" className="timeline-action" onClick={() => onAdjustBlock(it, it.day_blocks[0])}>改日期／時間</button>
          )}
        </div>
        {expanded && it.day_blocks?.length > 0 && (
          <div className="timeline-days">
            {it.day_blocks.map(b => (
              <button type="button" key={b.block_id} disabled={readOnly}
                className="timeline-day" onClick={() => !readOnly && onAdjustBlock(it, b)}
                aria-label={`調整「${itemTitle(it)}」${md(b.date)}的安排`}>
                {md(b.date)}{b.start_time && b.end_time ? ` ${b.start_time}–${b.end_time}` : ''}
                {b.planned_minutes ? `（${b.planned_minutes} 分）` : ''}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PlanTimeline({ plan, tasks = [], lists = [], reloadTasks, onAddContent, onAdjust, refreshKey = 0 }) {
  const planId = plan?.planId;
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [expanded, setExpanded] = useState(false);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const busyRef = useRef(new Set());
  const [uncertainIds, setUncertainIds] = useState(() => new Set());
  const [mutationError, setMutationError] = useState('');
  const [editingItem, setEditingItem] = useState(null);
  const [adjusting, setAdjusting] = useState(null); // { item, block }

  const load = useCallback(async () => {
    void refreshKey;
    if (planId == null) { setState({ loading: false, data: null, error: '' }); return true; }
    setState(s => ({ ...s, loading: true, error: '' }));
    try {
      const d = await api(`/schedule/timeline/${planId}`);
      if (!d || !Array.isArray(d.segments)) throw new Error('日期安排資料格式不正確');
      setState({ loading: false, data: d, error: '' });
      return true;
    } catch (e) {
      setState(s => ({ loading: false, data: s.data, error: e.message || '無法載入日期安排' }));
      return false;
    }
  }, [planId, refreshKey]);
  useEffect(() => { load(); }, [load]);

  const setBusy = (id, value) => {
    if (value) busyRef.current.add(id); else busyRef.current.delete(id);
    setBusyIds(new Set(busyRef.current));
  };
  const patchLocal = (taskId, changes) => setState(s => {
    if (!s.data) return s;
    const patch = rows => (rows || []).map(it => Number(it.task_id) === Number(taskId) ? { ...it, ...changes } : it);
    return { ...s, data: { ...s.data, items: patch(s.data.items), deadlines: patch(s.data.deadlines),
      gaps: patch(s.data.gaps), unscheduled: patch(s.data.unscheduled) } };
  });
  const refreshTasksLater = () => {
    if (!reloadTasks) return;
    Promise.resolve(reloadTasks('tasks')).catch(() => setMutationError('變更已儲存，但其他畫面暫時無法更新；重新開啟後會載入最新狀態。'));
  };
  const markUncertain = id => setUncertainIds(ids => new Set([...ids, id]));
  const clearUncertain = id => setUncertainIds(ids => { const next = new Set(ids); next.delete(id); return next; });
  const confirmUncertain = async id => {
    if (busyRef.current.has(id)) return;
    setBusy(id, true); setMutationError('');
    try {
      // 只讀 CURRENT timeline；絕不重送完成 PATCH。投影成功即以伺服器結果取代本地 optimistic 狀態。
      if (!await load()) throw new Error('仍然無法載入最新完成狀態');
      clearUncertain(id);
    } catch (e) {
      setMutationError(e.message || '仍然無法載入最新完成狀態，確認前不會再次切換。');
    } finally {
      setBusy(id, false);
    }
  };
  const toggle = async it => {
    if (busyRef.current.has(it.task_id) || uncertainIds.has(it.task_id) || plan?.status === 'ended' || plan?.status === 'archived') return;
    const before = it.completion;
    const completed = before !== 'completed';
    setMutationError(''); setBusy(it.task_id, true);
    // 先更新目前這一列，手機上不必等整份 Task 與 Plan 重新載入才看到反應。
    patchLocal(it.task_id, { completion: completed ? 'completed' : 'not_started', time_status: completed ? 'completed' : it.time_status });
    try {
      await api(`/tasks/${it.task_id}`, { method: 'PATCH', body: { completed } });
    } catch (e) {
      if (e.status >= 400 && e.status < 500) {
        patchLocal(it.task_id, { completion: before, time_status: it.time_status });
        setMutationError(e.message || '更新完成狀態失敗，請確認後再試。');
        setBusy(it.task_id, false); return;
      }
      try {
        const rows = await api('/tasks');
        const saved = Array.isArray(rows) && rows.find(t => Number(t.id) === Number(it.task_id));
        if (!saved || Boolean(saved.completed) !== completed) {
          patchLocal(it.task_id, { completion: before, time_status: it.time_status });
          setMutationError(e.message || '更新完成狀態失敗，請稍後再試。');
          setBusy(it.task_id, false); return;
        }
      } catch {
        // PATCH 可能已提交，讀回也失敗：保留 optimistic 結果並鎖住該項，不能重按反轉。
        markUncertain(it.task_id);
        setMutationError('無法確認完成狀態是否已更新；確認前不會再次切換。');
        setBusy(it.task_id, false); return;
      }
    }
    setBusy(it.task_id, false);
    refreshTasksLater();
  };
  const savedTask = async (it, changes) => {
    patchLocal(it.task_id, changes);
    setEditingItem(null);
    refreshTasksLater();
  };
  const openAdjust = (it, b) => setAdjusting({ item: it, block: {
    id: b.block_id, task_id: it.task_id, date: b.date,
    start_time: b.start_time || null, end_time: b.end_time || null,
    planned_minutes: b.planned_minutes || null,
  } });

  if (state.loading && !state.data) return <div className="ui-meta" style={{ marginTop: 'var(--sp-5)' }}>正在載入日期安排…</div>;
  if (state.error && !state.data) return (
    <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
      <b>日期安排</b>
      <div role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{state.error}</div>
      <Button size="sm" style={{ marginTop: 10 }} onClick={load}>重試</Button>
    </SurfaceCard>
  );
  if (!state.data) return null;
  const t = {
    segments: [], deadlines: [], gaps: [], unscheduled: [], items: [],
    no_active_schedule: false, ...state.data,
  };
  const hasAnything = t.items.length || t.segments.length || t.deadlines.length || t.gaps.length || t.unscheduled.length;
  const readOnly = plan?.status === 'ended' || plan?.status === 'archived' || !t.active;
  // CURRENT projection 可能同時把同一 Task 放進 items 與 range/deadline/gap bucket。
  // 以 task_id 去重後只呈現一次：未完成置頂；完成項目保留在歷史區。
  const uniqueItems = [...new Map((t.items || []).map(it => [Number(it.task_id), it])).values()];
  const incompleteItems = uniqueItems.filter(it => it.completion !== 'completed');
  const completedItems = uniqueItems.filter(it => it.completion === 'completed');

  // 空狀態：沒有可呈現的計畫安排 → 引導「加入內容」或「調整計畫」。
  if (!hasAnything) {
    return (
      <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
        <b>日期安排</b>
        <div style={{ marginTop: 8 }}>
          <EmptyState
            title={t.no_active_schedule ? '這個計畫還沒有確切安排' : '目前沒有可顯示的排程'}
            description="加入教材或作業，並排一次確切安排後，這裡會顯示每天要做的具體項目。"
          />
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            {onAddContent && <Button size="sm" variant="primary" onClick={onAddContent}>加入內容</Button>}
            {onAdjust && <Button size="sm" onClick={onAdjust}>調整計畫</Button>}
          </div>
        </div>
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
      <div className="row" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <b>日期安排</b>
        <span className="ui-meta">目前生效的確切安排</span>
        <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => setExpanded(v => !v)}>
          {expanded ? '收合每日安排' : '展開每日安排'}
        </Button>
      </div>
      {state.error && <div role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{state.error} <Button size="sm" onClick={load}>重試</Button></div>}
      {mutationError && <div role="alert" className="ui-error" style={{ marginTop: 8 }}>
        {mutationError}
        {uncertainIds.size > 0 && <Button size="sm" style={{ marginLeft: 8 }}
          disabled={[...uncertainIds].some(id => busyIds.has(id))}
          onClick={() => confirmUncertain([...uncertainIds][0])}>重新載入確認</Button>}
      </div>}

      {incompleteItems.length > 0 && (
        <section aria-labelledby="timeline-incomplete-title" style={{ marginTop: 14 }}>
          <div id="timeline-incomplete-title" style={{ fontWeight: 600 }}>未完成任務（{incompleteItems.length}）</div>
          {incompleteItems.map(it => (
            <ItemLine key={it.task_id} it={it} expanded={expanded} busy={busyIds.has(it.task_id)} uncertain={uncertainIds.has(it.task_id)} readOnly={readOnly}
              onToggle={toggle} onEdit={setEditingItem} onAdjustBlock={openAdjust} />
          ))}
        </section>
      )}

      {/* 排不下／期限衝突：明確標記，不假裝有完成區間。 */}
      {t.gaps.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="ui-meta" style={{ fontWeight: 600, color: 'var(--warning, #b7791f)' }}>需要調整（排不下或期限衝突）</div>
          <div className="ui-meta" style={{ marginTop: 4 }}>⚠️ 上方標示的任務尚未形成可執行的日期安排。</div>
          {onAdjust && <Button size="sm" style={{ marginTop: 8 }} onClick={onAdjust}>調整計畫</Button>}
        </div>
      )}

      {/* 尚未排入：另列，不混進正常時間軸。 */}
      {t.unscheduled.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="ui-meta" style={{ fontWeight: 600 }}>尚未排入（{t.unscheduled.length}）</div>
          <div className="ui-meta" style={{ marginTop: 4, color: 'var(--warning, #b7791f)' }}>⚠️ 上方標示的任務仍需補齊資料或安排時間。</div>
          {onAdjust && <Button size="sm" style={{ marginTop: 8 }} onClick={onAdjust}>安排這些內容</Button>}
        </div>
      )}
      {completedItems.length > 0 && (
        <section aria-labelledby="timeline-completed-title" style={{ marginTop: 14 }}>
          <div id="timeline-completed-title" className="ui-meta" style={{ fontWeight: 600 }}>已完成紀錄（{completedItems.length}）</div>
          {completedItems.map(it => (
            <ItemLine key={it.task_id} it={it} expanded={expanded} busy={busyIds.has(it.task_id)} uncertain={uncertainIds.has(it.task_id)} readOnly={readOnly}
              onToggle={toggle} onEdit={setEditingItem} onAdjustBlock={openAdjust} />
          ))}
        </section>
      )}
      {editingItem && <TimelineTaskEditSheet item={editingItem}
        task={tasks.find(tk => Number(tk.id) === Number(editingItem.task_id))}
        onSaved={changes => savedTask(editingItem, changes)} onReload={load} onClose={() => setEditingItem(null)} />}
      {adjusting && <AdjustBlockSheet block={adjusting.block}
        task={tasks.find(tk => Number(tk.id) === Number(adjusting.item.task_id)) || {
          id: adjusting.item.task_id, title: adjusting.item.title, list_id: adjusting.item.subject_id,
        }} lists={lists} versionId={t.active_version_id}
        reload={async () => { await load(); refreshTasksLater(); }} onClose={() => setAdjusting(null)} />}
    </SurfaceCard>
  );
}
