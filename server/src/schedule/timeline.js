// 段考進度時間軸（Exam Progress Timeline）——**純 projection**，不新增任何 schema／
// 第二套 timeline／milestone／schedule state。輸入全部來自 CURRENT world：
//   ・active ScheduleVersion 的 ScheduledBlock（排定安排的唯一真相）
//   ・CURRENT Task（plan_id / list_id / title / deadline / estimate / kind / completion）
//   ・Material selection 產生的 Material Task（材料路徑用）
//   ・Lock（標記鎖定，不改語意）
//   ・StudySession（只用來標記「實際有讀」，不冒充計畫、不捏造完成）
//
// 契約重點：
//   ・同一 Task 拆成多個 block → 合併成一個完成區間（min date ~ max date），不重複列。
//   ・只有日期、沒有時段時，不捏造 start/end time。
//   ・School Assignment 以老師的 deadline_date/deadline_time 呈現（deadline 模式），
//     不被 Plan target_date 或 due_date 覆寫。
//   ・排不下／缺估／缺 horizon／deadline 衝突／capacity gap 必須明確標記，不假裝有完成區間。
//   ・paused/completed/ended/deleted 計畫只讀呈現當前可驗證資料，不進入現役排程。

import { effectiveDeadlineViolation } from './rolling.js';

const SCHEDULABLE = new Set(['draft', 'active']);

// block 分鐘：優先 planned_minutes，否則由 end-start 推導（沒有時段就回 0，不捏造）。
function minutesOf(b) {
  const pm = Number(b.planned_minutes);
  if (Number.isFinite(pm) && pm > 0) return pm;
  if (b.start_time && b.end_time) {
    const t = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    return Math.max(0, t(b.end_time) - t(b.start_time));
  }
  return 0;
}

// 有效日期上限＝Task deadline 與 Plan target_date 取較早者（沿用 rolling 的判定；不覆寫 deadline）。
function effectiveUpperBound(taskDeadline, planTarget) {
  if (taskDeadline && planTarget) return taskDeadline < planTarget ? taskDeadline : planTarget;
  return taskDeadline || planTarget || null;
}

function completionOf(task, hasSession) {
  if (task.completed) return 'completed';
  if (hasSession) return 'in_progress';
  return 'not_started';
}

// 主要 projection。輸入為已正規化的 rows / maps（route 負責查詢，這裡只算，便於單元測試）。
export function buildPlanTimeline({
  plan, activeVersionId, tasks = [], blocks = [],
  subjectsById = new Map(), materialById = new Map(),
  lockedTaskIds = new Set(), sessionTaskIds = new Set(), today,
}) {
  const scheduable = SCHEDULABLE.has(plan.status) && activeVersionId != null;
  const planTarget = plan.target_date || null;

  // task_id → 該 task 在 active 版本的 blocks（照日期／時間排序）。
  const blocksByTask = new Map();
  for (const b of blocks) {
    const arr = blocksByTask.get(Number(b.task_id)) || [];
    arr.push(b);
    blocksByTask.set(Number(b.task_id), arr);
  }
  for (const arr of blocksByTask.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date) || (a.start_time || '').localeCompare(b.start_time || '') || a.id - b.id);
  }

  const items = [];
  const warnings = [];

  for (const t of tasks) {
    const taskId = Number(t.id);
    const kind = t.task_kind === 'school_assignment' ? 'school_assignment'
      : (t.material_content_item_id != null ? 'material' : 'standard');
    const subjectId = t.list_id ?? null;
    const subjectName = (subjectId != null ? subjectsById.get(Number(subjectId)) : null) || null;
    const mat = t.material_content_item_id != null ? (materialById.get(Number(t.material_content_item_id)) || null) : null;
    const taskBlocks = scheduable ? (blocksByTask.get(taskId) || []) : [];
    const completion = completionOf(t, sessionTaskIds.has(taskId));
    const itemWarnings = [];

    // deadline 逾期（僅資訊；計畫任務過原定日是「未完成進度」，不是逾期——但 deadline 本身逾期要提醒）
    if (t.deadline_date && today && t.deadline_date < today && completion !== 'completed') itemWarnings.push('past_due');

    const dayBlocks = taskBlocks.map(b => ({
      block_id: b.id, date: b.date,
      start_time: b.start_time || null, end_time: b.end_time || null,
      planned_minutes: minutesOf(b) || null,
    }));
    const blockIds = taskBlocks.map(b => b.id);
    const plannedMinutes = taskBlocks.reduce((n, b) => n + minutesOf(b), 0) || null;
    const rangeStart = taskBlocks.length ? taskBlocks[0].date : null;
    const rangeEnd = taskBlocks.length ? taskBlocks[taskBlocks.length - 1].date : null;

    // §G fail-closed：候選 block 若超過有效上限（deadline × plan target 取較早者，含 School
    // Assignment 同日 deadline_time），標記為 gap——不假裝是乾淨的完成區間。
    const ctx = { deadline_date: t.deadline_date || null, deadline_time: t.deadline_time || null, plan_target_date: planTarget };
    const violated = taskBlocks.some(b => effectiveDeadlineViolation(b, ctx));
    if (violated) itemWarnings.push('deadline_violation');

    // §缺估：需要排程卻沒有估時（material／一般計畫任務）。
    const est = Number(t.estimated_minutes);
    const missingEstimate = !(Number.isInteger(est) && est > 0);
    if (missingEstimate && kind !== 'school_assignment' && !taskBlocks.length) itemWarnings.push('missing_estimate');

    // display_mode 決策：
    //   school_assignment 有 deadline → 'deadline'（老師期限為主，工作時段附在 day_blocks）
    //   有 block 且未違反上限 → 'range'
    //   有 block 但違反上限 → 'gap'
    //   無 block（在計畫內卻沒排入）→ 'unscheduled'
    let displayMode;
    if (kind === 'school_assignment' && t.deadline_date) displayMode = 'deadline';
    else if (taskBlocks.length) displayMode = violated ? 'gap' : 'range';
    else displayMode = 'unscheduled';

    items.push({
      task_id: taskId,
      kind,
      subject_id: subjectId,
      subject_name: subjectName,
      material: mat ? { book_id: mat.book_id ?? null, book_title: mat.book_title ?? null, path: mat.path || [], item_title: mat.item_title ?? null } : null,
      title: t.title,
      display_mode: displayMode,
      range_start: displayMode === 'range' || displayMode === 'gap' ? rangeStart : null,
      range_end: displayMode === 'range' || displayMode === 'gap' ? rangeEnd : null,
      deadline_date: t.deadline_date || null,
      deadline_time: t.deadline_time || null,
      planned_minutes: plannedMinutes,
      estimated_minutes: Number.isInteger(est) && est > 0 ? est : null,
      block_ids: blockIds,
      day_blocks: dayBlocks,               // 展開才看每日安排；沒有時段就是 null，不捏造
      completion,
      locked: lockedTaskIds.has(taskId),
      warnings: itemWarnings,
    });
    for (const w of itemWarnings) warnings.push({ code: w, task_id: taskId });
  }

  // 依 display_mode 分流。
  const rangeItems = items.filter(i => i.display_mode === 'range');
  const gapItems = items.filter(i => i.display_mode === 'gap');
  const deadlineItems = items.filter(i => i.display_mode === 'deadline')
    .sort((a, b) => (a.deadline_date || '').localeCompare(b.deadline_date || '') || (a.deadline_time || '').localeCompare(b.deadline_time || ''));
  const unscheduledItems = items.filter(i => i.display_mode === 'unscheduled');

  // §9/§10：日期區間 → 內容。同 (range_start,range_end) 的 range item 併成一個 segment，
  // segment 內再按科目分組。不重複列同一 Task（每個 Task 只有一個合併區間）。
  const segMap = new Map();
  for (const it of rangeItems) {
    const key = `${it.range_start}|${it.range_end}`;
    const seg = segMap.get(key) || { range_start: it.range_start, range_end: it.range_end, display_mode: 'range', groups: new Map() };
    const g = seg.groups.get(it.subject_id ?? -1) || { subject_id: it.subject_id, subject_name: it.subject_name, task_ids: [] };
    g.task_ids.push(it.task_id);
    seg.groups.set(it.subject_id ?? -1, g);
    segMap.set(key, seg);
  }
  const segments = [...segMap.values()]
    .map(s => ({ range_start: s.range_start, range_end: s.range_end, display_mode: 'range', groups: [...s.groups.values()] }))
    .sort((a, b) => a.range_start.localeCompare(b.range_start) || a.range_end.localeCompare(b.range_end));

  const range = rangeItems.length || gapItems.length
    ? {
      start: [...rangeItems, ...gapItems].reduce((m, i) => (m == null || i.range_start < m ? i.range_start : m), null),
      end: [...rangeItems, ...gapItems].reduce((m, i) => (m == null || i.range_end > m ? i.range_end : m), null),
    }
    : null;

  return {
    plan: { id: plan.id, status: plan.status, target_date: planTarget },
    active: scheduable,
    active_version_id: scheduable ? activeVersionId : null,
    range,
    segments,
    deadlines: deadlineItems,
    unscheduled: unscheduledItems,
    gaps: gapItems,
    items,
    warnings,
    // 沒有 active 排程（無 active 版本、或非現役計畫）→ 明確空狀態，不捏造。
    empty: !rangeItems.length && !gapItems.length && !deadlineItems.length && !unscheduledItems.length,
    no_active_schedule: !scheduable,
  };
}
