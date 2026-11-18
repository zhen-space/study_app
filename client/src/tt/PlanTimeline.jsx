import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api';
import { md } from './plans';
import { SurfaceCard, Button, EmptyState, SegmentedControl } from './ui';
import TimelineTaskEditSheet from './TimelineTaskEditSheet';
import { useLongPress } from './touchDrag';

// 排程摘要（確切安排 B 層）：讀後端 projection（/schedule/timeline/:planId），
// 把「已排定的每日安排」按每天日期直接呈現，不必再開 Calendar。
// 這是「確切安排」的摘要，不是「段考進度」——段考進度（哪天以前讀完哪些範圍）由
// ProgressPlan（plan_progress_segments）負責。這裡完全不自己重算排程，也不冒充
// 完成，一切以後端投影的 CURRENT world 為準；寫入沿用 Task PATCH 與 manual schedule
// 交易，沒有 active 排程就顯示空狀態。

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
  today: '今天', past_due: '已逾期', upcoming: '接下來',
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

function ItemLine({ it, block: selectedBlock, busy, uncertain, readOnly, onToggle, onEdit,
  task, movable = false, dragging = false, onStartMove, onPickDate, showDate = false, moveError = '' }) {
  const block = selectedBlock === undefined ? (it.day_blocks?.[0] || null) : selectedBlock;
  const { style: pressStyle, ...pressHandlers } = useLongPress(movable ? () => onStartMove?.(task, block, itemTitle(it)) : undefined);
  return (
    <div className="timeline-item" {...pressHandlers} aria-grabbed={movable ? dragging : undefined}
      style={{ ...pressStyle, ...(dragging ? { opacity: .55, outline: '2px dashed var(--primary)', borderRadius: 10 } : {}) }}>
      <CompletionButton it={it} busy={busy} disabled={readOnly || uncertain} onToggle={onToggle} />
      <div className="timeline-item-main">
        <div className="timeline-item-title" style={{ textDecoration: it.completion === 'completed' ? 'line-through' : 'none' }}>{itemTitle(it)}</div>
        <div className="timeline-item-meta">
          {it.subject_name && <span className="ui-meta">{it.subject_name}</span>}
          {showDate && block?.date && <span className="ui-meta">{md(block.date)}</span>}
          <StatusLabel status={it.time_status} />
          {block?.start_time && block?.end_time && <span className="ui-meta">{block.start_time}–{block.end_time}</span>}
          {it.overdue && it.last_scheduled_date && <span className="ui-meta">原定 {md(it.last_scheduled_date)}</span>}
          {(it.overdue || (!block && it.display_mode === 'deadline')) && it.deadline_date && <span className="ui-meta">{dueLabel(it)}</span>}
          {it.locked && <span className="ui-meta" title="已鎖定">🔒 已鎖定</span>}
        </div>
        <div className="timeline-item-actions">
          {!readOnly && <button type="button" className="timeline-action" disabled={busy || uncertain} onClick={() => onEdit(it, block)}>編輯任務</button>}
          {movable && <button type="button" className="timeline-action" disabled={busy || uncertain}
            aria-label={`${block?.date ? '改' : '替'}「${itemTitle(it)}」${block?.date ? '的日期' : '選擇日期'}`}
            onClick={() => onPickDate?.(task, block)}>{block?.date ? '改日期' : '選日期'}</button>}
        </div>
        {moveError && <div role="alert" className="ui-error" style={{ marginTop: 4 }}>{moveError}</div>}
      </div>
    </div>
  );
}

export default function PlanTimeline({ plan, tasks = [], reloadTasks, onAddContent, onAdjust, refreshKey = 0,
  groupMode = 'date', onGroupModeChange, canMoveTask, onStartMove, onPickDate, draggingTaskId = null,
  moveState = {} }) {
  const planId = plan?.planId;
  const [state, setState] = useState({ planId, loading: true, data: null, error: '' });
  const requestSeqRef = useRef(0);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const busyRef = useRef(new Set());
  const [uncertainIds, setUncertainIds] = useState(() => new Set());
  const [mutationError, setMutationError] = useState('');
  const [editingItem, setEditingItem] = useState(null); // { item, block }

  const load = useCallback(async () => {
    void refreshKey;
    const requestedPlanId = planId;
    const requestSeq = ++requestSeqRef.current;
    if (requestedPlanId == null) {
      setState({ planId: requestedPlanId, loading: false, data: null, error: '' });
      return true;
    }
    setState(s => s.planId === requestedPlanId
      ? { ...s, loading: true, error: '' }
      : { planId: requestedPlanId, loading: true, data: null, error: '' });
    try {
      const d = await api(`/schedule/timeline/${requestedPlanId}`);
      if (!d || !Array.isArray(d.segments)) throw new Error('日期安排資料格式不正確');
      if (requestSeq !== requestSeqRef.current) return false;
      setState({ planId: requestedPlanId, loading: false, data: d, error: '' });
      return true;
    } catch (e) {
      if (requestSeq !== requestSeqRef.current) return false;
      setState(s => ({ planId: requestedPlanId, loading: false,
        data: s.planId === requestedPlanId ? s.data : null,
        error: e.message || '無法載入日期安排' }));
      return false;
    }
  }, [planId, refreshKey]);

  useEffect(() => {
    // 切換計畫時，上一個計畫的資料與可寫入狀態都不能短暫出現在新計畫。
    // 同時讓尚未完成的舊請求失效，避免慢回應覆蓋目前計畫。
    requestSeqRef.current += 1;
    busyRef.current.clear();
    setBusyIds(new Set());
    setUncertainIds(new Set());
    setMutationError('');
    setEditingItem(null);
    setState({ planId, loading: planId != null, data: null, error: '' });
  }, [planId]);
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
    // 完成：先劃掉這一列，手機上不必等重新載入才看到反應。
    // 取消完成：逾期與每日分區要由伺服器依日期重算，不在本地先改成未完成，
    // 否則沒有 block 的舊任務會暫時落到「未指定日期」。
    if (completed) patchLocal(it.task_id, { completion: 'completed', time_status: 'completed' });
    try {
      await api(`/tasks/${it.task_id}`, { method: 'PATCH', body: { completed } });
    } catch (e) {
      if (e.status >= 400 && e.status < 500) {
        if (completed) patchLocal(it.task_id, { completion: before, time_status: it.time_status });
        setMutationError(e.message || '更新完成狀態失敗，請確認後再試。');
        setBusy(it.task_id, false); return;
      }
      try {
        const rows = await api('/tasks');
        const saved = Array.isArray(rows) && rows.find(t => Number(t.id) === Number(it.task_id));
        if (!saved || Boolean(saved.completed) !== completed) {
          if (completed) patchLocal(it.task_id, { completion: before, time_status: it.time_status });
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
    if (!completed && !await load()) {
      // 已取消完成，但拿不到重算後的位置：如實顯示未完成並鎖住，確認前不能再切換。
      patchLocal(it.task_id, { completion: 'not_started', time_status: null });
      markUncertain(it.task_id);
      setMutationError('已取消完成，但最新日期安排暫時無法載入；重新載入確認後會顯示在正確日期。');
    }
    setBusy(it.task_id, false);
    refreshTasksLater();
  };
  const savedTask = async (it, changes) => {
    patchLocal(it.task_id, changes);
    refreshTasksLater();
  };

  const visibleState = state.planId === planId
    ? state
    : { planId, loading: planId != null, data: null, error: '' };
  if (visibleState.loading && !visibleState.data) return <div className="ui-meta" style={{ marginTop: 'var(--sp-5)' }}>正在載入日期安排…</div>;
  if (visibleState.error && !visibleState.data) return (
    <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
      <b>日期安排</b>
      <div role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{visibleState.error}</div>
      <Button size="sm" style={{ marginTop: 10 }} onClick={load}>重試</Button>
    </SurfaceCard>
  );
  if (!visibleState.data) return null;
  const t = {
    segments: [], deadlines: [], gaps: [], unscheduled: [], items: [],
    no_active_schedule: false, ...visibleState.data,
  };
  const hasAnything = t.items.length || t.segments.length || t.deadlines.length || t.gaps.length || t.unscheduled.length;
  const readOnly = plan?.status === 'ended' || plan?.status === 'archived' || !t.active;
  // CURRENT projection 可能同時把同一 Task 放進多個 bucket。畫面只讀 items，
  // 已逾期置頂；其餘按 ScheduledBlock 的每一天呈現。
  // 逾期由後端以台北時區判定（含已不在 active 版本的過去安排），前端不自行推算日期。
  const uniqueItems = [...new Map((t.items || []).map(it => [Number(it.task_id), it])).values()];
  const overdueItems = uniqueItems.filter(it => it.completion !== 'completed'
    && (it.overdue ?? (it.time_status === 'past_due' || it.warnings?.includes('past_due'))));
  const completedItems = uniqueItems.filter(it => it.completion === 'completed');
  const normalItems = uniqueItems.filter(it => it.completion !== 'completed' && !overdueItems.includes(it));
  const days = new Map();
  const undatedItems = [];
  for (const it of normalItems) {
    const blocks = (it.day_blocks || []).filter(b => b.date);
    if (!blocks.length && it.display_mode === 'deadline' && it.deadline_date) {
      const rows = days.get(it.deadline_date) || [];
      rows.push({ item: it, block: null }); days.set(it.deadline_date, rows);
    } else if (!blocks.length) undatedItems.push(it);
    else for (const block of blocks) {
      const rows = days.get(block.date) || [];
      rows.push({ item: it, block }); days.set(block.date, rows);
    }
  }
  const dailySections = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
  const taskFor = it => tasks.find(tk => Number(tk.id) === Number(it.task_id));
  const movableFor = (it, block) => {
    const task = taskFor(it);
    return !!task && !!canMoveTask?.(task, block);
  };
  const subjectRows = [];
  for (const it of uniqueItems.filter(it => it.completion !== 'completed')) {
    const blocks = (it.day_blocks || []).filter(b => b.date);
    if (blocks.length) for (const block of blocks) subjectRows.push({ item: it, block });
    else subjectRows.push({ item: it, block: null });
  }
  subjectRows.sort((a, b) => (a.item.subject_name || '').localeCompare(b.item.subject_name || '', 'zh-Hant')
    || (a.block?.date || '').localeCompare(b.block?.date || '')
    || (a.block?.start_time || '').localeCompare(b.block?.start_time || '')
    || itemTitle(a.item).localeCompare(itemTitle(b.item), 'zh-Hant'));
  const subjectGroups = new Map();
  for (const row of subjectRows) {
    const label = row.item.subject_name || '未分科目';
    if (!subjectGroups.has(label)) subjectGroups.set(label, []);
    subjectGroups.get(label).push(row);
  }

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
        <div style={{ marginLeft: 'auto' }}>
          <SegmentedControl ariaLabel="日期安排分區" value={groupMode} onChange={onGroupModeChange}
            options={[{ value: 'date', label: '依日期' }, { value: 'subject', label: '依科目' }]} />
        </div>
      </div>
      {!readOnly && <div className="ui-meta" style={{ marginTop: 6 }}>長按任務可移動日期；也可直接點「改日期」。</div>}
      {state.error && <div role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{state.error} <Button size="sm" onClick={load}>重試</Button></div>}
      {mutationError && <div role="alert" className="ui-error" style={{ marginTop: 8 }}>
        {mutationError}
        {uncertainIds.size > 0 && <Button size="sm" style={{ marginLeft: 8 }}
          disabled={[...uncertainIds].some(id => busyIds.has(id))}
          onClick={() => confirmUncertain([...uncertainIds][0])}>重新載入確認</Button>}
      </div>}

      {groupMode === 'date' && overdueItems.length > 0 && (
        <section aria-labelledby="timeline-overdue-title" style={{ marginTop: 14 }}>
          <div id="timeline-overdue-title" style={{ fontWeight: 600, color: 'var(--danger)' }}>已逾期（{overdueItems.length}）</div>
          {overdueItems.map(it => (
            <ItemLine key={it.task_id} it={it} busy={busyIds.has(it.task_id)} uncertain={uncertainIds.has(it.task_id)} readOnly={readOnly}
              task={taskFor(it)} movable={movableFor(it, null)} dragging={Number(draggingTaskId) === Number(it.task_id)}
              moveError={moveState[it.task_id]?.error || ''}
              onStartMove={onStartMove} onPickDate={onPickDate}
              onToggle={toggle} onEdit={(item, block) => setEditingItem({ item, block })} />
          ))}
        </section>
      )}
      {groupMode === 'date' && dailySections.map(([date, rows]) => (
        <section key={date} aria-label={`${md(date)}安排`} data-drop-date={date} style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600 }}>{md(date)}</div>
          {rows.map(({ item, block }) => (
            <ItemLine key={`${item.task_id}:${block?.block_id || block?.id || 'deadline'}`} it={{ ...item, day_blocks: block ? [block] : [] }} block={block}
              busy={busyIds.has(item.task_id)} uncertain={uncertainIds.has(item.task_id)} readOnly={readOnly}
              task={taskFor(item)} movable={movableFor(item, block)} dragging={Number(draggingTaskId) === Number(item.task_id)}
              moveError={moveState[item.task_id]?.error || ''}
              onStartMove={onStartMove} onPickDate={onPickDate}
              onToggle={toggle} onEdit={(selected, selectedBlock) => setEditingItem({ item: selected, block: selectedBlock })} />
          ))}
        </section>
      ))}
      {groupMode === 'date' && undatedItems.length > 0 && (
        <section aria-labelledby="timeline-undated-title" style={{ marginTop: 14 }}>
          <div id="timeline-undated-title" style={{ fontWeight: 600 }}>未指定日期</div>
          {undatedItems.map(it => <ItemLine key={it.task_id} it={it} busy={busyIds.has(it.task_id)} uncertain={uncertainIds.has(it.task_id)}
            readOnly={readOnly} task={taskFor(it)} movable={movableFor(it, null)} dragging={Number(draggingTaskId) === Number(it.task_id)}
            moveError={moveState[it.task_id]?.error || ''}
            onStartMove={onStartMove} onPickDate={onPickDate}
            onToggle={toggle} onEdit={(item, block) => setEditingItem({ item, block })} />)}
        </section>
      )}
      {groupMode === 'subject' && [...subjectGroups.entries()].map(([subject, rows]) => (
        <section key={subject} aria-label={`${subject}安排`} style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600 }}>{subject}</div>
          {rows.map(({ item, block }, index) => (
            <ItemLine key={`${item.task_id}:${block?.block_id || block?.id || index}`} it={item} block={block} showDate
              busy={busyIds.has(item.task_id)} uncertain={uncertainIds.has(item.task_id)} readOnly={readOnly}
              task={taskFor(item)} movable={movableFor(item, block)} dragging={Number(draggingTaskId) === Number(item.task_id)}
              moveError={moveState[item.task_id]?.error || ''}
              onStartMove={onStartMove} onPickDate={onPickDate}
              onToggle={toggle} onEdit={(selected, selectedBlock) => setEditingItem({ item: selected, block: selectedBlock })} />
          ))}
        </section>
      ))}
      {groupMode === 'date' && completedItems.length > 0 && (
        <section aria-labelledby="timeline-completed-title" style={{ marginTop: 14 }}>
          <div id="timeline-completed-title" className="ui-meta" style={{ fontWeight: 600 }}>已完成紀錄（{completedItems.length}）</div>
          {completedItems.map(it => (
            <ItemLine key={it.task_id} it={it} busy={busyIds.has(it.task_id)} uncertain={uncertainIds.has(it.task_id)} readOnly={readOnly}
              onToggle={toggle} onEdit={(item, block) => setEditingItem({ item, block })} />
          ))}
        </section>
      )}
      {editingItem && <TimelineTaskEditSheet item={editingItem.item} block={editingItem.block}
        task={tasks.find(tk => Number(tk.id) === Number(editingItem.item.task_id))}
        versionId={t.active_version_id}
        onSaved={changes => savedTask(editingItem.item, changes)} onReload={load}
        onUncertain={() => {
          markUncertain(editingItem.item.task_id);
          setMutationError('無法確認任務變更是否已儲存；確認前不會再次送出。');
        }}
        onClose={() => setEditingItem(null)} />}
    </SurfaceCard>
  );
}
