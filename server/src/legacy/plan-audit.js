// Legacy Task → Plan 的判定邏輯。
//
// 抽出來成模組是為了測得到：CLI 裡的邏輯沒有人能寫負向測試，而這裡最需要被
// 釘住的恰恰是負向行為——「看起來像一組的資料，不可以被判定成可以自動 migration」。
//
// 這個檔案不碰資料庫、不寫任何東西，全部是純函式。

import { createHash } from 'node:crypto';

// 舊的讀書計劃任務長什麼樣：標題用「｜」串起科目／書名／章節，或帶著「讀書計劃」標籤。
// 這兩個都只用來**辨識這是不是舊資料**，不用來推論它屬於哪一個 Plan。
export const STUDY_TAG = '讀書計劃';
export const LEGACY_TITLE_SEPARATOR = '｜';

export function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  try { const v = JSON.parse(tags || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

export function isLegacyTask(task) {
  if (task?.plan_id != null) return false;              // 已經是正式 Plan 的任務
  return parseTags(task?.tags).includes(STUDY_TAG)
    || String(task?.title || '').includes(LEGACY_TITLE_SEPARATOR);
}

// 這是整份 audit 的核心判斷，也是最容易被寫鬆的一段。
//
// deterministic 的門檻只有一個：**存在非推論性的 Plan 歸屬證據**。
// 目前 schema 裡沒有這種欄位（tasks 上唯一的 Plan 欄位就是 plan_id 本身），
// 所以這個函式現在對所有 legacy 任務都回 false。
//
// 刻意逐項列出「不算證據」的東西，並附上理由——之後若有人想放寬，
// 會先撞到這段文字，而不是不小心把 heuristic 加進來：
//   ・created_at：只代表同一批建立，不代表同一個計畫
//   ・title（含「｜」與相似度）：舊的組合字串格式，不是 identity
//   ・list_id：科目分類。一科可以有很多計畫，一個計畫也可以跨科
//   ・due_date / due_time：排程鏡射，不是 deadline，也不是 Plan 邊界
//   ・material_content_item_id：說得出「這是哪一段教材」，說不出「屬於哪一次計畫」；
//     同一段教材可以出現在很多個 Plan 裡
export function planProvenance(task) {
  // 未來若新增了真正的 provenance 欄位（例如 legacy_plan_ref），在這裡讀它。
  const ref = task?.legacy_plan_ref;
  if (ref == null || ref === '') return null;
  return { kind: 'explicit_ref', value: ref };
}

export function isDeterministicallyMigratable(task) {
  return planProvenance(task) != null;
}

// 一批 legacy 任務 → 判定摘要。refs 提供每個 task 的歷史參照數量。
export function classify(tasks, { blockRefs = new Map(), sessionRefs = new Map() } = {}) {
  const legacy = tasks.filter(isLegacyTask);
  const deterministic = legacy.filter(isDeterministicallyMigratable);
  const ambiguous = legacy.filter(t => !isDeterministicallyMigratable(t));

  const lifecycle = { active: 0, completed: 0, cancelled: 0, deleted: 0 };
  for (const t of legacy) {
    if (t.deleted) lifecycle.deleted += 1;
    else if (t.cancelled) lifecycle.cancelled += 1;
    else if (t.completed) lifecycle.completed += 1;
    else lifecycle.active += 1;
  }

  const referenced = t => blockRefs.has(t.id) || sessionRefs.has(t.id);
  return {
    legacy_tasks: legacy.length,
    distinct_affected_users: new Set(legacy.map(t => t.user_id)).size,
    lifecycle,
    deterministic: deterministic.length,
    ambiguous: ambiguous.length,
    // 沒有 deterministic 資料就沒有東西可建、可掛。這兩個數字必須從判定推導，
    // 不可以另外估——「預估會建 N 個 Plan」一旦與判定脫鉤就是在猜。
    projected_plans_to_create: deterministic.length ? null : 0,
    projected_tasks_to_attach: deterministic.length,
    history_references: {
      tasks_with_scheduled_block: legacy.filter(t => blockRefs.has(t.id)).length,
      tasks_with_study_session: legacy.filter(t => sessionRefs.has(t.id)).length,
      deleted_tasks_still_referenced: legacy.filter(t => t.deleted && referenced(t)).length,
    },
  };
}

// 人工審核用的分組。名字刻意不叫 plan_candidates：這是「請人看一眼」的清單，
// 不是「可以照這樣建 Plan」的建議。分組鍵是 user + 科目，只為了讓人好讀，
// 不代表任何 Plan 邊界。
export function reviewGroups(tasks, { blockRefs = new Map(), sessionRefs = new Map(), auditSalt = '' } = {}) {
  const groups = new Map();
  for (const t of tasks.filter(isLegacyTask)) {
    const key = `${t.user_id}:${t.list_id ?? 'none'}`;
    const g = groups.get(key) || {
      user_ref: auditSubjectRef(t.user_id, auditSalt), list_id: t.list_id ?? null, tasks: 0,
      active: 0, completed: 0, cancelled: 0, deleted: 0,
      with_scheduled_block: 0, with_study_session: 0,
    };
    g.tasks += 1;
    if (t.deleted) g.deleted += 1;
    else if (t.cancelled) g.cancelled += 1;
    else if (t.completed) g.completed += 1;
    else g.active += 1;
    if (blockRefs.has(t.id)) g.with_scheduled_block += 1;
    if (sessionRefs.has(t.id)) g.with_study_session += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.tasks - a.tasks);
}

// 不可逆、每次 audit-local 的使用者代號。salt 不輸出，因此外部報告無法直接還原 user_id。
function auditSubjectRef(userId, auditSalt) {
  return `user-${createHash('sha256').update(`${auditSalt}\u0000${userId}`).digest('hex').slice(0, 12)}`;
}
