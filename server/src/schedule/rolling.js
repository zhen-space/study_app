// 段考滾動排程（Rolling Exam Schedule v1）。
//
// 這裡**不是**第二套 scheduler，也**不是**新的 Plan type／lifecycle／schema。
// 它是一層薄薄的 orchestration：
//   ・freeze horizon（今天／明天）用既有 preview 的 pin 機制凍結，
//   ・tail 從後天起交給**完全相同**的 runPreview placement 演算法重排，
//   ・apply 走既有 applySchedule 的 transaction，只多幾道 defence-in-depth 檢查。
//
// rolling policy 存在既有 plan_constraints.intent_json.rolling_replan，
// server-readable、structured，不靠 Plan name/title 推斷（§2）。

import { addDays, todayTW } from '../util/date.js';

export const ROLLING_POLICY_KEY = 'rolling_replan';
export const DEFAULT_FREEZE_HORIZON_DAYS = 2;   // 今天 + 明天

// intent_json → { enabled, freeze_horizon_days }。壞資料一律當作「未啟用」，
// 不報錯——排程偏好不該把 preview 打掛。
export function parseRollingPolicy(intentJson) {
  let intent = intentJson;
  if (typeof intentJson === 'string') { try { intent = JSON.parse(intentJson || '{}'); } catch { intent = {}; } }
  const raw = (intent && typeof intent === 'object') ? intent[ROLLING_POLICY_KEY] : null;
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return { enabled: false, freeze_horizon_days: DEFAULT_FREEZE_HORIZON_DAYS };
  const n = Number(raw.freeze_horizon_days);
  const days = Number.isInteger(n) && n >= 1 && n <= 14 ? n : DEFAULT_FREEZE_HORIZON_DAYS;
  return { enabled: true, freeze_horizon_days: days };
}

// Freeze window。Asia/Taipei 是唯一權威的 school-day 邊界（§3）。
//   today          = todayTW()
//   freeze_through = 最後一個被凍結的日子（horizon_days=2 → 明天）
//   rolling_start  = optimizer 可以動的第一天（horizon_days=2 → 後天）
export function freezeWindow(today = todayTW(), horizonDays = DEFAULT_FREEZE_HORIZON_DAYS) {
  const days = Number.isInteger(horizonDays) && horizonDays >= 1 ? horizonDays : DEFAULT_FREEZE_HORIZON_DAYS;
  return {
    today,
    freeze_horizon_days: days,
    freeze_start: today,
    freeze_through: addDays(today, days - 1),
    rolling_start: addDays(today, days),
  };
}

// 一個日期是否落在凍結窗內（今天 ~ freeze_through）。過去的日子不算「凍結的未來」。
export const isFrozenDate = (date, win) => !!date && date >= win.freeze_start && date <= win.freeze_through;

// 兩個 block 的 placement 是否逐欄相同（task_id/date/start/end/minutes）。
// freeze 驗證與 diff「unchanged」用同一把尺，避免一邊說凍住、一邊判成 moved。
export function samePlacement(a, b) {
  return Number(a.task_id) === Number(b.task_id)
    && a.date === b.date
    && (a.start_time || null) === (b.start_time || null)
    && (a.end_time || null) === (b.end_time || null)
    && Number(a.planned_minutes ?? 0) === Number(b.planned_minutes ?? 0);
}

// §11 hard deadline：純函式，preview 與 apply 共用同一份判定（defence-in-depth）。
//   block.date  >  deadline_date                         → 違反
//   block.date === deadline_date 且 deadline_time != NULL 且 end_time > deadline_time → 違反
//   deadline_time == NULL → 當天結束以前，同日一律放行
// 回傳違反的結構，沒問題回 null。
export function deadlineViolation(block, task) {
  if (!task || !task.deadline_date) return null;
  if (block.date > task.deadline_date) {
    return { task_id: Number(block.task_id), type: 'deadline', deadline_date: task.deadline_date, deadline_time: task.deadline_time || null, block_date: block.date };
  }
  if (task.deadline_time && block.date === task.deadline_date && block.end_time && block.end_time > task.deadline_time) {
    return { task_id: Number(block.task_id), type: 'deadline', deadline_date: task.deadline_date, deadline_time: task.deadline_time, block_date: block.date, block_end_time: block.end_time };
  }
  return null;
}

// override（§8）正規化。使用者的放寬選擇必須存在 preview request 裡，server 不自己猜。
//   mode: 'none' | 'relax_freeze' | 'select_movable'
//   movable_block_ids: SELECT_MOVABLE_BLOCKS 時，使用者明確允許移動的 frozen block id
// 未指定的 frozen block 一律維持 exact freeze。Lock/deadline 永遠不被 override 放寬。
export function normalizeOverride(freeze) {
  const f = freeze || {};
  const ov = f.override || null;
  if (!ov) return { mode: 'none', movableIds: new Set() };
  if (ov.mode === 'relax_freeze' || ov === 'relax_freeze') return { mode: 'relax_freeze', movableIds: new Set() };
  if (ov.mode === 'select_movable' || ov === 'select_movable') {
    const ids = Array.isArray(ov.movable_block_ids) ? ov.movable_block_ids.map(Number).filter(Number.isInteger) : [];
    return { mode: 'select_movable', movableIds: new Set(ids) };
  }
  return { mode: 'none', movableIds: new Set() };
}

// 從「現在的 active schedule」挑出 current plan 在凍結窗內、且未被 override 放行的
// block —— 這些就是必須 exact-freeze 的 pin。回傳 { frozen, movable }。
export function partitionFreeze(activeBlocks, planId, win, override) {
  const frozen = [];
  const movable = [];
  for (const b of activeBlocks) {
    if (Number(b.plan_id) !== Number(planId)) continue;   // 只凍結 current plan（其他 Plan 由 carry-forward 處理）
    if (!isFrozenDate(b.date, win)) continue;
    const relaxed = override.mode === 'relax_freeze'
      || (override.mode === 'select_movable' && override.movableIds.has(Number(b.id)));
    if (relaxed) movable.push(b); else frozen.push(b);
  }
  return { frozen, movable };
}
