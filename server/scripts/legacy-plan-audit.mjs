// Legacy Task → Plan 的嚴格唯讀 audit。
// production：需同時設定 TURSO_DATABASE_URL 與 TURSO_AUTH_TOKEN。
// 本機／備份副本：需 DB_FILE 與 LEGACY_AUDIT_ALLOW_LOCAL_COPY=1。

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  AuditSafetyError,
  buildAuditReport,
  createAuditSalt,
  createReadOnlyAuditQuery,
  publicAuditFailure,
  resolveAuditTarget,
} from '../src/legacy/audit-runtime.js';

const TASK_COLUMNS = `id,user_id,list_id,title,tags,due_date,due_time,deadline_date,
  completed,cancelled,deleted,plan_id,material_content_item_id,material_book_id,created_at`;

async function connect(target) {
  // 先完成 fail-closed target 判定才載入 client，杜絕共用 client fallback 到 data.sqlite。
  const { createClient } = await import('@libsql/client');
  if (target.target_mode === 'production_turso') {
    return createClient({ url: target.url, authToken: target.token });
  }
  return createClient({ url: pathToFileURL(target.dbFile).href });
}

async function collectReferences(query, table, ids) {
  const result = new Map();
  const CHUNK = 400;
  for (let index = 0; index < ids.length; index += CHUNK) {
    const part = ids.slice(index, index + CHUNK);
    const marks = part.map(() => '?').join(',');
    const rows = await query(
      `SELECT task_id, COUNT(*) n FROM ${table} WHERE task_id IN (${marks}) GROUP BY task_id`, part);
    for (const row of rows) result.set(Number(row.task_id), Number(row.n));
  }
  return result;
}

async function main() {
  let target;
  try {
    target = resolveAuditTarget(process.env, { fileExists: existsSync });
  } catch (error) {
    console.error(JSON.stringify(publicAuditFailure(error)));
    return 2;
  }

  let client;
  try {
    client = await connect(target);
    const query = createReadOnlyAuditQuery(async (sql, args) => {
      const response = await client.execute({ sql, args });
      return response.rows.map(row => Object.fromEntries(Object.entries(row)));
    });
    const tables = new Set((await query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'scheduled_blocks', 'study_sessions')",
    )).map(row => row.name));
    if (!tables.has('tasks')) throw new AuditSafetyError('schema_mismatch');

    const rows = await query(`SELECT ${TASK_COLUMNS} FROM tasks WHERE plan_id IS NULL`);
    const assigned = await query('SELECT COUNT(*) n FROM tasks WHERE plan_id IS NOT NULL');
    const legacyIds = rows.filter(row => {
      try { return JSON.parse(row.tags || '[]').includes('讀書計劃') || String(row.title || '').includes('｜'); }
      catch { return String(row.title || '').includes('｜'); }
    }).map(row => row.id);
    const blockRefs = tables.has('scheduled_blocks')
      ? await collectReferences(query, 'scheduled_blocks', legacyIds) : new Map();
    const sessionRefs = tables.has('study_sessions')
      ? await collectReferences(query, 'study_sessions', legacyIds) : new Map();

    console.log(JSON.stringify(buildAuditReport({
      rows, tasksWithPlan: assigned[0]?.n || 0, blockRefs, sessionRefs, target, auditSalt: createAuditSalt(),
    }), null, 2));
    return 0;
  } catch (error) {
    // 不輸出底層 libsql message：它可能攜帶 URL、query parameter 或憑證。
    console.error(JSON.stringify(publicAuditFailure(error, target.target_mode)));
    return error instanceof AuditSafetyError && error.code === 'schema_mismatch' ? 3 : 1;
  } finally {
    client?.close();
  }
}

process.exitCode = await main();
