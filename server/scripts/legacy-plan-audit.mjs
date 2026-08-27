// Legacy Task → Plan：**只讀** production audit。
//
// 這支不寫任何資料。它回答一個問題：production 裡還有多少舊任務沒有 Plan，
// 以及其中有多少「可以在不猜測的前提下」判定該屬於哪一個 Plan。
//
// 為什麼「不猜」這件事需要一支程式來證明：
//   tasks 上唯一表示「屬於哪個 Plan」的欄位就是 plan_id 本身，legacy 列它是 NULL。
//   沒有任何其他欄位或關聯表記錄過舊任務的 Plan 歸屬。剩下看起來像線索的東西——
//   created_at、title、list_id、due_date——全部是 hard contract 明文禁止的推論來源：
//     ・created_at 只說「同一批建立」，不說「同一個計畫」
//     ・title 的「｜」只是舊的組合字串格式，不是 identity
//     ・list_id 是科目分類，一科可以有很多計畫，一個計畫也可以跨科
//     ・due_date 是排程鏡射，不是 deadline
//   所以這支的 deterministic 判定刻意極保守：只有存在**非推論性**的 Plan 連結
//   才算 deterministic。實務上預期是 0——而把它算出來、寫下來，比嘴上說「不能猜」
//   更有用，因為它會在資料真的變了的時候自己改口。
//
// 用法（production 需要 Turso 憑證；憑證只放在執行環境，不進 repo）：
//   cd server
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/legacy-plan-audit.mjs
//
// 本機／備份檔：
//   DB_FILE=/path/to/copy.sqlite TURSO_DATABASE_URL= node scripts/legacy-plan-audit.mjs

import { q } from '../src/db/init.js';
import { isLegacyTask, classify, reviewGroups } from '../src/legacy/plan-audit.js';

// 這支刻意**不**呼叫 initSchema()：audit 是唯讀的，不該順手建表或補欄位。
// 欄位不存在時下面的 hasColumn 會處理，缺欄位本身也是一項要回報的發現。

async function hasColumn(table, column) {
  try {
    const cols = await q.all(`PRAGMA table_info(${table})`);
    return cols.some(c => c.name === column);
  } catch { return false; }
}

async function main() {
  const missingColumns = [];
  for (const col of ['plan_id', 'deleted', 'cancelled', 'deadline_date', 'material_content_item_id']) {
    if (!await hasColumn('tasks', col)) missingColumns.push(`tasks.${col}`);
  }
  if (missingColumns.length) {
    console.error(JSON.stringify({ mode: 'audit_only', fatal: 'schema_mismatch', missing_columns: missingColumns }, null, 2));
    process.exit(3);
  }

  // 全部 plan_id IS NULL 的任務都撈進來——**包含已刪除／已完成／已取消**。
  // 舊版把 deleted 直接在 SQL 濾掉，於是報告永遠說不出 lifecycle 分布，
  // 也看不見「已刪除但仍被 ScheduledBlock 參照」這種真正危險的案例。
  const rows = await q.all(`SELECT id,user_id,list_id,title,tags,due_date,due_time,deadline_date,
      completed,cancelled,deleted,plan_id,material_content_item_id,material_book_id
    FROM tasks WHERE plan_id IS NULL`);

  const legacy = rows.filter(isLegacyTask);

  // 有沒有排程／讀書歷史指著這些任務。這決定 migration 會不會動到歷史。
  const ids = legacy.map(t => t.id);
  const refBlocks = new Map();
  const refSessions = new Map();
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    if (!part.length) continue;
    const marks = part.map(() => '?').join(',');
    for (const r of await q.all(
      `SELECT task_id, COUNT(*) n FROM scheduled_blocks WHERE task_id IN (${marks}) GROUP BY task_id`, part)) {
      refBlocks.set(Number(r.task_id), Number(r.n));
    }
    for (const r of await q.all(
      `SELECT task_id, COUNT(*) n FROM study_sessions WHERE task_id IN (${marks}) GROUP BY task_id`, part)) {
      refSessions.set(Number(r.task_id), Number(r.n));
    }
  }

  const summary = classify(legacy, { blockRefs: refBlocks, sessionRefs: refSessions });
  const groups = reviewGroups(legacy, { blockRefs: refBlocks, sessionRefs: refSessions });
  const users = new Set(legacy.map(t => t.user_id));
  const count = pred => legacy.filter(pred).length;

  const report = {
    generated_at: new Date().toISOString(),
    mode: 'audit_only',
    writes_performed: 0,
    warning: '這份報告只供人工審核。不得據此自動建立 Plan、attach Task 或推定 deadline。',

    totals: {
      tasks_without_plan: rows.length,
      legacy_tasks: summary.legacy_tasks,
      distinct_affected_users: summary.distinct_affected_users,
    },
    lifecycle: summary.lifecycle,
    legacy_date_fields: {
      with_due_date: count(t => !!t.due_date),
      with_due_time: count(t => !!t.due_time),
      with_deadline_date: count(t => !!t.deadline_date),
    },
    history_references: {
      ...summary.history_references,
      scheduled_block_rows: [...refBlocks.values()].reduce((a, b) => a + b, 0),
      study_session_rows: [...refSessions.values()].reduce((a, b) => a + b, 0),
    },

    migratability: {
      deterministic: summary.deterministic,
      ambiguous: summary.ambiguous,
      projected_plans_to_create: summary.projected_plans_to_create,
      projected_tasks_to_attach: summary.projected_tasks_to_attach,
      reason: summary.deterministic === 0
        ? 'tasks 上唯一的 Plan 歸屬欄位是 plan_id，legacy 列為 NULL；沒有任何非推論性的 provenance 可用。'
          + ' created_at / title / list_id / due_date 皆為 hard contract 禁止的推論來源。'
        : '存在非推論性 Plan provenance，需人工複核後才可 migration。',
    },
    identity_risks: {
      // 只說明「人工要看幾份」，不是分群建議
      review_group_count: groups.length,
      cross_subject_users: [...users].filter(u =>
        new Set(legacy.filter(t => t.user_id === u).map(t => t.list_id ?? 'none')).size > 1).length,
    },

    review_groups: groups,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0)).catch(e => {
  console.error(JSON.stringify({ mode: 'audit_only', fatal: 'error', message: String(e?.message || e) }, null, 2));
  process.exit(1);
});
