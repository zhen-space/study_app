import { useEffect, useState } from 'react';
import { api } from '../api';

function weekRange() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Monday=0
  const mon = new Date(d); mon.setDate(d.getDate() - day);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const s = x => x.toISOString().slice(0, 10);
  return [s(mon), s(sun)];
}

export default function Stats() {
  const [stats, setStats] = useState(null);
  const [from, to] = weekRange();

  useEffect(() => { api(`/stats?from=${from}&to=${to}`).then(setStats); }, []);
  if (!stats) return null;

  const hours = (stats.totalMinutes / 60).toFixed(1);
  const maxMin = Math.max(1, ...Object.values(stats.bySubject).map(v => v.minutes));

  return (
    <div className="page">
      <h2>本週統計</h2>
      <p className="muted">{from} ～ {to}（只計已完成的讀書時段）</p>
      <div className="stat-tiles">
        <div className="tile"><div className="muted">本週讀書時數</div><div className="num">{hours} 小時</div></div>
        <div className="tile"><div className="muted">任務完成率</div><div className="num">{Math.round(stats.completionRate * 100)}%</div><div className="muted">{stats.doneTasks}/{stats.totalTasks} 項</div></div>
        <div className="tile"><div className="muted">連續打卡</div><div className="num">🔥 {stats.streak} 天</div></div>
      </div>
      <div className="card">
        <h3>各科目時數分布</h3>
        {Object.keys(stats.bySubject).length === 0 && <div className="muted" style={{ marginTop: 8 }}>本週還沒有完成的讀書時段</div>}
        {Object.entries(stats.bySubject).map(([name, v]) => (
          <div key={name} className="bar-row">
            <span className="label">{name}</span>
            <div className="bar" style={{ background: v.color, width: `${(v.minutes / maxMin) * 70}%` }} />
            <span className="muted">{(v.minutes / 60).toFixed(1)}h</span>
          </div>
        ))}
      </div>
    </div>
  );
}
