// 段考「進度安排」投影（Plan Progress Projection）——**純函式**，不碰 DB、不排程。
//
// 這是 A 層（progress segments）：回答「哪一段日期以前，要讀完哪些教材範圍」。
// 它跟 B 層（確切安排 = ScheduledBlock）完全分離：
//   ・segment 存的是「範圍目標＋期限」這個學習意圖本身（plan_progress_segments）
//   ・完成度不存在 segment 裡；投影時才把 material_progress 的 CURRENT 完成事實
//     疊上去算「已完成幾項／落後或超前」。不冒充完成、不臆測。
//   ・沒有 segment 的 Plan＝尚未安排進度，回空，不憑空生區間。
//
// 落後／超前的判定原則（誠實優先）：
//   ・scope 全部完成 → done（不管日期）
//   ・還沒到 start_date → upcoming
//   ・已過 end_date 又沒讀完 → behind
//   ・視窗內：有 start_date 才用配速比對（elapsed/總天數）判 behind／ahead／on_track；
//     沒有 start_date 就只能保守回 on_track，不臆測配速。

import { parseDay } from '../util/date.js';

// 含兩端的天數差（'2026-09-28'→'2026-10-02' = 4）。
function daysBetween(a, b) {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86400000);
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// 單一 segment 的投影。scope 是 content_item_id 陣列（範圍目標，不是選取、不是完成）。
export function projectSegment(seg, completedItemIds, today) {
  const scope = Array.isArray(seg.scope) ? seg.scope.map(Number).filter(Number.isFinite) : [];
  const total = scope.length;
  const completed = scope.filter(id => completedItemIds.has(Number(id))).length;
  const percent = total ? Math.round((completed / total) * 100) : 0;

  const start = seg.start_date || null;
  const end = seg.end_date || null;

  // 時間相對狀態（跟完成度無關）。
  let timeStatus = 'active';
  if (today && start && today < start) timeStatus = 'upcoming';
  else if (today && end && today > end) timeStatus = 'past';

  // 依配速的期望完成比例：只有同時有 start／end／today 且 start<=end 才算，否則 null。
  let expectedPercent = null;
  if (today && start && end && start <= end) {
    const span = daysBetween(start, end) + 1;            // 含兩端的總天數
    const elapsed = clamp(daysBetween(start, today) + 1, 0, span);
    expectedPercent = span > 0 ? Math.round((elapsed / span) * 100) : null;
  }

  // 落後／超前。scope 為空時沒有可量的進度 → on_track（由 UI 提示尚未指定範圍）。
  let status;
  if (total > 0 && completed >= total) status = 'done';
  else if (timeStatus === 'upcoming') status = 'upcoming';
  else if (timeStatus === 'past') status = 'behind';
  else if (expectedPercent != null && total > 0) {
    status = percent < expectedPercent ? 'behind' : percent > expectedPercent ? 'ahead' : 'on_track';
  } else status = 'on_track';

  return {
    id: seg.id ?? null,
    plan_id: seg.plan_id ?? null,
    title: seg.title,
    kind: seg.kind || 'study',
    start_date: start,
    end_date: end,
    subject_list_id: seg.subject_list_id ?? null,
    subject_name: seg.subject_name ?? null,
    order_index: seg.order_index ?? 0,
    scope,
    total,
    completed_count: completed,
    percent,
    expected_percent: expectedPercent,
    time_status: timeStatus,
    status,
    behind: status === 'behind',
  };
}

// Plan 全部 segment 的投影 + 摘要。segments 依 order_index／end_date 排序後投影。
export function buildPlanProgress({ segments = [], completedItemIds = new Set(), today = null } = {}) {
  const done = completedItemIds instanceof Set ? completedItemIds : new Set((completedItemIds || []).map(Number));
  const ordered = [...segments].sort(
    (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)
      || String(a.end_date || '').localeCompare(String(b.end_date || ''))
      || (a.id ?? 0) - (b.id ?? 0));
  const projected = ordered.map(s => projectSegment(s, done, today));

  const totalItems = projected.reduce((n, s) => n + s.total, 0);
  const completedItems = projected.reduce((n, s) => n + s.completed_count, 0);
  return {
    segments: projected,
    summary: {
      segment_count: projected.length,
      behind_count: projected.filter(s => s.behind).length,
      done_count: projected.filter(s => s.status === 'done').length,
      total_items: totalItems,
      completed_items: completedItems,
      percent: totalItems ? Math.round((completedItems / totalItems) * 100) : 0,
      // 任何一段已過期又沒讀完 → 這個計畫「需要調整進度」。
      needs_attention: projected.some(s => s.behind),
    },
    empty: projected.length === 0,
  };
}
