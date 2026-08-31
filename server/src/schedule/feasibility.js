// Phase 2C-P6：單一 placement 的可行性規則。純函式，不查 DB。
//
// 這裡是「一個 block 放在這個日期／時段，到底行不行」的唯一答案。
// Restore（把舊版當 template 放回去）與手動調整（使用者自己拖時間）
// 問的是同一個問題，所以只能有一份規則——兩邊各寫一份，遲早會分岔，
// 變成「恢復擋得住、手動繞得過」。
//
// 這個檔案刻意不處理：
//   ・Lock（schedule/locks.js 負責，它比對的是整份 candidate 不是單一 block）
//   ・candidate 內部的時段重疊（persistence.validateTimedBlockOverlaps 負責，
//     那是整份 snapshot 的不變式，不是單一 placement 的性質）
//   ・跨 Plan 碰撞——candidate 本來就是 user-level 全域 snapshot，
//     其他 Plan 的 block 就在裡面，不需要特別一條規則

// 固定行程：weekly 只在「同星期幾、而且已經開始」的日子生效。
export function fixedEventApplies(event, date, dayOfWeek) {
  return event.recurring === 'weekly'
    ? dayOfWeek(event.date) === dayOfWeek(date) && event.date <= date
    : event.date === date;
}

// 只有兩邊都帶完整起訖時間才算「時段重疊」。
// 純待辦模式的 date-only block 同一天可以並存，不能被誤判成碰撞。
export function timedOverlap(a, b) {
  return a.date === b.date && a.start_time && a.end_time && b.start_time && b.end_time
    && a.start_time < b.end_time && b.start_time < a.end_time;
}

// 一個 placement 的判定結果：
//   null                     → 可以放
//   { kind:'skip', ... }     → 這個任務已經退出未來排程（完成／取消／刪除），
//                              不是衝突，也不該叫使用者去解決
//   { kind:'conflict', ... } → 真的放不下，要讓使用者知道原因
//
// 回傳的 type 字串就是既有 Restore preview 的 conflict type，不另立一套。
//
// 判定邏輯共用，但說法不共用：Restore 說的是「無法恢復」，手動調整說的是
// 「不能放在這裡」。用 messages 覆寫文案，不要為了文案去複製一份規則。
export const RESTORE_MESSAGES = {
  task_constraint: '任務已不屬於計畫，無法恢復',
  past: '原安排時間已過去，無法恢復',
  deadline: '目前期限早於原安排日期，無法恢復',
  fixed_event: title => `與固定行程「${title}」衝突`,
};

export function classifyPlacement(block, {
  task, events = [], planningDay, nowHM, dayOfWeek, messages = RESTORE_MESSAGES,
}) {
  const say = (key, arg) => {
    const m = messages[key] ?? RESTORE_MESSAGES[key];
    return typeof m === 'function' ? m(arg) : m;
  };
  if (!task || task.deleted) return { kind: 'skip', type: 'deleted' };
  if (task.completed) return { kind: 'skip', type: 'completed' };
  if (task.cancelled) return { kind: 'skip', type: 'cancelled' };
  // 未參與 active schedule 的 Plan 不應被 Restore 重新放回未來排程。
  // 沒有帶 plan_status 的舊呼叫端維持既有相容語意。
  if (task.plan_status && !['draft', 'active'].includes(task.plan_status)) {
    return { kind: 'skip', type: 'inactive_plan' };
  }
  if (task.plan_id == null) {
    return { kind: 'conflict', type: 'task_constraint', message: say('task_constraint') };
  }
  // 過去：整天已經過去，或當天但這個時段已經結束。
  // date-only 的 block 只要日期還是今天就仍算得上未來。
  const isPast = block.date < planningDay
    || (block.date === planningDay && block.end_time && block.end_time <= nowHM);
  if (isPast) return { kind: 'conflict', type: 'past', message: say('past') };
  // deadline_date 是硬性截止日，跟「排定在哪一天」是兩件事，永遠不能被排程覆寫。
  //
  // deadline_time 把同一條規則延伸到時分，而且是 **generic Task 行為**，
  // 不是學校作業的第二套排程器：任何 Task 只要填了 deadline_time，
  // 當天的 timed block 就必須在那個時間以前結束。
  //   ・candidate < deadline_date          → 允許
  //   ・candidate = deadline_date          → timed block 的 end_time 必須 <= deadline_time
  //   ・candidate > deadline_date          → 拒絕
  // deadline_time 為 NULL 時等於當天結束，所以同一天一律放行（維持原本行為）。
  if (task.deadline_date && block.date > task.deadline_date) {
    return {
      kind: 'conflict', type: 'deadline',
      message: say('deadline'), deadline_date: task.deadline_date,
    };
  }
  if (task.deadline_date && task.deadline_time
    && block.date === task.deadline_date && block.end_time && block.end_time > task.deadline_time) {
    return {
      kind: 'conflict', type: 'deadline',
      message: say('deadline'), deadline_date: task.deadline_date, deadline_time: task.deadline_time,
    };
  }
  const fixed = events.find(event => fixedEventApplies(event, block.date, dayOfWeek) && timedOverlap(block, event));
  if (fixed) {
    return {
      kind: 'conflict', type: 'fixed_event',
      message: say('fixed_event', fixed.title), event_title: fixed.title,
    };
  }
  return null;
}

// 一組 placement 彼此撞在一起的索引。回傳索引而不是 block，
// 呼叫端才能同時知道「誰撞到」與「原本在第幾個」。
export function findSelfCollisions(blocks) {
  const collided = new Set();
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (timedOverlap(blocks[i], blocks[j])) { collided.add(i); collided.add(j); }
    }
  }
  return collided;
}
