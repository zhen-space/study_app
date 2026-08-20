// Phase 1 StudySession live uniqueness：production 唯讀 audit。
// 刻意不 import db/init.js，避免 audit 時執行任何 schema migration／repair。
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error('缺少 TURSO_DATABASE_URL 或 TURSO_AUTH_TOKEN；未連線、未執行任何查詢。');
  process.exit(2);
}

const sql = `
WITH live AS (
  SELECT user_id, id, status, started_at, running_since
    FROM study_sessions
   WHERE status IN ('running','paused')
), duplicate_users AS (
  SELECT user_id, COUNT(*) AS live_session_count
    FROM live
   GROUP BY user_id
  HAVING COUNT(*) > 1
), index_state AS (
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_study_sessions_one_live'
  ) THEN 1 ELSE 0 END AS index_present
)
SELECT 'live_sessions_total' AS report, COUNT(*) AS row_count, COUNT(DISTINCT user_id) AS user_count, NULL AS detail
  FROM live
UNION ALL
SELECT 'duplicate_live_users', COUNT(*), COUNT(*), NULL FROM duplicate_users
UNION ALL
SELECT 'duplicate_live_rows', COALESCE(SUM(live_session_count), 0), COUNT(*), NULL FROM duplicate_users
UNION ALL
SELECT 'live_unique_index_present', index_present, NULL, NULL FROM index_state
UNION ALL
SELECT 'duplicate_live_user_sample', live_session_count, 1, CAST(user_id AS TEXT)
  FROM duplicate_users
 ORDER BY report, detail;
`;

const client = createClient({ url, authToken });
try {
  const result = await client.execute(sql);
  const rows = result.rows.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value == null ? null : String(value)])
  ));
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: 'production_read_only_study_session_live_audit', rows,
  }, null, 2));
} finally {
  client.close();
}
