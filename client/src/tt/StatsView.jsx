import { useEffect, useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';

export default function StatsView() {
  const [s, setS] = useState(null);
  useEffect(() => { api('/tstats').then(setS); }, []);
  if (!s) return <div className="main" />;

  const days = [...Array(30)].map((_, i) => addDays(today(), i - 29));
  const maxC = Math.max(1, ...days.map(d => s.completedByDay[d] || 0));
  const heat = v => v === 0 ? '#eef1f4' : `rgba(71,114,250,${0.25 + 0.75 * v / maxC})`;
  const streak = (() => {
    let n = 0, d = today();
    if (!s.completedByDay[d]) d = addDays(d, -1);
    while (s.completedByDay[d]) { n++; d = addDays(d, -1); }
    return n;
  })();

  return (
    <div className="main">
      <div className="main-head"><h2>統計</h2></div>
      <div className="main-body">
        <div className="stat-tiles">
          <div className="tile"><div className="muted">已完成任務</div><div className="num">{s.done}</div><div className="muted">共 {s.total} 項</div></div>
          <div className="tile"><div className="muted">完成率</div><div className="num">{s.total ? Math.round(s.done / s.total * 100) : 0}%</div></div>
          <div className="tile"><div className="muted">連續完成天數</div><div className="num">🔥 {streak}</div></div>
          <div className="tile"><div className="muted">總專注時間</div><div className="num">{(s.focusTotal / 60).toFixed(1)}h</div></div>
        </div>
        <div className="tile" style={{ marginTop: 12 }}>
          <div className="muted">近 30 天完成熱力圖</div>
          <div className="heat">
            {days.map(d => <div key={d} className="hcell" title={`${d}：完成 ${s.completedByDay[d] || 0} 項`} style={{ background: heat(s.completedByDay[d] || 0) }} />)}
          </div>
        </div>
      </div>
    </div>
  );
}
