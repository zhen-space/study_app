import { api } from '../api';

// 排程套用層：整個 App 只有這裡把「排程結果（preview blocks）」寫進資料庫。
//
// 為什麼要獨立成一層：
//   目前排定的位置暫時借用 Task 的 due_date / due_time（見
//   docs/phase2c-schedule-persistence.md §5B 的 2A-1 過渡例外）。
//   2C 實作完之後，排定位置會改存 ScheduleVersion + ScheduledBlock，
//   屆時只要換掉這個檔案，排程精靈的三個步驟完全不用重寫。
//
// 這裡刻意不做的事（2C 之前都不准做）：
//   ・不寫 scheduled_blocks / schedule_versions（那是 2C 的事，還沒實作）
//   ・不在前端另存一份排程狀態（沒有第三套 schedule store）
//   ・Edit Mode 不 POST /plans（會多生一個計畫）
//   ・Edit Mode 不呼叫 legacy DELETE /plan-tasks（那支是全域的，會掃到別的計畫）

/* ---------- 身分比對 ---------- */

// 一個 Task 與一個 block 是不是「同一件事」：同科目＋同標題。
// 標題是精靈用（書名＋章＋單元＋題型）決定性組出來的，同一份計畫裡穩定。
// 注意：這個比對只在「同一個 plan_id 底下」使用——不是全域的標題猜測，
// 不能拿去合併 legacy 資料（docs/phase2-plan-domain.md §5A 的閘門還沒解除）。
export const taskKey = t => `${t.list_id ?? ''}|${t.title}`;
export const blockKey = b => `${b.subject_id ?? ''}|${b.title}`;

// block → Task 欄位。deadline（硬性截止）與 date（排定日期）是兩件事，
// 分別進 deadline_date 與 due_date，不可混用。
export function blockFields(b) {
  return {
    title: b.title,
    list_id: b.subject_id ?? null,
    due_date: b.date || null,
    due_time: b.start_time || null,
    notes: b.start_time ? `讀書時段 ${b.start_time}–${b.end_time}` : '',
    deadline_date: b.deadline || null,
  };
}

// 把新的排程結果對到既有任務上。
//   update：同一件事還在 → 沿用原本那筆（保住 id、完成紀錄、番茄鐘連結）
//   create：這次新增的內容
//   remove：這次不再排的、而且還沒完成的（呼叫端會軟刪除）
// 已完成的任務完全不進池子：不比對、不更新、不刪除。
export function reconcile(blocks, existing = []) {
  const pool = new Map();
  for (const t of existing) {
    if (t.deleted || t.completed) continue;
    const k = taskKey(t);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(t);
  }
  const update = [], create = [];
  for (const b of blocks) {
    const q = pool.get(blockKey(b));
    if (q && q.length) update.push({ task: q.shift(), block: b });
    else create.push(b);
  }
  return { update, create, remove: [...pool.values()].flat() };
}

/* ---------- 套用 ---------- */

// mode='create'：建立新計畫並把任務掛上去
// mode='edit'  ：只調整既有計畫，任務身分盡量保留
export async function applyWizardSchedule({
  mode = 'create', planId = null, name = '', blocks = [],
  existingTasks = [], clearLegacyLeftover = false, removeUnscheduled = true,
}) {
  const dates = blocks.map(b => b.date).filter(Boolean).sort();
  const counts = {};
  blocks.forEach(b => { counts[b.subject_id] = (counts[b.subject_id] || 0) + 1; });
  const primary = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  // primary_list_id 只是顯示提示，不代表 Plan 的身分（一個 Plan 可以跨科）
  const meta = {
    primary_list_id: primary ? Number(primary) : null,
    start_date: dates[0] || null,
    target_date: dates[dates.length - 1] || null,
  };

  if (mode === 'edit') {
    if (planId == null) throw new Error('缺少計畫 id，無法套用新版安排');
    const { update, create, remove } = reconcile(blocks, existingTasks);
    // ① 還在的：只改排定位置，標題／科目／標籤／完成狀態都不動
    for (const { task, block } of update) {
      const f = blockFields(block);
      await api(`/tasks/${task.id}`, {
        method: 'PATCH',
        body: { due_date: f.due_date, due_time: f.due_time, notes: f.notes, deadline_date: f.deadline_date },
      });
    }
    // ② 新增的
    if (create.length) {
      await api('/tasks/bulk', {
        method: 'POST',
        body: { tasks: create.map(b => ({ ...blockFields(b), tags: ['讀書計劃'], plan_id: planId })) },
      });
    }
    // ③ 這次不再排的：軟刪除（進垃圾桶，救得回來），只動這個計畫底下的。
    //    使用者選「維持原本日期不動」時（removeUnscheduled=false）一筆都不刪。
    if (removeUnscheduled) for (const t of remove) await api(`/tasks/${t.id}`, { method: 'DELETE' });
    await api(`/plans/${planId}`, { method: 'PATCH', body: { ...meta, ...(name.trim() ? { name: name.trim() } : {}) } });
    return {
      planId, created: create.length, updated: update.length,
      removed: removeUnscheduled ? remove.length : 0,
      kept: removeUnscheduled ? 0 : remove.length,
    };
  }

  // create：一次排程＝一個正式 Plan
  const plan = await api('/plans', {
    method: 'POST',
    body: { name, ...meta, status: 'active', source: 'manual' },
  });
  // 舊資料還沒 migrate，未做完的那批已經併進這次排程 → 清掉舊的。
  // 這支是 legacy 全域端點，只有「建立新計畫」時才允許呼叫。
  if (clearLegacyLeftover) { try { await api('/plan-tasks', { method: 'DELETE' }); } catch {} }
  await api('/tasks/bulk', {
    method: 'POST',
    body: { tasks: blocks.map(b => ({ ...blockFields(b), tags: ['讀書計劃'], plan_id: plan.id })) },
  });
  return { planId: plan.id, created: blocks.length, updated: 0, removed: 0 };
}
