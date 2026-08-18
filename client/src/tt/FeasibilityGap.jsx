export default function FeasibilityGap({ feasibility }) {
  if (!feasibility?.gap_minutes) return null;
  const extend = feasibility.recommendations?.find(x => x.type === 'extend_days');
  const add = feasibility.recommendations?.find(x => x.type === 'add_daily_time');
  return <div className="ui-meta" style={{ marginTop: 8 }}>目前還缺約 {feasibility.gap_hours} 小時。{extend && <>維持目前可用時間，最少需延後 {extend.min_days} 天。</>}{add && <>維持期限時，接下來每天約需多 {add.minutes_per_day} 分鐘。</>}</div>;
}
