import { useRef, useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';

export default function MatrixView({ tasks, reload }) {
  // 規則可自訂（記在本機）：緊急＝幾天內到期、重要＝優先級門檻
  const [rule, setRule] = useState(() => {
    try { return { days: 3, pri: 2, ...JSON.parse(localStorage.getItem('matrixRule') || '{}') }; }
    catch { return { days: 3, pri: 2 }; }
  });
  const setR = patch => setRule(r => { const n = { ...r, ...patch }; localStorage.setItem('matrixRule', JSON.stringify(n)); return n; });
  const active = tasks.filter(t => !t.completed);
  const urgent = t => t.due_date && t.due_date <= addDays(today(), rule.days - 1);
  const important = t => t.priority >= rule.pri;
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
  // 拖曳到別格＝改任務屬性：重要格→優先級升到門檻/降到門檻以下；緊急格→到期改今天/改到範圍外
  const dragT = useRef(null);
  const touchFrom = useRef(null);
  const QUAD_FLAGS = [[true, true], [true, false], [false, true], [false, false]]; // [重要, 緊急]
  async function dropTo(qi) {
    const t = dragT.current;
    dragT.current = null;
    if (!t) return;
    const [wantImp, wantUrg] = QUAD_FLAGS[qi];
    const body = {};
    if (wantImp !== important(t)) body.priority = wantImp ? rule.pri : Math.max(0, rule.pri - 1);
    if (wantUrg && !urgent(t)) body.due_date = today();
    if (!wantUrg && urgent(t)) body.due_date = addDays(today(), rule.days); // 移到「緊急」範圍外的第一天
    if (!Object.keys(body).length) return;
    await api(`/tasks/${t.id}`, { method: 'PATCH', body });
    reload();
  }
  return (
    <div className="main">
      <div className="main-head">
        <h2>艾森豪矩陣</h2>
        <span className="muted">緊急＝</span>
        <select value={rule.days} onChange={e => setR({ days: +e.target.value })} style={{ fontSize: 13, padding: '3px 22px 3px 8px' }}>
          {[1, 2, 3, 5, 7].map(d => <option key={d} value={d}>{d} 天內</option>)}
        </select>
        <span className="muted">重要＝</span>
        <select value={rule.pri} onChange={e => setR({ pri: +e.target.value })} style={{ fontSize: 13, padding: '3px 22px 3px 8px' }}>
          <option value={1}>低以上</option><option value={2}>中以上</option><option value={3}>高</option>
        </select>
      </div>
      <div className="main-body" style={{ paddingTop: 10 }}>
        <div style={{ position: 'relative', paddingLeft: 22, paddingBottom: 24 }}>
          {/* 十字座標軸 */}
          <span style={{ position: 'absolute', left: 0, top: '38%', transform: 'rotate(-90deg)', fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>重要 ↑</span>
          <span style={{ position: 'absolute', bottom: 0, left: '45%', fontSize: 12, color: 'var(--muted)' }}>緊急 →</span>
          <div className="matrix" style={{ position: 'relative', gap: 0 }}>
            <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, background: 'var(--muted)', opacity: .5, zIndex: 1 }} />
            <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 2, background: 'var(--muted)', opacity: .5, zIndex: 1 }} />
            {quads.map(([name, color, list], i) => (
              <div className="quad" key={name} data-qi={i} style={{ border: 'none', borderRadius: 0, order: [1, 0, 3, 2][i] }}
                onDragOver={e => e.preventDefault()} onDrop={() => dropTo(i)}>
                <h4 style={{ color }}>{name}（{list.length}）</h4>
                {list.map(t => (
                  <div key={t.id} className="trow" draggable
                    onDragStart={() => { dragT.current = t; }}
                    // 手機：直接用手指拖到別格（iOS 不支援 HTML5 拖曳）
                    onTouchStart={e => { dragT.current = t; touchFrom.current = [e.touches[0].clientX, e.touches[0].clientY]; }}
                    onTouchMove={e => {
                      const [x0, y0] = touchFrom.current || [0, 0];
                      const t0 = e.touches[0];
                      if (Math.hypot(t0.clientX - x0, t0.clientY - y0) > 24) e.preventDefault(); // 拖起來就不捲動
                    }}
                    onTouchEnd={e => {
                      const [x0, y0] = touchFrom.current || [0, 0];
                      const t0 = e.changedTouches[0];
                      if (Math.hypot(t0.clientX - x0, t0.clientY - y0) < 30) { dragT.current = null; return; } // 只是點一下
                      const q = document.elementFromPoint(t0.clientX, t0.clientY)?.closest('[data-qi]');
                      if (q) dropTo(+q.dataset.qi);
                      else dragT.current = null;
                    }}
                    style={{ touchAction: 'none' }}>
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
