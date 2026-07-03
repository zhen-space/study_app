import { api } from '../api';
import { today, addDays } from './helpers';

export default function MatrixView({ tasks, reload }) {
  const active = tasks.filter(t => !t.completed);
  const urgent = t => t.due_date && t.due_date <= addDays(today(), 2);
  const important = t => t.priority >= 2;
  const quads = [
    ['重要且緊急', 'var(--red)', active.filter(t => important(t) && urgent(t))],
    ['重要不緊急', 'var(--orange)', active.filter(t => important(t) && !urgent(t))],
    ['緊急不重要', 'var(--blue)', active.filter(t => !important(t) && urgent(t))],
    ['不重要不緊急', 'var(--muted)', active.filter(t => !important(t) && !urgent(t))],
  ];
  const toggle = async t => {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: true } });
    reload();
  };
  return (
    <div className="main">
      <div className="main-head"><h2>艾森豪矩陣</h2><span className="muted">緊急＝3 天內到期；重要＝中/高優先級</span></div>
      <div className="main-body" style={{ paddingTop: 10 }}>
        <div className="matrix">
          {quads.map(([name, color, list]) => (
            <div className="quad" key={name}>
              <h4 style={{ color }}>{name}（{list.length}）</h4>
              {list.map(t => (
                <div key={t.id} className="trow">
                  <input type="checkbox" onChange={() => toggle(t)} />
                  <span className="title">{t.title}</span>
                  {t.due_date && <span className="muted">{t.due_date.slice(5)}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
