// Plan Archive 移除：production archived Plan 的嚴格唯讀 audit。
//
// 背景：封存功能已從產品移除。既有 archived 舊資料維持 read compatibility，前端
// 依 archived_from_status 投影回已完成／已結束：
//   ・archived_from_status='completed' → 歸入已完成
//   ・archived_from_status='ended'     → 歸入已結束
//   ・其他來源（active／paused／draft／NULL）→ **不自行猜成完成或結束**，落到「其他」
//
// 這支 script 只輸出「有多少 archived Plan、archived_from_status 的分布」，供人工
// 決定是否要對「其他」那些做後續處理。**絕不寫入任何資料**：只跑 SELECT，不 import
// db/init.js（避免觸發 schema migration／repair），不做 migration、不刪 schema、
// 不改狀態。去識別化：只輸出數量，不輸出任何 user_id、計畫名稱或內容。
//
// 用法（由使用者本人在可信環境對 production Turso 執行）：
//   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… node scripts/production-archived-plan-audit.mjs
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error('缺少 TURSO_DATABASE_URL 或 TURSO_AUTH_TOKEN；未連線、未執行任何查詢。');
  process.exit(2);
}

// 全部是 SELECT。COALESCE 把 NULL 的 archived_from_status 顯示成字面 '(null)'，
// 讓「無法歸類」的那一群在報表上看得到、算得出數量。
const sql = `
SELECT 'archived_total' AS report,
       COUNT(*) AS plan_count,
       NULL AS archived_from_status,
       NULL AS projected_category
  FROM plans WHERE status='archived'
UNION ALL
SELECT 'archived_by_source',
       COUNT(*),
       COALESCE(archived_from_status, '(null)'),
       CASE archived_from_status
         WHEN 'completed' THEN 'completed'
         WHEN 'ended' THEN 'ended'
         ELSE 'other'
       END
  FROM plans WHERE status='archived'
 GROUP BY COALESCE(archived_from_status, '(null)')
UNION ALL
-- 「其他」那一群的明細分布（仍只有數量與原狀態，無任何識別資訊）
SELECT 'archived_other_needs_review',
       COUNT(*),
       COALESCE(archived_from_status, '(null)'),
       'other'
  FROM plans
 WHERE status='archived'
   AND (archived_from_status IS NULL OR archived_from_status NOT IN ('completed','ended'))
 GROUP BY COALESCE(archived_from_status, '(null)')
 ORDER BY report, archived_from_status;
`;

const client = createClient({ url, authToken });
try {
  const result = await client.execute(sql);
  const rows = result.rows.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value == null ? null : String(value)])
  ));
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: 'production_read_only_archived_plan_audit',
    note: 'read-only；只輸出數量與 archived_from_status 分布；不 migration／不刪 schema／不改狀態',
    rows,
  }, null, 2));
} finally {
  client.close();
}
