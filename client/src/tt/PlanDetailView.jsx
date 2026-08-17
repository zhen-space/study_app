import { useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { today } from './helpers';
import { usePlans, bookOf, shortTitle, md, byLesson } from './plans';

// 單一計畫的內容。
//
// 分組主軸是「科目」而不是「書」——一個 Plan 可以跨科，書只是標題裡的一段，
// 不是 Plan 的身分。同一科底下有多本書時才再用書名分小段。
//
// 正式 Plan（有 planId）才有改名／改期限／完成／封存；
// 舊資料沒有 plan id，這些操作對它沒有意義，一律不顯示。

const STATUS_LABEL = { draft: '草稿', active: '進行中', completed: '已完成', archived: '已封存' };

export default function PlanDetailView({ planKey, tasks, lists, apiPlans = [], reload, onBack, goWizard }) {
  const plan = usePlans(tasks, lists, apiPlans).find(p => p.key === planKey);
  const [showDone, setShowDone] = useState(false);
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!plan) {
    return (
      <div className="main">
        <div className="main-head"><h2>計畫</h2></div>
        <div className="main-body">
          <button className="btn sm ghost" onClick={onBack}>← 回計畫列表</button>
          <div className="muted" style={{ marginTop: 20 }}>找不到這個計畫（可能已經全部刪除了）</div>
        </div>
      </div>
    );
  }

  const isReal = !plan.isLegacy && plan.planId != null;
  const raw = apiPlans.find(p => p.id === plan.planId);   // 正式 Plan 的原始欄位（日期等）

  // 完成任務走既有的 PATCH /tasks/:id，沒有第二套完成邏輯
  const toggle = t =>
    api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: !t.completed } })
      .then(() => reload('tasks')).catch(() => reload('tasks'));

  // 以下全部走 Phase 2A 已有的 /plans API，前端不另外存一份計畫狀態
  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await reload(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const patch = body => run(() => api(`/plans/${plan.planId}`, { method: 'PATCH', body }));
  const archive = () => run(() => api(`/plans/${plan.planId}/archive`, { method: 'POST', body: {} }));
  const restore = () => run(() => api(`/plans/${plan.planId}/restore`, { method: 'POST', body: {} }));
  const complete = () => run(async () => {
    // 後端會先回未解決的任務讓使用者確認，force 才真的完成
    const r = await api(`/plans/${plan.planId}/complete`, { method: 'POST', body: {} });
    if (r.needs_confirm) {
      const ok = window.confirm(`還有 ${r.unresolved.length} 項沒有完成，仍要把整個計畫標記為完成嗎？`);
      if (!ok) return;
      await api(`/plans/${plan.planId}/complete`, { method: 'POST', body: { force: true } });
    }
  });

  // 依科目分組；同一科有多本書時再分小段
  const groups = plan.subjects.length
    ? plan.subjects.map(s => ({
        subject: s,
        items: plan.items.filter(t => String(t.list_id ?? '') === String(s.id ?? '')),
      }))
    : [{ subject: null, items: plan.items }];

  const visible = list => list.filter(t => showDone || !t.completed).sort((a, b) => byLesson(a.title, b.title));

  const Row = t => {
    const late = !t.completed && t.due_date && t.due_date < today();
    return (
      <div key={t.id} className="trow" style={{ cursor: 'default' }}>
        <input type="checkbox" checked={!!t.completed} onChange={() => toggle(t)} />
        <span className="title" style={t.completed ? { textDecoration: 'line-through', color: 'var(--muted)' } : {}}>
          {shortTitle(t.title)}
        </span>
        {t.due_date
          ? <span className="muted" style={late ? { color: 'var(--red)' } : {}}>{md(t.due_date)}</span>
          : <span className="chip">尚未安排</span>}
      </div>
    );
  };

  return (
    <div className="main">
      <div className="main-head">
        <h2>{plan.name}</h2>
        {plan.isLegacy && <span className="chip" title="還沒轉成正式計畫的舊資料">舊資料</span>}
        {isReal && plan.status !== 'active' && <span className="chip">{STATUS_LABEL[plan.status] || plan.status}</span>}
        <span className="muted">{plan.done}／{plan.total}</span>
      </div>
      <div className="main-body">
        <div className="row">
          <button className="btn sm ghost" onClick={onBack}>← 計畫列表</button>
          {isReal && (
            <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => setManage(v => !v)}>
              <Icon name="pencil" size={14} /> {manage ? '完成' : '管理'}
            </button>
          )}
          {!isReal && (
            <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={goWizard}>
              <Icon name="wizard" size={14} /> 重新安排
            </button>
          )}
        </div>

        <div className="row" style={{ marginTop: 8, fontSize: 13, flexWrap: 'wrap' }}>
          {plan.start && <span className="muted">{md(plan.start)}–{md(plan.end)}</span>}
          {plan.overdue > 0 && <span style={{ color: 'var(--red)' }}>逾期 {plan.overdue} 項</span>}
          {plan.subjects.length > 1 && <span className="muted">{plan.subjects.length} 個科目</span>}
        </div>

        {plan.isLegacy && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            這是還沒轉成正式計畫的舊資料，只能查看與打勾，不能改名、改期限或封存
          </div>
        )}

        {/* 管理操作：全部直接打 Phase 2A 的 /plans API */}
        {isReal && manage && (
          <div className="tile" style={{ marginTop: 10, padding: '12px 14px', background: 'var(--fill)' }}>
            <div className="muted" style={{ fontSize: 12 }}>計畫名稱</div>
            <input defaultValue={plan.name} style={{ width: '100%', marginTop: 2 }}
              aria-label="計畫名稱"
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== plan.name) patch({ name: v }); }}
              onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}>開始</span>
              <input type="date" aria-label="開始日期" value={raw?.start_date || ''}
                onChange={e => patch({ start_date: e.target.value || null })} />
              <span className="muted" style={{ fontSize: 12 }}>目標</span>
              <input type="date" aria-label="目標日期" value={raw?.target_date || ''}
                onChange={e => patch({ target_date: e.target.value || null })} />
            </div>
            <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              {plan.status !== 'completed' && plan.status !== 'archived' && (
                <button className="btn sm" disabled={busy} onClick={complete}>標記完成</button>
              )}
              {plan.status !== 'archived'
                ? <button className="btn sm ghost" disabled={busy} onClick={archive}>封存</button>
                : <button className="btn sm" disabled={busy} onClick={restore}>恢復</button>}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>封存不會刪掉任何任務</div>
            {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
          </div>
        )}

        {/* 尚未安排：在計畫裡 ≠ 已經排到日期 */}
        {plan.unplaced.length > 0 && (
          <div className="tgroup" style={{ marginTop: 12 }}>
            <div className="glabel">尚未安排 <span className="muted" style={{ fontWeight: 400 }}>{plan.unplaced.length} 項</span></div>
            <div className="muted" style={{ fontSize: 12, padding: '0 0 4px' }}>這些還沒排進行事曆</div>
            {plan.unplaced.sort((a, b) => byLesson(a.title, b.title)).map(Row)}
          </div>
        )}

        {plan.total === 0 && (
          <div className="muted" style={{ marginTop: 24, textAlign: 'center' }}>
            這個計畫還沒有任何任務
          </div>
        )}

        {/* 主分組＝科目。同一科有多本書時，才再用書名分小段 */}
        {groups.map(({ subject, items }) => {
          const list = visible(items);
          if (!list.length) return null;
          const undone = items.filter(t => !t.completed).length;
          const books = [...new Set(list.map(t => bookOf(t.title)))];
          return (
            <div key={String(subject?.id ?? 'none')} className="tgroup" style={{ marginTop: 12 }}>
              <div className="glabel">
                {subject && <Icon name={subject.icon} size={14} style={{ color: subject.color, verticalAlign: '-2px', marginRight: 4 }} />}
                {subject?.name || '未分科目'}
                <span className="muted" style={{ fontWeight: 400 }}> 剩 {undone} 項</span>
              </div>
              {books.length > 1
                ? books.map(b => (
                    <div key={b}>
                      <div className="muted" style={{ fontSize: 12, padding: '6px 0 2px' }}>{b}</div>
                      {list.filter(t => bookOf(t.title) === b).map(Row)}
                    </div>
                  ))
                : list.map(Row)}
            </div>
          );
        })}

        {plan.done > 0 && (
          <button className="btn sm ghost" style={{ marginTop: 12 }} onClick={() => setShowDone(s => !s)}>
            {showDone ? '隱藏已完成' : `顯示已完成（${plan.done}）`}
          </button>
        )}
      </div>
    </div>
  );
}
