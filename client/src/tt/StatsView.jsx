import { useEffect, useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';

// 今天與本週的實際讀書時間。資料一律取自 /tstats 的 actualByDay
// （來源是已完成的 StudySession），前端不自己另外推估。
// 「本週」照學生的習慣從週一算起。
export function weekStart(d) {
  const x = new Date(d + 'T00:00:00');
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
export function studyMinutes(actualByDay = {}, from, to) {
  return Object.entries(actualByDay)
    .filter(([d]) => d >= from && d <= to)
    .reduce((n, [, m]) => n + (Number(m) || 0), 0);
}
const hm = m => (m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`);

export default function StatsView() {
  const [s, setS] = useState(null);
  useEffect(() => { api('/tstats').then(setS); }, []);
  if (!s) return <div className="main" />;

  const days = [...Array(30)].map((_, i) => addDays(today(), i - 29));
  const maxC = Math.max(1, ...days.map(d => s.completedByDay[d] || 0));
  const maxStudy = Math.max(1, ...days.map(d => s.actualByDay?.[d] || 0));
  const heat = v => v === 0 ? 'var(--fill)' : `rgba(71,114,250,${0.25 + 0.75 * v / maxC})`;
  const streak = (() => {
    let n = 0, d = today();
    if (!s.completedByDay[d]) d = addDays(d, -1);
    while (s.completedByDay[d]) { n++; d = addDays(d, -1); }
    return n;
  })();
  const todayMin = studyMinutes(s.actualByDay, today(), today());
  const weekMin = studyMinutes(s.actualByDay, weekStart(today()), today());
  const subjectNames = [...new Set([...Object.keys(s.plannedBySubject || {}), ...Object.keys(s.bySubject || {})])];
  const planNames = [...new Set([...Object.keys(s.plannedByPlan || {}), ...Object.keys(s.byPlan || {})])];

  return (
    <div className="main">
      <div className="main-head"><h2>統計</h2></div>
      <div className="main-body">
        <div className="stat-tiles">
          <div className="tile"><div className="muted">今天讀了</div><div className="num">{hm(todayMin)}</div></div>
          <div className="tile"><div className="muted">本週讀了</div><div className="num">{hm(weekMin)}</div><div className="muted">從週一起算</div></div>
          <div className="tile"><div className="muted">已完成任務</div><div className="num">{s.done}</div><div className="muted">共 {s.total} 項</div></div>
          <div className="tile"><div className="muted">完成率</div><div className="num">{s.total ? Math.round(s.done / s.total * 100) : 0}%</div></div>
          <div className="tile"><div className="muted">連續完成天數</div><div className="num">🔥 {streak}</div></div>
          <div className="tile"><div className="muted">總實際讀書時間</div><div className="num">{((s.actualTotal || 0) / 60).toFixed(1)}h</div></div>
          <div className="tile"><div className="muted">原定／實際</div><div className="num">{(s.plannedMinutes / 60).toFixed(1)} / {(s.actualTotal / 60).toFixed(1)}h</div></div>
          <div className="tile"><div className="muted">近 30 天調整</div><div className="num">{s.movedLast30 || 0}</div><div className="muted">次任務移動</div></div>
        </div>
        <div className="tile" style={{ marginTop: 12 }}>
          <div className="muted">近 30 天實際讀書時間</div>
          <div className="heat">{days.map(d => <div key={d} className="hcell" title={`${d}：${s.actualByDay?.[d] || 0} 分鐘`} style={{ background: (s.actualByDay?.[d] || 0) ? `rgba(22,163,74,${.25 + .75 * (s.actualByDay[d] || 0) / maxStudy})` : 'var(--fill)' }} />)}</div>
          <div className="muted" style={{ marginTop: 8 }}>尚未安排的計畫任務：{s.unplaced || 0} 項</div>
        </div>
        {(subjectNames.length > 0 || planNames.length > 0) && <div className="tile" style={{ marginTop: 12 }}>
          <div className="muted">實際讀書時間</div>
          {subjectNames.sort((a,b) => (s.bySubject?.[b] || 0) - (s.bySubject?.[a] || 0)).map(name => <div className="row" key={`s:${name}`} style={{ marginTop: 6 }}><span style={{ flex: 1 }}>{name}</span><b>原定 {((s.plannedBySubject?.[name] || 0) / 60).toFixed(1)} / 實際 {((s.bySubject?.[name] || 0) / 60).toFixed(1)} 小時</b></div>)}
          {planNames.sort((a,b) => (s.byPlan?.[b] || 0) - (s.byPlan?.[a] || 0)).map(name => <div className="row" key={`p:${name}`} style={{ marginTop: 6 }}><span className="muted" style={{ flex: 1 }}>{name}</span><b>原定 {((s.plannedByPlan?.[name] || 0) / 60).toFixed(1)} / 實際 {((s.byPlan?.[name] || 0) / 60).toFixed(1)} 小時</b></div>)}
        </div>}
        <div className="tile" style={{ marginTop: 12 }}>
          <div className="muted">近 30 天完成熱力圖</div>
          <div className="heat">
            {days.map(d => <div key={d} className="hcell" title={`${d}：完成 ${s.completedByDay[d] || 0} 項`} style={{ background: heat(s.completedByDay[d] || 0) }} />)}
          </div>
        </div>

        {s.year && (
          <div className="tile" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700 }}>📖 {new Date().getFullYear()} 年度回顧</div>
            <div className="muted" style={{ marginTop: 8 }}>每月完成任務</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 70, marginTop: 6 }}>
              {s.year.byMonth.map((n, i) => {
                const mx = Math.max(1, ...s.year.byMonth);
                return (
                  <div key={i} style={{ flex: 1, textAlign: 'center' }} title={`${i + 1}月：${n} 項`}>
                    <div style={{ height: Math.max(2, n / mx * 52), background: 'var(--primary)', opacity: n ? 1 : .15, borderRadius: 4 }} />
                    <div className="muted" style={{ fontSize: 10 }}>{i + 1}</div>
                  </div>
                );
              })}
            </div>
            <div className="muted" style={{ marginTop: 10 }}>每月實際讀書時數</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 70, marginTop: 6 }}>
              {(s.year.actualByMonth || []).map((m, i) => {
                const mx = Math.max(1, ...(s.year.actualByMonth || []));
                return (
                  <div key={i} style={{ flex: 1, textAlign: 'center' }} title={`${i + 1}月：${(m / 60).toFixed(1)} 小時`}>
                    <div style={{ height: Math.max(2, m / mx * 52), background: 'var(--orange)', opacity: m ? 1 : .15, borderRadius: 4 }} />
                    <div className="muted" style={{ fontSize: 10 }}>{i + 1}</div>
                  </div>
                );
              })}
            </div>
            {s.year.topLists?.length > 0 && (
              <>
                <div className="muted" style={{ marginTop: 10 }}>完成最多的清單</div>
                {s.year.topLists.map((l, i) => (
                  <div key={i} className="row" style={{ marginTop: 4 }}>
                    <span className="dot" style={{ background: l.color }} />
                    <span style={{ flex: 1 }}>{l.name}</span>
                    <b>{l.c} 項</b>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
