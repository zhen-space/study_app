// 僅在 production read-only audit 證明沒有 duplicate live session 後，由 operator
// 明確執行。若發現任何重複資料，會拒絕寫入；絕不自動取消／結束舊 session。
//
// initSchema() 現在也會做同樣的 preflight 並在安全時自動建立這條 index，所以正常
// 情況下不需要跑這支。它保留給「開機時因為有重複而被跳過、之後才把重複清乾淨」的
// 情境：可以立刻補上 index，不必等下一次部署。DDL 與 preflight 兩邊完全一致。
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
