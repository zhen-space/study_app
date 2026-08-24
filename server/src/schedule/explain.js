// 「為什麼這樣排」。
//
// 這一支刻意先算出一份**完全確定性**的事實摘要，再讓 AI 拿這份摘要去寫人話。
// 順序很重要：
//   ・沒有 AI 金鑰、AI 逾時、AI 亂回話 —— 使用者仍然看得到正確的事實摘要。
//     AI 是錦上添花，不是這個功能的地基。
//   ・AI 只會拿到「已經決定好的結果」，不會參與決定。它不能改 Material
//     completion、不能改 Plan selection、不能繞過 Lock、不能改動任何 block。
//     排程真相永遠是 ScheduledBlock，AI 的輸出只是一段文字。
//
// 所以這個檔案裡沒有任何 AI 呼叫，只有純函式。AI 那一層在 route 上。

const HM = t => (t || '').slice(0, 5);
const minutesOf = t => (t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : 0);
const configured = value => value != null && !(Array.isArray(value) && value.length === 0);

// Explain API 的 constraint 是「目前已確認、且 active schedule 真的涉及的
// Plan」的脈絡，不是 ScheduleVersion 的欄位，更不是全域設定。保留 Plan
// attribution，才不會把不同計畫的條件混成一條原因。
function constraintAttribution(constraints) {
  const entries = Array.isArray(constraints)
    ? constraints
    : [{ plan_id: null, plan_name: null, constraints: constraints || {} }];
  return entries.map(entry => ({
    plan_id: entry.plan_id ?? null,
    plan_name: entry.plan_name ?? null,
    constraints: Object.entries(entry.constraints || {})
      .filter(([, value]) => configured(value))
      .map(([key, value]) => ({ key, value })),
  })).filter(entry => entry.constraints.length > 0);
}

// 把一份 active schedule 整理成「可以直接唸出來」的事實。
// 全部來自傳進來的資料，不做任何推測。
export function explainSchedule({ blocks = [], tasks = [], lists = [], locks = [], constraints = {}, today = '' }) {
  const live = blocks.filter(b => b.date);
  const taskById = new Map(tasks.map(t => [Number(t.id), t]));
  const listById = new Map(lists.map(l => [String(l.id), l]));

  // 每天排了幾項、幾分鐘
  const byDay = new Map();
  for (const b of live) {
    const d = byDay.get(b.date) || { date: b.date, count: 0, minutes: 0 };
    d.count += 1;
    d.minutes += Number(b.planned_minutes) || 0;
    byDay.set(b.date, d);
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  // 各科分佈
  const bySubject = new Map();
  for (const b of live) {
    const t = taskById.get(Number(b.task_id));
    const name = listById.get(String(t?.list_id))?.name || '未分科目';
    const s = bySubject.get(name) || { subject: name, count: 0, minutes: 0 };
    s.count += 1;
    s.minutes += Number(b.planned_minutes) || 0;
    bySubject.set(name, s);
  }
  const subjects = [...bySubject.values()].sort((a, b) => b.minutes - a.minutes);

  // 每天的時段範圍：讓「為什麼排在這個時間」有依據
  const timed = live.filter(b => b.start_time && b.end_time);
  const earliest = timed.length ? HM(timed.reduce((a, b) => minutesOf(a.start_time) <= minutesOf(b.start_time) ? a : b).start_time) : null;
  const latest = timed.length ? HM(timed.reduce((a, b) => minutesOf(a.end_time) >= minutesOf(b.end_time) ? a : b).end_time) : null;

  const activeLocks = locks.filter(l => !l.released_at);
  const range = days.length ? { start: days[0].date, end: days[days.length - 1].date } : null;
  const totalMinutes = days.reduce((n, d) => n + d.minutes, 0);
  const perDay = days.length ? Math.round(totalMinutes / days.length) : 0;
  const busiest = days.length ? days.reduce((a, b) => (b.minutes > a.minutes ? b : a)) : null;

  // 尚未安排：有計畫、還沒完成、但這個版本裡沒有 block
  const placed = new Set(live.map(b => Number(b.task_id)));
  const unplaced = tasks.filter(t =>
    t.plan_id != null && !t.completed && !t.deleted && !t.cancelled && !placed.has(Number(t.id)));

  const constraintsByPlan = constraintAttribution(constraints);
  return {
    range,
    total_blocks: live.length,
    total_minutes: totalMinutes,
    days_used: days.length,
    avg_minutes_per_day: perDay,
    busiest_day: busiest ? { date: busiest.date, minutes: busiest.minutes, count: busiest.count } : null,
    time_window: earliest && latest ? { earliest, latest } : null,
    timed: timed.length > 0,
    subjects,
    days,
    locks: activeLocks.map(l => ({ type: l.type, date: l.date || null, task_id: l.task_id ?? null })),
    unplaced_count: unplaced.length,
    // 只列使用者真的設過、而且排程器支援的條件。不支援的不在這裡假裝生效。
    // 每一組都保留它所屬的 Plan，不能把多 Plan schedule 說成同一份全域條件。
    current_confirmed_constraints_by_plan: constraintsByPlan,
    today,
  };
}

// 事實摘要 → 中文說明。這一段沒有 AI 也讀得懂，是 graceful degradation 的底線。
export function explainSentences(f) {
  const out = [];
  if (!f.total_blocks) {
    out.push('目前沒有已排定的讀書時段。');
    if (f.unplaced_count) out.push(`有 ${f.unplaced_count} 項還沒被安排進來。`);
    return out;
  }
  const md = d => `${+d.slice(5, 7)}/${+d.slice(8)}`;
  if (f.range) out.push(`這份安排從 ${md(f.range.start)} 到 ${md(f.range.end)}，共 ${f.days_used} 天、${f.total_blocks} 個時段。`);
  out.push(`平均每天約 ${f.avg_minutes_per_day} 分鐘。`);
  if (f.busiest_day) out.push(`最滿的是 ${md(f.busiest_day.date)}，那天有 ${f.busiest_day.count} 項、共 ${f.busiest_day.minutes} 分鐘。`);
  if (f.time_window) out.push(`已排定時段落在 ${f.time_window.earliest}–${f.time_window.latest} 之間。`);
  else out.push('這份安排只決定每天要做什麼，沒有綁定幾點到幾點。');
  if (f.subjects.length > 1) {
    out.push('各科分配：' + f.subjects.map(s => `${s.subject} ${s.minutes} 分鐘`).join('、') + '。');
  }
  if (f.locks.length) out.push(`目前有 ${f.locks.length} 個未解除的鎖定紀錄。`);
  if (f.unplaced_count) out.push(`還有 ${f.unplaced_count} 項尚未排進目前的安排。`);
  return out;
}
