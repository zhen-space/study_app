import { useState } from 'react';
import { api } from '../api';
import { Button, PageHeader, SurfaceCard, EmptyState } from './ui';
import SchoolAssignmentForm from './SchoolAssignmentForm';
import {
  TYPE_LABEL, isSchoolAssignment, isOverdue, groupSchoolAssignments,
  formatDeadline, deadlineLabelText, nowTW,
} from './schoolAssignment';

// 一列學校作業：科目 · 名稱 · 類型 · 期限 · 狀態。生命週期一律沿用既有 Task
// API（PATCH /tasks/:id），沒有 school-specific 的完成／取消／刪除／reopen。
export function SARow({ t, list, now, onEdit, reload, showSubject = true }) {
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = !!t.completed;
  const cancelled = !!t.cancelled;
  const overdue = isOverdue(t, now);

  async function patch(body) {
    setBusy(true); setMenu(false);
    try { await api(`/tasks/${t.id}`, { method: 'PATCH', body }); await reload('tasks'); }
    finally { setBusy(false); }
  }
  async function del() {
    if (!window.confirm(`刪除「${t.title}」？`)) return;
    await patch({ deleted: true });
  }

  const statusText = done ? '已完成' : cancelled ? '已取消' : overdue ? '已逾期' : '';
  const statusColor = done ? 'var(--green, #2e7d32)' : cancelled ? 'var(--muted)' : overdue ? 'var(--red)' : '';

  return (
    <div className={'sa-row' + (done || cancelled ? ' sa-row--done' : '')}>
      <label className="sa-row-check">
        <input type="checkbox" checked={done} disabled={busy || cancelled} aria-label={done ? '取消完成' : '標記完成'}
          onChange={() => patch({ completed: !done })} />
      </label>
      <button className="sa-row-main" onClick={() => onEdit(t)} aria-label={`編輯 ${t.title}`}>
        <div className="sa-row-title">
          <span className={'sa-type sa-type--' + t.school_assignment_type}>{TYPE_LABEL[t.school_assignment_type] || '其他'}</span>
          <span className="sa-row-name">{t.title}</span>
        </div>
        <div className="sa-row-sub">
          {showSubject && <span className="sa-subject">{list?.name || '未分科目'}</span>}
          <span className={overdue ? 'sa-deadline sa-deadline--over' : 'sa-deadline'}>
            {deadlineLabelText(t)} {formatDeadline(t)}
          </span>
          {statusText && <span style={{ color: statusColor, fontWeight: 500 }}>· {statusText}</span>}
        </div>
      </button>
      <div className="sa-row-actions">
        <button className="ui-iconbtn" aria-label="更多" onClick={() => setMenu(m => !m)} disabled={busy}>⋯</button>
        {menu && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setMenu(false)} />
            <div className="sa-menu" role="menu">
              <button role="menuitem" onClick={() => { setMenu(false); onEdit(t); }}>編輯</button>
              {done || cancelled
                ? <button role="menuitem" onClick={() => patch({ completed: false, cancelled: false })}>重新開啟</button>
                : <button role="menuitem" onClick={() => patch({ cancelled: true })}>取消作業</button>}
              <button role="menuitem" className="sa-menu-danger" onClick={del}>刪除</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Group({ title, tone, items, ...row }) {
  if (!items.length) return null;
  return (
    <section className="ui-section">
      <div className={'ui-section-title' + (tone === 'danger' ? ' sa-title-danger' : '')}>{title}（{items.length}）</div>
      <SurfaceCard>
        {items.map(t => <SARow key={t.id} t={t} list={row.listOf(t)} now={row.now} onEdit={row.onEdit} reload={row.reload} />)}
      </SurfaceCard>
    </section>
  );
}

// Today 用的三區。語意直接對照 backend groupSchoolAssignments：今天要交／即將到期／
// 已逾期，且**允許重疊**（今天中午要交、現在下午，會同時在「今天要交」與「已逾期」）。
export function SchoolAssignmentToday({ tasks, lists, reload }) {
  const [form, setForm] = useState(null); // null=關閉；{}=新增；task=編輯
  const now = nowTW();
  const groups = groupSchoolAssignments(tasks, now);
  const listOf = t => lists.find(l => l.id === t.list_id);
  const defaultTime = undefined;
  const has = groups.due_today.length || groups.upcoming.length || groups.overdue.length;
  if (!has) return null;

  return (
    <section className="ui-section sa-today">
      <div className="row" style={{ alignItems: 'center', marginBottom: 'var(--sp-2)' }}>
        <div className="ui-section-title" style={{ marginBottom: 0 }}>學校作業</div>
        <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => setForm({})}>＋ 新增作業</Button>
      </div>
      {groups.overdue.length > 0 && (
        <SurfaceCard tone="warning" style={{ marginBottom: 'var(--sp-2)' }}>
          <div className="sa-group-label sa-title-danger">已逾期（{groups.overdue.length}）</div>
          {groups.overdue.map(t => <SARow key={t.id} t={t} list={listOf(t)} now={now} onEdit={setForm} reload={reload} />)}
        </SurfaceCard>
      )}
      {groups.due_today.length > 0 && (
        <SurfaceCard style={{ marginBottom: 'var(--sp-2)' }}>
          <div className="sa-group-label">今天要交（{groups.due_today.length}）</div>
          {groups.due_today.map(t => <SARow key={t.id} t={t} list={listOf(t)} now={now} onEdit={setForm} reload={reload} />)}
        </SurfaceCard>
      )}
      {groups.upcoming.length > 0 && (
        <SurfaceCard>
          <div className="sa-group-label">即將到期（7 天內，{groups.upcoming.length}）</div>
          {groups.upcoming.map(t => <SARow key={t.id} t={t} list={listOf(t)} now={now} onEdit={setForm} reload={reload} />)}
        </SurfaceCard>
      )}
      {form && (
        <SchoolAssignmentForm lists={lists} task={form.id ? form : null} defaultReminderTime={defaultTime}
          onClose={() => setForm(null)} onSaved={() => reload('tasks')} />
      )}
    </section>
  );
}

// 「任務」底下的專屬學校作業視圖（不是新的 bottom tab；資料仍來自既有 Task API）。
export default function SchoolAssignmentView({ tasks, lists, reload }) {
  const [form, setForm] = useState(null);
  const now = nowTW();
  const all = tasks.filter(t => isSchoolAssignment(t) && !t.deleted);
  const listOf = t => lists.find(l => l.id === t.list_id);

  const active = all.filter(t => !t.completed && !t.cancelled);
  const overdue = active.filter(t => isOverdue(t, now));
  const dueToday = active.filter(t => !isOverdue(t, now) && t.deadline_date === now.date);
  const upcoming = active.filter(t => !isOverdue(t, now) && t.deadline_date > now.date
    && t.deadline_date <= addDaysStr(now.date, 7));
  const later = active.filter(t => !overdue.includes(t) && !dueToday.includes(t) && !upcoming.includes(t));
  const doneOrCancelled = all.filter(t => t.completed || t.cancelled);
  const [showDone, setShowDone] = useState(false);

  return (
    <div className="main">
      <PageHeader title="學校作業" subtitle="繳交期限與提醒，沿用任務系統"
        actions={<Button variant="primary" size="sm" onClick={() => setForm({})}>＋ 新增作業</Button>} />
      <div className="main-body">
        {all.length === 0 ? (
          <EmptyState title="還沒有學校作業"
            description="把老師出的作業、報告、考試記下來，會依繳交期限提醒你。"
            action={<Button variant="primary" onClick={() => setForm({})}>＋ 新增第一份作業</Button>} />
        ) : (
          <>
            <Group title="已逾期" tone="danger" items={overdue} listOf={listOf} now={now} onEdit={setForm} reload={reload} />
            <Group title="今天要交" items={dueToday} listOf={listOf} now={now} onEdit={setForm} reload={reload} />
            <Group title="即將到期（7 天內）" items={upcoming} listOf={listOf} now={now} onEdit={setForm} reload={reload} />
            <Group title="之後" items={later} listOf={listOf} now={now} onEdit={setForm} reload={reload} />
            {doneOrCancelled.length > 0 && (
              <section className="ui-section">
                <button className="ui-section-title sa-toggle" onClick={() => setShowDone(s => !s)}>
                  {showDone ? '▾' : '▸'} 已完成／已取消（{doneOrCancelled.length}）
                </button>
                {showDone && (
                  <SurfaceCard>
                    {doneOrCancelled.map(t => <SARow key={t.id} t={t} list={listOf(t)} now={now} onEdit={setForm} reload={reload} />)}
                  </SurfaceCard>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {form && (
        <SchoolAssignmentForm lists={lists} task={form.id ? form : null}
          onClose={() => setForm(null)} onSaved={() => reload('tasks')} />
      )}
    </div>
  );
}

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
