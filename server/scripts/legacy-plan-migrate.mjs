// 受 gate 保護的 migration runner。沒有 production audit approval 時明確拒絕，
// 避免把「一科＝一 Plan」placeholder 或 created_at 猜測寫進正式資料。
if (process.env.LEGACY_MIGRATION_AUDIT_APPROVED !== '1') {
  console.error('已拒絕執行：尚未取得正式 production legacy audit approval。請先跑 legacy-plan-audit.mjs 並完成審核。');
  process.exit(2);
}
console.error('已取得 gate，但自動 clustering 仍刻意未實作。請使用 UI 的逐筆轉換入口，或在核准後提供明確 migration mapping。');
process.exit(2);
