import { api } from '../api';

// 排程套用層：整個 App 只有這裡把「排程結果（preview blocks）」交給後端。
// 2C 起 ScheduledBlock 是時間唯一真相；後端會在同一筆交易建立新版、切 active
// 並鏡射 due_date / due_time。前端不可以再直接寫這兩個欄位。
//
// 這裡刻意不做的事：
//   ・不在前端直接寫 scheduled_blocks / schedule_versions（後端 persistence 唯一負責）
//   ・不在前端另存一份排程狀態（沒有第三套 schedule store）
//   ・Edit Mode 不 POST /plans（會多生一個計畫）
//   ・任何模式都不呼叫 legacy DELETE /plan-tasks。那支照「讀書計劃」標籤／
//     標題全域刪，正式 Plan 的任務同樣帶那個標籤，會誤刪別的計畫。
//     新流程一律針對「明確知道 id 而且 plan_id == null」的舊任務逐筆軟刪除。

/* ---------- 身分比對 ---------- */

// 一個 Task 與一個 block 是不是「同一件事」：同科目＋同標題。
// 標題是精靈用（書名＋章＋單元＋題型）決定性組出來的，同一份計畫裡穩定。
// 注意：這個比對只在「同一個 plan_id 底下」使用——不是全域的標題猜測，
// 不能拿去合併 legacy 資料（docs/phase2-plan-domain.md §5A 的閘門還沒解除）。
export const taskKey = t => `${t.list_id ?? ''}|${t.title}`;
export const blockKey = b => `${b.subject_id ?? ''}|${b.title}`;

// block → Task 的非排程欄位。deadline（硬性截止）與排定日期是兩件事；
// deadline_date 可直接保存，date / start_time 只可交給 ScheduledBlock。
export function blockFields(b) {
  return {
    title: b.title,
    list_id: b.subject_id ?? null,
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
  existingTasks = [], legacyMerged = [], removeUnscheduled = true, updatePlanDates = true,
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
    const newTasks = create.map((block, i) => ({ client_key: `new-${i}`, block }));
    const refs = new Map(newTasks.map(x => [x.block, x.client_key]));
    await api('/schedule/apply', {
      method: 'POST',
      body: {
        plan_id: planId,
        source: 'ai_replan',
        task_updates: update.map(({ task, block }) => {
          const { notes, deadline_date } = blockFields(block);
          return { task_id: task.id, notes, deadline_date };
        }),
        task_creates: newTasks.map(({ client_key, block }) => ({ client_key, ...blockFields(block), tags: ['讀書計劃'] })),
        task_delete_ids: removeUnscheduled ? remove.map(t => t.id) : [],
        blocks: [
          ...update.map(({ task, block }) => toScheduledBlock(block, { task_id: task.id })),
          ...create.map(block => toScheduledBlock(block, { client_key: refs.get(block) })),
        ],
      },
    });
    // 重排（Replan）只是把既有內容搬到新的日子，不該順手改掉使用者自己設的
    // 起訖日，也不會改名 —— 所以 updatePlanDates=false 時整個 PATCH 都跳過。
    const patch = { ...(updatePlanDates ? meta : {}), ...(name.trim() ? { name: name.trim() } : {}) };
    if (Object.keys(patch).length) await api(`/plans/${planId}`, { method: 'PATCH', body: patch });
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
  const newTasks = blocks.map((block, i) => ({ client_key: `new-${i}`, block }));
  const refs = new Map(newTasks.map(x => [x.block, x.client_key]));
  await api('/schedule/apply', {
    method: 'POST',
    body: {
      plan_id: plan.id,
      source: 'initial',
      task_creates: newTasks.map(({ client_key, block }) => ({ client_key, ...blockFields(block), tags: ['讀書計劃'] })),
      blocks: blocks.map(block => toScheduledBlock(block, { client_key: refs.get(block) })),
    },
  });
  // 舊資料的未完成項目若已經併進這次排程，就把「那幾筆」軟刪除，不然會重複。
  //
  // 這裡刻意逐筆走 DELETE /tasks/:id，不用 legacy 的全域 DELETE /plan-tasks——
  // 那支是照「讀書計劃」標籤／標題全域刪的，正式 Plan 的任務同樣帶那個標籤，
  // 會把別的計畫的未完成任務一起刪掉。id 拿不到的寧可留著不刪：
  // 資料重複遠比跨計畫誤刪安全。
  const safe = legacyMerged.filter(t => t && t.id != null && t.plan_id == null && !t.completed);
  for (const t of safe) await api(`/tasks/${t.id}`, { method: 'DELETE' });
  return { planId: plan.id, created: blocks.length, updated: 0, removed: safe.length };
}

function toScheduledBlock(block, ref) {
  return {
    ...ref,
    date: block.date,
    start_time: block.start_time || null,
    end_time: block.end_time || null,
    planned_minutes: block.minutes ?? null,
  };
}
