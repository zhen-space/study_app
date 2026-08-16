import { useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { today } from './helpers';
import { usePlans, bookOf, shortTitle, md, byLesson } from './plans';

// 單一計畫的內容：照書分堆、每本書照課名順序。
// 打勾走的是既有的 PATCH /tasks/:id，沒有另一套完成邏輯。

export default function PlanDetailView({ planKey, tasks, lists, apiPlans = [], reload, onBack, goWizard }) {
  const plan = usePlans(tasks, lists, apiPlans).find(p => p.key === planKey);
  const [showDone, setShowDone] = useState(false);

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

  // 完成走既有的 PATCH /tasks/:id，沒有第二套完成邏輯
  const toggle = t =>
    api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: !t.completed } })
      .then(() => reload('tasks')).catch(() => reload('tasks'));

  const books = [...new Set(plan.items.map(t => bookOf(t.title)))];

  return (
    <div className="main">
      <div className="main-head">
        <h2>{plan.name}</h2>
        {plan.isLegacy && <span className="chip" title="還沒轉成正式計畫的舊資料">舊資料</span>}
        <span className="muted">{plan.done}／{plan.total}</span>
      </div>
      <div className="main-body">
        <div className="row">
          <button className="btn sm ghost" onClick={onBack}>← 計畫列表</button>
          <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={goWizard}>
            <Icon name="wizard" size={14} /> 重新安排
          </button>
        </div>

        <div className="row" style={{ marginTop: 8, fontSize: 13 }}>
          <span className="muted">{md(plan.start)}–{md(plan.end)}</span>
          {plan.overdue > 0 && <span style={{ color: 'var(--red)' }}>逾期 {plan.overdue} 項</span>}
        </div>

        {books.map(b => {
          const list = plan.items
            .filter(t => bookOf(t.title) === b && (showDone || !t.completed))
            .sort((x, y) => byLesson(x.title, y.title));
          const undone = plan.items.filter(t => bookOf(t.title) === b && !t.completed).length;
          if (!list.length) return null;
          return (
            <div key={b} className="tgroup" style={{ marginTop: 10 }}>
              <div className="glabel">{b} <span className="muted" style={{ fontWeight: 400 }}>剩 {undone} 項</span></div>
              {list.map(t => {
                const late = !t.completed && t.due_date && t.due_date < today();
                return (
                  <div key={t.id} className="trow" style={{ cursor: 'default' }}>
                    <input type="checkbox" checked={!!t.completed} onChange={() => toggle(t)} />
                    <span className="title" style={t.completed ? { textDecoration: 'line-through', color: 'var(--muted)' } : {}}>
                      {shortTitle(t.title)}
                    </span>
                    {t.due_date && (
                      <span className="muted" style={late ? { color: 'var(--red)' } : {}}>{md(t.due_date)}</span>
                    )}
                  </div>
                );
              })}
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
