// 僅在 production read-only audit 證明沒有 duplicate live session 後，由 operator
// 明確執行。若發現任何重複資料，會拒絕寫入；絕不自動取消／結束舊 session。
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error('缺少 TURSO_DATABASE_URL 或 TURSO_AUTH_TOKEN；未連線、未修改資料庫。');
  process.exit(2);
}

const client = createClient({ url, authToken });
try {
  const duplicates = await client.execute(`SELECT user_id,COUNT(*) AS live_session_count
    FROM study_sessions WHERE status IN ('running','paused')
    GROUP BY user_id HAVING COUNT(*) > 1 ORDER BY user_id LIMIT 20`);
  if (duplicates.rows.length) {
    console.error(JSON.stringify({
      error: '發現重複的未結束讀書計時；未建立 index，也沒有修改任何資料。',
      duplicate_users: duplicates.rows,
    }, null, 2));
    process.exit(3);
  }
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_study_sessions_one_live ON study_sessions(user_id) WHERE status IN ('running','paused')");
  console.log(JSON.stringify({ ok: true, index: 'idx_study_sessions_one_live' }));
} finally {
  client.close();
}
