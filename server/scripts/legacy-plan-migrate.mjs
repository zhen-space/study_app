// Legacy Task → Plan 的 migration runner。
//
// 它現在**沒有實作任何遷移**，而且即使拿到 approval 旗標也會拒絕退出。
// 這不是還沒寫完，是刻意的：
//
//   tasks 上唯一表示「屬於哪一個 Plan」的欄位就是 plan_id 本身，legacy 列是 NULL。
//   沒有任何其他欄位或關聯表記錄過舊任務的 Plan 歸屬。所以任何 runner 只能靠
//   created_at / title / list_id / due_date 去猜——而那四個都是 hard contract
//   明文禁止的推論來源。寫得出來的 runner，寫出來就是錯的。
//
// 要解除這個 gate，需要的是**新的、明確的 provenance**，不是放寬判定。
// 例如由人工確認後補上 legacy_plan_ref；plan-audit.js 的 planProvenance()
// 已經預留了讀它的位置。
//
// 現況與只讀 audit 的用法見 docs/legacy-migration.md。

const approved = process.env.LEGACY_MIGRATION_AUDIT_APPROVED === '1';

console.error([
  '已拒絕執行：Legacy Task → Plan migration 沒有實作，也不應該在目前條件下實作。',
  '',
  '原因：legacy 任務身上沒有任何可用的 Plan 歸屬證據。',
  '      plan_id 是唯一記錄歸屬的欄位，而它正是 NULL；',
  '      created_at / title / list_id / due_date 都是禁止的推論來源。',
  '',
  approved
    ? '注意：LEGACY_MIGRATION_AUDIT_APPROVED=1 已設定，但那只解除流程 gate，'
      + '\n      解除不了「資料裡沒有答案」這件事。仍然拒絕執行。'
    : '目前也沒有 approval（LEGACY_MIGRATION_AUDIT_APPROVED 未設為 1）。',
  '',
  '可以做的事：',
  '  1. 跑只讀 audit：node scripts/legacy-plan-audit.mjs',
  '  2. 用 App 裡的逐筆轉換：自己建立正式 Plan，再逐筆確認要加入哪些舊任務。',
].join('\n'));

process.exit(2);
