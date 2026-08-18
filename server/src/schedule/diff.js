// Phase 2C-P5：immutable ScheduleVersion 的純 diff engine。
// 只比較 ScheduledBlock placement，絕不讀／猜 tasks.due_date 或標題。

const placement = block => ({
  date: block.date,
  start_time: block.start_time ?? null,
  end_time: block.end_time ?? null,
  planned_minutes: block.planned_minutes ?? null,
});

const compareValue = (a, b) => (a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0;
const comparePlacement = (a, b) => compareValue(a.date, b.date)
  || compareValue(a.start_time, b.start_time)
  || compareValue(a.end_time, b.end_time)
  || compareValue(a.planned_minutes, b.planned_minutes);

export function canonicalBlocks(blocks, comparisonFrom) {
  return blocks.filter(block => block.date >= comparisonFrom)
    .map(placement).sort(comparePlacement);
}

const byTask = (blocks, comparisonFrom) => {
  const groups = new Map();
  for (const block of blocks) {
    if (block.date < comparisonFrom) continue;
    const id = Number(block.task_id);
    const group = groups.get(id) || { task_id: id, blocks: [], display: null };
    group.blocks.push(block);
    // canonical 第一個 block 的 snapshot 是穩定且可在 task 被刪後仍顯示的名稱。
    if (!group.display) group.display = block;
    groups.set(id, group);
  }
  for (const group of groups.values()) group.blocks = canonicalBlocks(group.blocks, comparisonFrom);
  return groups;
};

const equal = (a, b) => a.length === b.length && a.every((x, i) => comparePlacement(x, b[i]) === 0);
const flags = (before, after) => {
  const n = Math.max(before.length, after.length);
  let date_changed = false, time_changed = false, duration_changed = false;
  for (let i = 0; i < n; i++) {
    const a = before[i], b = after[i];
    if ((a?.date ?? null) !== (b?.date ?? null)) date_changed = true;
    if ((a?.start_time ?? null) !== (b?.start_time ?? null) || (a?.end_time ?? null) !== (b?.end_time ?? null)) time_changed = true;
    if ((a?.planned_minutes ?? null) !== (b?.planned_minutes ?? null)) duration_changed = true;
  }
  return { date_changed, time_changed, duration_changed };
};

const sortItems = (a, b) => {
  const first = item => item.after_blocks[0] || item.before_blocks[0] || {};
  return comparePlacement(first(a), first(b)) || a.task_id - b.task_id;
};

// before / after 均為 immutable ScheduledBlock rows。多 block task 以整組 placement
// 判斷：部分 block 消失仍是 moved，不會錯拆成 removed + added。
export function calculateScheduleDiff(beforeBlocks, afterBlocks, {
  comparisonFrom,
  baseVersionId = null,
  candidateVersionId = null,
  isInitial = false,
  includeUnchanged = true,
} = {}) {
  const summary = { unchanged: 0, moved: 0, added: 0, removed: 0, changed: 0 };
  if (isInitial) {
    summary.added = afterBlocks.filter(block => block.date >= comparisonFrom).length;
    return { base_version_id: null, candidate_version_id: candidateVersionId, comparison_from: comparisonFrom, is_initial: true, summary, items: [] };
  }
  const before = byTask(beforeBlocks, comparisonFrom);
  const after = byTask(afterBlocks, comparisonFrom);
  const ids = new Set([...before.keys(), ...after.keys()]);
  const items = [];
  for (const taskId of ids) {
    const left = before.get(taskId), right = after.get(taskId);
    const before_blocks = left?.blocks || [], after_blocks = right?.blocks || [];
    const type = !before_blocks.length ? 'added'
      : !after_blocks.length ? 'removed'
        : equal(before_blocks, after_blocks) ? 'unchanged' : 'moved';
    summary[type]++;
    if (type === 'unchanged' && !includeUnchanged) continue;
    const display = right?.display || left?.display || {};
    const item = {
      task_id: taskId, type,
      task_title_snapshot: display.task_title_snapshot || null,
      subject_name_snapshot: display.subject_name_snapshot || null,
      before_blocks, after_blocks,
    };
    if (type === 'moved') item.change_flags = flags(before_blocks, after_blocks);
    items.push(item);
  }
  items.sort(sortItems);
  return { base_version_id: baseVersionId, candidate_version_id: candidateVersionId, comparison_from: comparisonFrom, is_initial: false, summary, items };
}
