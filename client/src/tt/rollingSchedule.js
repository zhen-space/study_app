// 段考滾動排程（Rolling Exam Schedule v1）前端純函式。
//
// 只負責「把 backend 的 rolling preview 整理成畫面要的區塊」與「把使用者的 override
// 選擇 / 確認後的 apply payload 組出來」。所有 placement／freeze／deadline 判定都在
// backend；前端不自建任何排程或 weekday 演算法，也絕不直接建立 ScheduledBlock——
// 一律走 /api/schedule/rolling/apply。

export const INFEASIBLE_OPTIONS = [
  { value: 'KEEP_CURRENT', label: '維持目前安排' },
  { value: 'RELAX_FREEZE', label: '放寬今天／明天的凍結' },
  { value: 'SELECT_MOVABLE_BLOCKS', label: '指定可移動的安排' },
];

const isFrozen = (date, win) => !!win && date >= win.freeze_start && date <= win.freeze_through;

// 把 preview.diff 整理成畫面區塊。frozen（今天／明天）一定落在 unchanged；
// 其餘照 diff type 分到 added / moved / removed；unplaced 另外列。
export function sectionize(preview) {
  const win = preview?.window || null;
  const items = preview?.diff?.items || [];
  const out = { frozen: [], unchanged: [], added: [], moved: [], removed: [] };
  for (const it of items) {
    const date = it.after_blocks?.[0]?.date || it.before_blocks?.[0]?.date || null;
    if (it.type === 'unchanged') {
      (isFrozen(date, win) ? out.frozen : out.unchanged).push(it);
    } else if (out[it.type]) {
      out[it.type].push(it);
    }
  }
  return out;
}

// preview 的 frozen 是否真的都維持不動（moved/removed 代表 candidate 不合法）。
export function frozenIntact(preview) {
  const frozenTaskIds = new Set((preview?.frozen || []).map(b => Number(b.task_id)));
  return !(preview?.diff?.items || []).some(it =>
    frozenTaskIds.has(Number(it.task_id)) && (it.type === 'moved' || it.type === 'removed'));
}

// 使用者的 override 選擇 → rolling preview 要帶的 freeze payload。server 不自己猜，
// 未指定的 frozen block 一律維持 exact freeze。
export function buildFreezePayload(mode, { movableBlockIds = [], horizonDays } = {}) {
  const freeze = {};
  if (Number.isInteger(horizonDays)) freeze.horizon_days = horizonDays;
  if (mode === 'RELAX_FREEZE') freeze.override = { mode: 'relax_freeze' };
  else if (mode === 'SELECT_MOVABLE_BLOCKS') freeze.override = { mode: 'select_movable', movable_block_ids: movableBlockIds.map(Number) };
  return freeze;
}

// 確認後要送去 /rolling/apply 的 payload。只帶「位置」與 guard 欄位；attach / freeze /
// deadline / carry-forward 全部由 backend 在 transaction 內用此刻的 DB 重驗。
export function applyPayload(preview) {
  return {
    plan_id: preview.plan_id,
    base_version_id: preview.base_version_id,
    blocks: preview.blocks || [],
    attach_task_ids: preview.attach_task_ids || [],
    freeze_blocks: (preview.frozen || []).map(b => ({
      task_id: b.task_id, date: b.date, start_time: b.start_time || null,
      end_time: b.end_time || null, planned_minutes: b.planned_minutes ?? null,
    })),
    freeze_start: preview.window?.freeze_start,
  };
}

// 是否可以直接確認套用（沒有 infeasible、frozen 完整、且有東西可套）。
export function canConfirm(preview) {
  return !!preview && !preview.infeasible && frozenIntact(preview) && (preview.blocks || []).length > 0;
}
