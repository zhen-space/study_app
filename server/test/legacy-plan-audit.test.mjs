// Legacy Task → Plan audit。
//
// 這一支的重點幾乎全是**負向**的：舊資料看起來很像「同一組」，而 hard contract
// 明文禁止用 created_at、title、list_id、due_date 去推論 Plan 歸屬。
// 判定一旦被寫鬆，production 就會憑猜測建出一堆假的 Plan，而且不可逆。
//
// 合約：
//   ① 只有存在非推論性的 Plan provenance 才算 deterministic。
//   ② 同批建立、同科目、同標題格式、同日期——全部都**不算**證據。
//   ③ 沒有 deterministic 資料時，預估建立的 Plan 數必須是 0，不可另外估。
//   ④ lifecycle 分布要含已刪除／已取消，audit 不可把它們濾掉。
//   ⑤ 已刪除但仍被 ScheduledBlock / StudySession 參照的案例要被指出來。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLegacyTask, parseTags, planProvenance, isDeterministicallyMigratable,
  classify, reviewGroups, STUDY_TAG,
} from '../src/legacy/plan-audit.js';
import {
  AuditSafetyError,
  assertReadOnlyAuditSql,
  buildAuditReport,
  createReadOnlyAuditQuery,
  publicAuditFailure,
  resolveAuditTarget,
} from '../src/legacy/audit-runtime.js';

const task = (o = {}) => ({
  id: o.id ?? 1, user_id: o.user_id ?? 1, list_id: o.list_id ?? null,
  title: o.title ?? '物理｜新大滿貫｜單元1｜例題',
  tags: o.tags ?? JSON.stringify([STUDY_TAG]),
  plan_id: o.plan_id ?? null,
  due_date: o.due_date ?? null, due_time: o.due_time ?? null, deadline_date: o.deadline_date ?? null,
  completed: o.completed ?? 0, cancelled: o.cancelled ?? 0, deleted: o.deleted ?? 0,
  created_at: o.created_at ?? '2026-01-01T00:00:00Z',
  material_content_item_id: o.material_content_item_id ?? null,
  material_book_id: o.material_book_id ?? null,
  ...o,
});

/* ---------------- 辨識 ---------------- */

test('舊任務的辨識：標籤或標題格式，且必須還沒有 plan_id', () => {
  assert.equal(isLegacyTask(task()), true);
  assert.equal(isLegacyTask(task({ tags: '[]', title: '物理｜單元1' })), true, '標題有「｜」就算');
  assert.equal(isLegacyTask(task({ tags: JSON.stringify([STUDY_TAG]), title: '買參考書' })), true, '有標籤就算');
  assert.equal(isLegacyTask(task({ tags: '[]', title: '買參考書' })), false, '兩個都沒有就不是舊資料');
  assert.equal(isLegacyTask(task({ plan_id: 7 })), false, '已經屬於正式 Plan 的不是 legacy');
});

test('壞掉的 tags 欄位不會讓判定爆炸', () => {
  assert.deepEqual(parseTags('not json'), []);
  assert.deepEqual(parseTags(null), []);
  assert.deepEqual(parseTags('{"a":1}'), [], '不是陣列就當作沒有標籤');
  assert.equal(isLegacyTask(task({ tags: 'not json', title: '買參考書' })), false);
});

/* ---------------- 核心：不准猜 ---------------- */

test('同一批 created_at 不構成 Plan 歸屬證據', () => {
  const batch = [1, 2, 3].map(i => task({ id: i, created_at: '2026-03-01T10:00:00Z' }));
  for (const t of batch) assert.equal(isDeterministicallyMigratable(t), false);
  assert.equal(classify(batch).deterministic, 0);
});

test('同一個科目（list_id）不構成 Plan 歸屬證據', () => {
  const sameSubject = [1, 2, 3].map(i => task({ id: i, list_id: 5 }));
  assert.equal(classify(sameSubject).deterministic, 0, '一科可以有很多計畫，一個計畫也可以跨科');
});

test('標題格式與相似度不構成 Plan 歸屬證據', () => {
  const similar = [
    task({ id: 1, title: '物理｜新大滿貫｜單元1｜例題' }),
    task({ id: 2, title: '物理｜新大滿貫｜單元2｜例題' }),
    task({ id: 3, title: '物理｜新大滿貫｜單元3｜例題' }),
  ];
  assert.equal(classify(similar).deterministic, 0, '「｜」只是舊的字串格式，不是 identity');
});

test('due_date / deadline_date 不構成 Plan 歸屬證據，也不得被當成 hard deadline', () => {
  const dated = [
    task({ id: 1, due_date: '2026-04-01', due_time: '19:00' }),
    task({ id: 2, due_date: '2026-04-02', deadline_date: '2026-04-30' }),
  ];
  assert.equal(classify(dated).deterministic, 0);
  for (const t of dated) assert.equal(planProvenance(t), null);
});

test('教材連結說得出「哪一段內容」，說不出「哪一次計畫」', () => {
  const withMaterial = [
    task({ id: 1, material_content_item_id: 101, material_book_id: 9 }),
    task({ id: 2, material_content_item_id: 102, material_book_id: 9 }),
  ];
  assert.equal(classify(withMaterial).deterministic, 0,
    '同一段教材可以出現在很多個 Plan 裡，不構成 Plan identity');
});

test('把所有「看起來像一組」的訊號疊在一起，仍然不算 deterministic', () => {
  const looksLikeOnePlan = [1, 2, 3, 4].map(i => task({
    id: i, user_id: 1, list_id: 5,
    title: `物理｜新大滿貫｜單元${i}｜例題`,
    created_at: '2026-03-01T10:00:00Z',
    due_date: `2026-04-0${i}`,
    material_book_id: 9,
  }));
  const out = classify(looksLikeOnePlan);
  assert.equal(out.deterministic, 0, '四個禁止訊號同時成立，仍然不可以判定成同一個 Plan');
  assert.equal(out.ambiguous, 4);
  assert.equal(out.projected_plans_to_create, 0, '沒有 deterministic 資料就不該預估要建任何 Plan');
  assert.equal(out.projected_tasks_to_attach, 0);
});

test('只有明確的 provenance 欄位才算數（目前 schema 沒有，保留給未來）', () => {
  const explicit = task({ id: 1, legacy_plan_ref: 'plan-42' });
  assert.deepEqual(planProvenance(explicit), { kind: 'explicit_ref', value: 'plan-42' });
  assert.equal(isDeterministicallyMigratable(explicit), true);
  assert.equal(planProvenance(task({ legacy_plan_ref: '' })), null, '空字串不算證據');
  assert.equal(planProvenance(task({ legacy_plan_ref: null })), null);
});

/* ---------------- lifecycle 與歷史參照 ---------------- */

test('lifecycle 分布含已刪除與已取消——audit 不可以把它們濾掉', () => {
  const mixed = [
    task({ id: 1 }),
    task({ id: 2, completed: 1 }),
    task({ id: 3, cancelled: 1 }),
    task({ id: 4, deleted: 1 }),
    task({ id: 5, deleted: 1, completed: 1 }),   // 刪除優先
  ];
  assert.deepEqual(classify(mixed).lifecycle, { active: 1, completed: 1, cancelled: 1, deleted: 2 });
  assert.equal(classify(mixed).legacy_tasks, 5, '已刪除的仍要計入總數，否則報告會低估');
});

test('指出已刪除但仍被排程／讀書歷史參照的任務', () => {
  const rows = [task({ id: 1 }), task({ id: 2, deleted: 1 }), task({ id: 3, deleted: 1 })];
  const out = classify(rows, {
    blockRefs: new Map([[1, 2], [2, 1]]),
    sessionRefs: new Map([[3, 4]]),
  });
  assert.equal(out.history_references.tasks_with_scheduled_block, 2);
  assert.equal(out.history_references.tasks_with_study_session, 1);
  assert.equal(out.history_references.deleted_tasks_still_referenced, 2,
    '刪掉卻還被歷史指著的，是 migration 最容易弄壞歷史的地方');
});

test('影響人數是去重後的使用者數', () => {
  const rows = [
    task({ id: 1, user_id: 1 }), task({ id: 2, user_id: 1 }),
    task({ id: 3, user_id: 2 }), task({ id: 4, user_id: 3 }),
  ];
  assert.equal(classify(rows).distinct_affected_users, 3);
});

/* ---------------- 人工審核分組 ---------------- */

test('review group 只是給人看的清單，不跨使用者、不跨科目合併', () => {
  const rows = [
    task({ id: 1, user_id: 1, list_id: 5 }),
    task({ id: 2, user_id: 1, list_id: 5 }),
    task({ id: 3, user_id: 1, list_id: 6 }),
    task({ id: 4, user_id: 2, list_id: 5 }),
  ];
  const groups = reviewGroups(rows, { auditSalt: '固定的測試 salt' });
  assert.equal(groups.length, 3, 'user × 科目各自一組，不合併');
  assert.equal(groups[0].tasks, 2);
  assert.equal(new Set(groups.map(g => g.user_ref)).size, 2, '同一使用者跨科仍可在同份報告交叉對照');
  assert.ok(groups.every(g => !Object.hasOwn(g, 'user_id') && !Object.hasOwn(g, 'sample_titles')),
    '預設報告不得保留原始 user_id 或任務標題');
});

test('沒有 legacy 資料時一切都是 0，而且不會炸', () => {
  const out = classify([]);
  assert.equal(out.legacy_tasks, 0);
  assert.equal(out.deterministic, 0);
  assert.equal(out.ambiguous, 0);
  assert.equal(out.projected_plans_to_create, 0);
  assert.deepEqual(reviewGroups([]), []);
});

test('已經有 plan_id 的任務完全不進入 audit', () => {
  const rows = [task({ id: 1, plan_id: 7 }), task({ id: 2, plan_id: 8 }), task({ id: 3 })];
  const out = classify(rows);
  assert.equal(out.legacy_tasks, 1, '正式 Plan 的任務不是 migration 對象');
  assert.equal(reviewGroups(rows).reduce((n, g) => n + g.tasks, 0), 1);
});

/* ---------------- Gate：runner 必須拒絕執行 ---------------- */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const runScript = (file, env = {}) => spawnSync(process.execPath, [path.join('scripts', file)],
  { cwd: serverDir, env: { ...process.env, ...env }, encoding: 'utf8' });

test('migration runner 沒有 approval 時拒絕執行', () => {
  const r = runScript('legacy-plan-migrate.mjs', { LEGACY_MIGRATION_AUDIT_APPROVED: '' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /已拒絕執行/);
});

// 這條是重點：approval 只解除流程 gate，解除不了「資料裡沒有答案」。
// 若哪天有人為了收尾把 runner 打開，這支測試會先紅。
test('migration runner 即使拿到 approval 也拒絕執行', () => {
  const r = runScript('legacy-plan-migrate.mjs', { LEGACY_MIGRATION_AUDIT_APPROVED: '1' });
  assert.equal(r.status, 2, 'approval 不得讓 runner 真的跑起來');
  assert.match(r.stderr, /已拒絕執行/);
});

test('audit runner 不匯入共用 DB client，且不含任何寫入 API', () => {
  for (const f of ['legacy-plan-audit.mjs', 'legacy-plan-migrate.mjs']) {
    const src = readFileSync(path.join(serverDir, 'scripts', f), 'utf8');
    // 去掉註解再檢查，否則「刻意不呼叫 initSchema」這種說明會被誤判
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    for (const bad of ['q.run(', 'q.tx(', 'q.batch(', 'initSchema(']) {
      assert.ok(!code.includes(bad), `${f} 不該出現寫入語句：${bad}`);
    }
  }
  const auditCode = readFileSync(path.join(serverDir, 'scripts', 'legacy-plan-audit.mjs'), 'utf8');
  assert.ok(!auditCode.includes("../src/db/init.js"), 'audit 不得匯入會 fallback 的共用 DB client');
});

test('target resolver fail closed，不會將 production audit 退回本機 DB', () => {
  const present = () => true;
  for (const env of [{}, { TURSO_DATABASE_URL: 'libsql://only-url' }, { TURSO_AUTH_TOKEN: 'only-token' }]) {
    assert.throws(() => resolveAuditTarget(env, { fileExists: present }), AuditSafetyError);
  }
  assert.throws(() => resolveAuditTarget({ DB_FILE: '/backup.sqlite' }, { fileExists: present }),
    error => error.code === 'local_copy_opt_in_required');
  const local = resolveAuditTarget({ DB_FILE: '/backup.sqlite', LEGACY_AUDIT_ALLOW_LOCAL_COPY: '1' }, { fileExists: present });
  assert.equal(local.target_mode, 'local_copy');
  const production = resolveAuditTarget({
    TURSO_DATABASE_URL: 'libsql://private.example?secret=not-for-output', TURSO_AUTH_TOKEN: 'fake-token', DB_FILE: '/backup.sqlite', LEGACY_AUDIT_ALLOW_LOCAL_COPY: '1',
  }, { fileExists: present });
  assert.equal(production.target_mode, 'production_turso', '完整 Turso 憑證優先，絕不 fallback');
  assert.ok(!production.target_identifier.includes('private.example'));
});

test('窄唯讀 query 介面拒絕所有寫入與寫入型 PRAGMA', async () => {
  const executed = [];
  const query = createReadOnlyAuditQuery(async sql => { executed.push(sql); return []; });
  await query('SELECT 1');
  await query('WITH x AS (SELECT 1) SELECT * FROM x');
  const mutations = [
    'CREATE TABLE x (id)', 'ALTER TABLE x ADD COLUMN a', 'DROP TABLE x', 'INSERT INTO x VALUES (1)',
    'UPDATE x SET a=1', 'DELETE FROM x', 'REPLACE INTO x VALUES (1)', 'VACUUM', 'ATTACH DATABASE x AS y',
    'DETACH DATABASE y', 'PRAGMA user_version=1', 'PRAGMA journal_mode=WAL',
  ];
  for (const sql of mutations) assert.throws(() => assertReadOnlyAuditSql(sql), AuditSafetyError, sql);
  assert.deepEqual(executed, ['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x']);
});

test('sanitized 報告不輸出 fixture 的 raw user、Task title、URL 或 token', () => {
  const rawUser = 'user-raw-777';
  const rawTitle = '絕對不可外洩的任務標題';
  const rawUrl = 'libsql://private.example?secret=url-secret';
  const rawToken = 'token-secret-123';
  const report = buildAuditReport({
    rows: [task({ user_id: rawUser, title: rawTitle, tags: JSON.stringify([STUDY_TAG]) })],
    target: { target_mode: 'production_turso', target_identifier: 'audit-safe-ref', url: rawUrl, token: rawToken },
    generatedAt: '2026-01-01T00:00:00.000Z', auditSalt: 'private-audit-salt',
  });
  const printed = JSON.stringify(report);
  for (const secret of [rawUser, rawTitle, rawUrl, rawToken, 'private-audit-salt']) {
    assert.ok(!printed.includes(secret), `報告不得輸出 ${secret}`);
  }
  assert.match(report.review_groups[0].user_ref, /^user-[0-9a-f]{12}$/);
});

test('公開錯誤不洩漏底層 URL 或 token', () => {
  const error = new Error('failed libsql://private.example?token=super-secret auth=super-secret');
  const printed = JSON.stringify(publicAuditFailure(error, 'production_turso'));
  assert.ok(!printed.includes('private.example'));
  assert.ok(!printed.includes('super-secret'));
  assert.equal(JSON.parse(printed).fatal, 'audit_query_failed');
});

async function withAuditDatabase(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'study-app-audit-'));
  const file = path.join(dir, 'audit.sqlite');
  const client = createClient({ url: `file:${file}` });
  try {
    await client.executeMultiple(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY, user_id TEXT, list_id INTEGER, title TEXT, tags TEXT,
        due_date TEXT, due_time TEXT, deadline_date TEXT, completed INTEGER, cancelled INTEGER,
        deleted INTEGER, plan_id INTEGER, material_content_item_id INTEGER, material_book_id INTEGER, created_at TEXT
      );
      CREATE TABLE scheduled_blocks (task_id INTEGER);
      CREATE TABLE study_sessions (task_id INTEGER);
      INSERT INTO tasks VALUES (1, 'fixture-user-991', 2, 'fixture private title', '["讀書計劃"]', NULL, NULL, NULL, 0, 0, 0, NULL, NULL, NULL, '2026-01-02T00:00:00Z');
      INSERT INTO tasks VALUES (2, 'fixture-user-991', 2, '正式任務', '[]', NULL, NULL, NULL, 0, 0, 0, 8, NULL, NULL, '2026-01-02T00:00:00Z');
    `);
    return await run({ file, client });
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false, '測試結束後不得留下 sqlite 或 audit 產物');
  }
}

test('audit 只有明確 local opt-in 才可對一次性備份副本執行，且輸出已去敏感化', async () => {
  await withAuditDatabase(async ({ file, client }) => {
    const beforeSchema = await client.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
    const beforeRows = await client.execute('SELECT id, user_id, title, plan_id FROM tasks ORDER BY id');
    const r = runScript('legacy-plan-audit.mjs', {
      DB_FILE: file, LEGACY_AUDIT_ALLOW_LOCAL_COPY: '1', TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.target_mode, 'local_copy');
    assert.equal(out.writes_performed, 0);
    assert.equal(out.totals.tasks_with_plan, 1);
    assert.ok(!r.stdout.includes('fixture-user-991'));
    assert.ok(!r.stdout.includes('fixture private title'));
    const afterSchema = await client.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
    const afterRows = await client.execute('SELECT id, user_id, title, plan_id FROM tasks ORDER BY id');
    assert.deepEqual(afterSchema.rows, beforeSchema.rows, 'audit 前後 schema／index 狀態必須一致');
    assert.deepEqual(afterRows.rows, beforeRows.rows, 'audit 前後資料必須完全一致');
  });
});

test('audit 缺少 credentials 時非零退出，且不建立或使用 repo data.sqlite', () => {
  const r = runScript('legacy-plan-audit.mjs', { TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', DB_FILE: '', LEGACY_AUDIT_ALLOW_LOCAL_COPY: '' });
  assert.equal(r.status, 2);
  const out = JSON.parse(r.stderr);
  assert.equal(out.fatal, 'production_credentials_required');
  assert.equal(out.target_mode, 'unresolved');
});
