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
        <div style={{ position: 'relative', paddingLeft: 22, paddingBottom: 24 }}>
          {/* 十字座標軸 */}
          <span style={{ position: 'absolute', left: 0, top: '38%', transform: 'rotate(-90deg)', fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>重要 ↑</span>
          <span style={{ position: 'absolute', bottom: 0, left: '45%', fontSize: 12, color: 'var(--muted)' }}>緊急 →</span>
          <div className="matrix" style={{ position: 'relative', gap: 0 }}>
            <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, background: 'var(--muted)', opacity: .5, zIndex: 1 }} />
            <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 2, background: 'var(--muted)', opacity: .5, zIndex: 1 }} />
            {quads.map(([name, color, list], i) => (
              <div className="quad" key={name} style={{ border: 'none', borderRadius: 0, order: [1, 0, 3, 2][i] }}>
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
    </div>
  );
}
