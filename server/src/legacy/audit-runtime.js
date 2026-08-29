// Legacy Task → Plan audit 的執行期防線。
// 這個模組刻意不匯入資料庫 client；CLI 要先完成目標與憑證判定。

import { createHash, randomBytes } from 'node:crypto';
import { classify, isLegacyTask, parseTags, reviewGroups, STUDY_TAG } from './plan-audit.js';

const FORBIDDEN_SQL = /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|VACUUM|ATTACH|DETACH|PRAGMA)\b/i;

export class AuditSafetyError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// 只接受單一 SELECT／WITH ... SELECT。即使呼叫端日後被改壞，也不會把寫入送進 DB。
export function assertReadOnlyAuditSql(sql) {
  const text = String(sql || '').trim();
  if (!/^(?:SELECT|WITH)\b/i.test(text)
    || FORBIDDEN_SQL.test(text)
    || /(?:--|\/\*)/.test(text)
    || /;\s*.+/.test(text)) {
    throw new AuditSafetyError('readonly_query_rejected');
  }
  return text.replace(/;\s*$/, '');
}

export function createReadOnlyAuditQuery(execute) {
  if (typeof execute !== 'function') throw new TypeError('execute 必須是函式');
  return async (sql, args = []) => execute(assertReadOnlyAuditSql(sql), args);
}

export function resolveAuditTarget(env = process.env, { fileExists = () => true } = {}) {
  const url = String(env.TURSO_DATABASE_URL || '').trim();
  const token = String(env.TURSO_AUTH_TOKEN || '').trim();
  const dbFile = String(env.DB_FILE || '').trim();
  const localAllowed = String(env.LEGACY_AUDIT_ALLOW_LOCAL_COPY || '') === '1';
  // 任一 Turso 憑證出現時，只能走 production；絕不能退回 DB_FILE。
  if (url || token) {
    if (!url || !token) throw new AuditSafetyError('production_credentials_required');
    return { target_mode: 'production_turso', url, token, target_identifier: fingerprint(url) };
  }
  if (!dbFile) throw new AuditSafetyError('production_credentials_required');
  if (!localAllowed) throw new AuditSafetyError('local_copy_opt_in_required');
  if (!fileExists(dbFile)) throw new AuditSafetyError('local_copy_not_found');
  return { target_mode: 'local_copy', dbFile, target_identifier: fingerprint(dbFile) };
}

export function createAuditSalt() { return randomBytes(24).toString('base64url'); }
export function fingerprint(value) {
  return `audit-${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

export function publicAuditFailure(error, targetMode = 'unresolved') {
  const code = error instanceof AuditSafetyError ? error.code : 'audit_query_failed';
  const message = {
    production_credentials_required: 'production audit 需要完整 Turso 憑證。',
    local_copy_opt_in_required: '本機或備份 audit 必須明確設定 LEGACY_AUDIT_ALLOW_LOCAL_COPY=1。',
    local_copy_not_found: '指定的本機或備份資料庫不存在。',
    schema_mismatch: '資料庫 schema 不符合 audit 所需結構。',
    readonly_query_rejected: 'audit 拒絕非唯讀查詢。',
    audit_query_failed: 'audit 查詢失敗；詳細資訊未輸出。',
  }[code] || 'audit 無法安全執行。';
  return { mode: 'audit_only', target_mode: targetMode, fatal: code, message };
}

export function buildAuditReport({
  rows, tasksWithPlan = 0, blockRefs = new Map(), sessionRefs = new Map(), target,
  generatedAt = new Date().toISOString(), auditSalt = createAuditSalt(),
}) {
  const legacy = rows.filter(isLegacyTask);
  const summary = classify(legacy, { blockRefs, sessionRefs });
  const groups = reviewGroups(legacy, { blockRefs, sessionRefs, auditSalt });
  const users = new Set(legacy.map(t => t.user_id));
  const count = pred => legacy.filter(pred).length;
  const createdMonths = new Map();
  for (const item of legacy) {
    const month = String(item.created_at || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month)) createdMonths.set(month, (createdMonths.get(month) || 0) + 1);
  }
  return {
    generated_at: generatedAt,
    mode: 'audit_only', target_mode: target.target_mode, target_identifier: target.target_identifier,
    writes_performed: 0,
    warning: '這份報告只供人工審核。不得據此自動建立 Plan、attach Task 或推定 deadline。',
    totals: { tasks_without_plan: rows.length, tasks_with_plan: Number(tasksWithPlan || 0), legacy_tasks: summary.legacy_tasks, distinct_affected_users: summary.distinct_affected_users },
    legacy_identification: {
      with_study_plan_tag: count(t => parseTags(t.tags).includes(STUDY_TAG)),
      title_separator_without_study_plan_tag: count(t => String(t.title || '').includes('｜') && !parseTags(t.tags).includes(STUDY_TAG)),
    },
    lifecycle: summary.lifecycle,
    legacy_date_fields: { with_due_date: count(t => !!t.due_date), with_due_time: count(t => !!t.due_time), with_deadline_date: count(t => !!t.deadline_date) },
    created_at_observation: {
      populated: count(t => !!t.created_at), missing: count(t => !t.created_at),
      by_month: Object.fromEntries([...createdMonths.entries()].sort(([a], [b]) => a.localeCompare(b))),
      note: '僅供人工判讀；不得據此形成 migration cluster。',
    },
    history_references: { ...summary.history_references, scheduled_block_rows: [...blockRefs.values()].reduce((a, b) => a + b, 0), study_session_rows: [...sessionRefs.values()].reduce((a, b) => a + b, 0) },
    migratability: {
      deterministic: summary.deterministic, ambiguous: summary.ambiguous,
      projected_plans_to_create: summary.projected_plans_to_create, projected_tasks_to_attach: summary.projected_tasks_to_attach,
      reason: summary.deterministic === 0
        ? 'legacy 任務沒有可直接驗證的 Plan provenance；created_at、title、list_id 與 due_date 均不得用來推論。'
        : '存在非推論性 Plan provenance，仍需人工複核後才可 migration。',
    },
    identity_risks: {
      review_group_count: groups.length,
      cross_subject_users: [...users].filter(userId => new Set(legacy.filter(t => t.user_id === userId).map(t => t.list_id ?? 'none')).size > 1).length,
    },
    // user_ref 使用每次 audit 的隨機 salt，僅可在同一份報告內交叉對照。
    review_groups: groups,
  };
}
