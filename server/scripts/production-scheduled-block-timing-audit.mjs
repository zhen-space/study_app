// Round 4 production audit：只讀。刻意不 import db/init.js，避免 initSchema()
// 在 audit 時觸發任何 schema 或 data repair。此檔案只發出一個 SELECT statement。
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error('缺少 TURSO_DATABASE_URL 或 TURSO_AUTH_TOKEN；未連線、未執行任何查詢。');
  process.exit(2);
}

const sql = `
WITH classified AS (
  SELECT
    b.id,
    b.user_id,
    b.schedule_version_id,
    CASE
      WHEN b.start_time IS NULL AND b.end_time IS NULL AND b.planned_minutes IS NULL THEN 'date_only'
      WHEN (b.start_time IS NOT NULL AND NOT (
              b.start_time GLOB '[0-2][0-9]:[0-5][0-9]'
              AND CAST(substr(b.start_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
              AND CAST(substr(b.start_time, 4, 2) AS INTEGER) BETWEEN 0 AND 59
            ))
        OR (b.end_time IS NOT NULL AND NOT (
              b.end_time GLOB '[0-2][0-9]:[0-5][0-9]'
              AND CAST(substr(b.end_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
              AND CAST(substr(b.end_time, 4, 2) AS INTEGER) BETWEEN 0 AND 59
            )) THEN 'malformed_time'
      WHEN b.start_time IS NOT NULL AND b.end_time IS NULL THEN 'class_a_half_timed'
      WHEN b.start_time IS NULL AND b.end_time IS NOT NULL THEN 'end_only'
      WHEN b.start_time >= b.end_time THEN 'invalid_reversed_window'
      WHEN b.planned_minutes IS NULL THEN 'class_b_timed_minutes_null'
      WHEN CAST(b.planned_minutes AS INTEGER) !=
           ((CAST(substr(b.end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(b.end_time, 4, 2) AS INTEGER)) -
            (CAST(substr(b.start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(b.start_time, 4, 2) AS INTEGER)))
        THEN 'minutes_mismatch'
      WHEN b.planned_minutes IS NOT NULL THEN 'canonical_timed'
      ELSE 'other_noncanonical'
    END AS timing_shape,
    CASE WHEN EXISTS (
      SELECT 1 FROM user_schedule_state uss
       WHERE uss.user_id = b.user_id
         AND uss.active_version_id = b.schedule_version_id
    ) THEN 'active' ELSE 'historical' END AS version_scope
  FROM scheduled_blocks b
),
census AS (
  SELECT 'timing_shape_census' AS report, timing_shape, 'all_versions' AS version_scope,
         COUNT(*) AS row_count, COUNT(DISTINCT user_id) AS affected_user_count
    FROM classified
   GROUP BY timing_shape
),
abnormal_scope AS (
  SELECT 'abnormal_by_version_scope' AS report, timing_shape, version_scope,
         COUNT(*) AS row_count, COUNT(DISTINCT user_id) AS affected_user_count
    FROM classified
   WHERE timing_shape NOT IN ('date_only', 'canonical_timed')
   GROUP BY timing_shape, version_scope
),
baselines AS (
  SELECT 'baseline' AS report, 'scheduled_blocks_total' AS timing_shape, 'all_versions' AS version_scope,
         COUNT(*) AS row_count, NULL AS affected_user_count FROM scheduled_blocks
  UNION ALL
  SELECT 'baseline', 'plan_tasks_total', 'all_versions', COUNT(*), COUNT(DISTINCT user_id)
    FROM tasks WHERE plan_id IS NOT NULL
  UNION ALL
  SELECT 'baseline', 'bootstrap_schedule_versions', 'all_versions', COUNT(*), COUNT(DISTINCT user_id)
    FROM schedule_versions WHERE source = 'bootstrap'
  UNION ALL
  SELECT 'affected_users', 'class_a_half_timed', 'all_versions', COUNT(*), COUNT(DISTINCT user_id)
    FROM classified WHERE timing_shape = 'class_a_half_timed'
  UNION ALL
  SELECT 'affected_users', 'invalid_timing_any', 'all_versions', COUNT(*), COUNT(DISTINCT user_id)
    FROM classified WHERE timing_shape IN ('end_only', 'invalid_reversed_window', 'malformed_time', 'other_noncanonical')
)
SELECT report, timing_shape, version_scope, row_count, affected_user_count FROM census
UNION ALL
SELECT report, timing_shape, version_scope, row_count, affected_user_count FROM abnormal_scope
UNION ALL
SELECT report, timing_shape, version_scope, row_count, affected_user_count FROM baselines
ORDER BY report, timing_shape, version_scope;
`;

const client = createClient({ url, authToken });
try {
  const result = await client.execute(sql);
  const rows = result.rows.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value == null ? null : String(value)])
  ));
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: 'production_read_only_timing_audit',
    rows,
  }, null, 2));
} finally {
  client.close();
}
