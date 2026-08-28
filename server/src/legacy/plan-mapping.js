// Legacy Task → Plan 的 authoritative mapping domain。
//
// 這一層存在的理由很單純：legacy 任務身上**沒有**任何欄位記錄過它屬於哪個 Plan
// （tasks 上唯一的 Plan 欄位就是 plan_id 本身，legacy 列是 NULL）。既然資料裡沒有
// 答案，就必須有一個地方明確地把答案「補上去」，而且要記得下這個判斷的是誰、
// 根據什麼、什麼時候。那個地方就是 legacy_task_plan_mappings。
//
// 三件必須一直成立的事：
//   1. mapping 不是分群建議。沒有任何函式會去「猜」某個 Task 該對到哪個 Plan
//   2. 只有 verified 的 mapping 具備 migration authority；unresolved / rejected 沒有
//   3. 沒有 mapping 的 legacy Task 是**正常狀態**，不是錯誤。永遠留在 legacy 是被允許的結果
//
// 這個檔案不碰資料庫，全部是純函式。

// 允許的 provenance 類型。共同點：每一種都指得出一個**外部於這張表的可查證來源**。
//   ・source_record       —— 舊系統本身留下的歸屬紀錄
//   ・migration_manifest  —— 人工整理並複核過的對照檔
//   ・user_confirmed      —— 使用者本人在 App 裡逐筆確認
//   ・admin_verified      —— 營運人員依個案查證後認定
export const PROVENANCE_SOURCES = ['source_record', 'migration_manifest', 'user_confirmed', 'admin_verified'];

// 明確列出禁止的 provenance，而不是只靠上面的白名單擋。
//
// 白名單本來就夠擋，但擋下來的錯誤訊息會是「來源不正確」——看不出為什麼不正確。
// 有人日後想「先加一種 subject_match 試試」時，應該先撞到這份名單和它的理由，
// 而不是以為只要把字串加進白名單就行了。這些全部是 hard contract 禁止的推論：
//   ・inferred        —— 沒說是根據什麼推的，就是沒有來源
//   ・title_match     —— 舊的組合字串格式，不是 identity
//   ・date_cluster    —— 同一批建立不代表同一個計畫
//   ・created_at_cluster
//   ・subject_match   —— 一科可以有很多計畫，一個計畫也可以跨科
//   ・list_match
//   ・due_date_match  —— due_date 是排程鏡射，不是 deadline，也不是 Plan 邊界
//   ・material_match  —— 同一段教材可以出現在很多個 Plan 裡
export const FORBIDDEN_PROVENANCE_SOURCES = [
  'inferred', 'title_match', 'date_cluster', 'created_at_cluster',
  'subject_match', 'list_match', 'due_date_match', 'material_match', 'heuristic',
];

export const VERIFICATION_STATUSES = ['unresolved', 'verified', 'rejected'];

// migration authority 只有一個值。刻意寫成常數而不是散在各處的字串比較，
// 這樣「還有沒有別的狀態也能遷移」這個問題只有一個地方可以回答。
export const AUTHORITATIVE_STATUS = 'verified';

// HTTP 端點只接受這一種 provenance。
//
// 另外三種代表「系統／營運方查證過」，一個一般登入使用者不該能自己宣稱——
// 否則只要送一個 provenance_source: 'admin_verified' 就能自封權威，
// 整個 verification 就沒有意義了。它們必須由伺服器端的匯入流程寫入。
export const API_ALLOWED_PROVENANCE_SOURCES = ['user_confirmed'];

export function isAllowedProvenanceSource(source) {
  return PROVENANCE_SOURCES.includes(source);
}

// 一筆 mapping 是否具備 migration authority。
//
// 三個條件缺一不可，而且刻意不接受「狀態是 verified 就好」：
// 沒有 verified_at 或來源不合法的 verified 列，代表寫入路徑出過問題，
// 這種列不該被當成可以動 production 資料的依據。
export function hasMigrationAuthority(mapping) {
  if (!mapping) return false;
  if (mapping.verification_status !== AUTHORITATIVE_STATUS) return false;
  if (!isAllowedProvenanceSource(mapping.provenance_source)) return false;
  return !!mapping.verified_at;
}

const isPositiveInt = v => Number.isInteger(v) && v > 0;

// 建立 mapping 的輸入檢查。只看形狀，不看資料庫；擁有權與存在性由 route 查。
// 回傳錯誤訊息字串，沒問題回 null。
export function validateMappingInput(body, { allowedSources = PROVENANCE_SOURCES } = {}) {
  const b = body || {};
  if (!isPositiveInt(Number(b.legacy_task_id))) return '請指定要對應的舊任務';
  if (!isPositiveInt(Number(b.target_plan_id))) return '請指定要對應到哪一個計畫';
  const source = b.provenance_source;
  if (!source) return '請指定這筆對應的依據來源';
  if (FORBIDDEN_PROVENANCE_SOURCES.includes(source)) {
    return '不接受推論性的依據來源：對應必須來自可查證的紀錄或明確確認，不能用標題、日期或科目推測';
  }
  if (!isAllowedProvenanceSource(source)) return '依據來源不正確';
  if (!allowedSources.includes(source)) {
    return '這個依據來源只能由系統匯入流程寫入，不能由使用者自行宣稱';
  }
  if (b.provenance_ref != null && typeof b.provenance_ref !== 'string') return '依據參照格式不正確';
  if (b.verification_status != null && !VERIFICATION_STATUSES.includes(b.verification_status)) {
    return '確認狀態不正確';
  }
  return null;
}

// migration preview 的分類。
//
// 這裡最重要的一條：**unresolved 不是錯誤**。它是「還沒有人確認」，
// 而依照契約，永遠沒有人確認也是可接受的結局。所以四個桶子是平行的結果，
// 不是「成功 / 失敗」。
//
// tasks 傳進來的是「這位使用者所有 plan_id 為 NULL 的任務」加上「有 mapping 的任務」，
// 由呼叫端負責只撈自己的資料——這個函式不做 user boundary，它看不到 user。
export function classifyPreview({ tasks = [], plans = [], mappings = [] } = {}) {
  const taskById = new Map(tasks.map(t => [Number(t.id), t]));
  const planIds = new Set(plans.map(p => Number(p.id)));

  const buckets = {
    verified: [], unresolved: [], rejected: [], already_migrated: [], invalid_reference: [],
  };

  for (const m of mappings) {
    const task = taskById.get(Number(m.legacy_task_id));
    const row = {
      mapping_id: m.id,
      legacy_task_id: Number(m.legacy_task_id),
      target_plan_id: Number(m.target_plan_id),
      provenance_source: m.provenance_source,
      provenance_ref: m.provenance_ref ?? null,
      verification_status: m.verification_status,
      verified_at: m.verified_at ?? null,
      task_title: task?.title ?? null,
    };

    // 參照壞掉的優先分出來：任務不見了、被軟刪除了，或目標計畫不存在／不是本人的。
    // 這種列即使狀態是 verified 也不能拿來遷移，所以不能留在 verified 桶裡。
    if (!task) { buckets.invalid_reference.push({ ...row, reason: 'task_not_found' }); continue; }
    if (task.deleted) { buckets.invalid_reference.push({ ...row, reason: 'task_deleted' }); continue; }
    if (!planIds.has(Number(m.target_plan_id))) {
      buckets.invalid_reference.push({ ...row, reason: 'plan_not_found' });
      continue;
    }

    // 已經有 plan_id 就不是 legacy 了，不管 mapping 現在是什麼狀態。
    // 這個桶子是為了讓重跑 preview 時看得出「這筆已經處理完了」，不是錯誤。
    if (task.plan_id != null) {
      buckets.already_migrated.push({ ...row, current_plan_id: Number(task.plan_id) });
      continue;
    }

    if (m.verification_status === 'rejected') { buckets.rejected.push(row); continue; }
    if (hasMigrationAuthority(m)) { buckets.verified.push(row); continue; }
    buckets.unresolved.push(row);
  }

  // 完全沒有 mapping 的 legacy 任務。永久保持 legacy 是允許的結果，
  // 所以這裡只報數量與清單，不放進任何「待處理」的語意裡。
  const mapped = new Set(mappings.map(m => Number(m.legacy_task_id)));
  const unmappedLegacy = tasks
    .filter(t => t.plan_id == null && !t.deleted && !mapped.has(Number(t.id)))
    .map(t => ({ legacy_task_id: Number(t.id), task_title: t.title ?? null }));

  return {
    ...buckets,
    unmapped_legacy: unmappedLegacy,
    counts: {
      verified: buckets.verified.length,
      unresolved: buckets.unresolved.length,
      rejected: buckets.rejected.length,
      already_migrated: buckets.already_migrated.length,
      invalid_reference: buckets.invalid_reference.length,
      unmapped_legacy: unmappedLegacy.length,
    },
    // 只有 verified 桶裡的東西具備遷移資格。這個數字必須從 verified 導出，
    // 不可以另外估——一旦與判定脫鉤就是在猜。
    migratable_task_count: buckets.verified.length,
  };
}
