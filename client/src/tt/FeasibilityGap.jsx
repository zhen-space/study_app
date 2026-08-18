export default function FeasibilityGap({ feasibility }) {
  if (!feasibility) return null;
  if (!feasibility.gap_minutes) {
    if (feasibility.reason !== 'date_capacity_or_rule') return null;
    return <div className="ui-meta" style={{ marginTop: 8 }}>目前受日期範圍、每日規則或其他硬性限制影響，無法排入全部項目。請調整期限、可用日期或限制條件。</div>;
  }
  const extend = feasibility.recommendations?.find(x => x.type === 'extend_days');
  const add = feasibility.recommendations?.find(x => x.type === 'add_daily_time');
  return <div className="ui-meta" style={{ marginTop: 8 }}>目前還缺約 {feasibility.gap_hours} 小時。{extend && <>維持目前可用時間，最少需延後 {extend.min_days} 天。</>}{add && <>維持期限時，接下來每天約需多 {add.minutes_per_day} 分鐘。</>}</div>;
}
