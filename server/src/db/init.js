import { createClient } from '@libsql/client';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 有設定 Turso 就用雲端（永久保存）；否則用本機檔案（開發用）
const client = process.env.TURSO_DATABASE_URL
  ? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  // DB_FILE 讓測試指到暫存檔，不會動到開發／正式資料庫
  : createClient({ url: 'file:' + (process.env.DB_FILE || path.join(__dirname, '..', '..', 'data.sqlite')) });

const toObj = (row, columns) => Object.fromEntries(columns.map((c, i) => [c, row[i]]));

export const q = {
  async all(sql, args = []) {
    const r = await client.execute({ sql, args });
    return r.rows.map(row => toObj(row, r.columns));
  },
  async get(sql, args = []) {
    const r = await client.execute({ sql, args });
    return r.rows[0] ? toObj(r.rows[0], r.columns) : undefined;
  },
  async run(sql, args = []) {
    const r = await client.execute({ sql, args });
    return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
  },
  // 一批語句一個網路來回（大量寫入用，遠端 Turso 差很多）
  async batch(stmts) {
    if (stmts.length) await client.batch(stmts.map(s => ({ sql: s[0], args: s[1] || [] })), 'write');
  },
  // 真正的互動式交易：中途讀得到上一句的結果（lastInsertRowid、rowsAffected）。
  //
  // batch() 雖然也是單一交易，但它把整批語句一次送出，拿不到中間結果——
  // 「先寫 version、再用它的 id 寫一堆 block」這種相依寫入用 batch 做不到。
  // 2C 的 ScheduleVersion 建立就是這種情況，所以需要這一支。
  //
  // fn 丟出任何例外都會 rollback，呼叫端拿到原本的例外。
  async tx(fn) {
    const t = await client.transaction('write');
    try {
      const out = await fn({
        async all(sql, args = []) {
          const r = await t.execute({ sql, args });
          return r.rows.map(row => toObj(row, r.columns));
        },
        async get(sql, args = []) {
          const r = await t.execute({ sql, args });
          return r.rows[0] ? toObj(r.rows[0], r.columns) : undefined;
        },
        async run(sql, args = []) {
          const r = await t.execute({ sql, args });
          return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
        },
      });
      await t.commit();
      return out;
    } catch (e) {
      try { await t.rollback(); } catch {}
      throw e;
    }
  },
};

// Round-3 schema-integrity repair。這不是 legacy Task → Plan clustering migration：
// 不讀／不寫 tasks.plan_id，只把既有 ScheduledBlock 收斂成既定的兩種 timing
// shape。可重跑：valid timed row 每次都導出相同分鐘數；不完整／不合法 row 一律
// demote 為 date-only，絕不憑空補一段 duration。
export async function repairScheduledBlockTiming() {
  const valid = `start_time IS NOT NULL AND end_time IS NOT NULL
    AND start_time GLOB '[0-2][0-9]:[0-5][0-9]'
    AND end_time GLOB '[0-2][0-9]:[0-5][0-9]'
    AND CAST(substr(start_time,1,2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(end_time,1,2) AS INTEGER) BETWEEN 0 AND 23
    AND end_time > start_time`;
  const duration = `(CAST(substr(end_time,1,2) AS INTEGER) * 60 + CAST(substr(end_time,4,2) AS INTEGER)
    - CAST(substr(start_time,1,2) AS INTEGER) * 60 - CAST(substr(start_time,4,2) AS INTEGER))`;
  return q.tx(async tx => {
    // Class B（或舊的錯誤分鐘數）：duration 只從可驗證的 window 導出，不累加。
    const backfilled = await tx.run(`UPDATE scheduled_blocks SET planned_minutes=${duration}
      WHERE ${valid} AND (planned_minutes IS NULL OR planned_minutes<>${duration})`);
    // Class A、反向／零長度與 malformed times 都沒有可信 duration，保守降級。
    const demoted = await tx.run(`UPDATE scheduled_blocks
      SET start_time=NULL, end_time=NULL, planned_minutes=NULL
      WHERE (start_time IS NOT NULL OR end_time IS NOT NULL) AND NOT (${valid})`);
    return { backfilled: backfilled.changes || 0, demoted: demoted.changes || 0 };
  });
}

// live StudySession 的 partial unique index。
//
// 這條 index 原本只由 operator script 手動建立，理由是：若資料庫裡已經有重複的
// running／paused rows，SQLite 會拒絕建 index，而 `try { … } catch {}` 會把這個
// 失敗吞掉，讓「以為有防線、其實沒有」變成靜默狀態。
//
// 但只靠 operator script 的代價是每個環境各自 opt-in：production 有、dev／staging／
// 新環境沒有。所以這裡改成「先 preflight 再建立」——保留原本不藏問題的性質，
// 同時讓安全的環境自動拿到防線：
//   ・有重複 → 完全不動資料庫，回報 blocked 並印出訊息，絕不自動取消／結束舊 session
//   ・沒有重複 → 建立 index（IF NOT EXISTS，已有的環境是 no-op）
export async function ensureStudySessionLiveIndex() {
  const LIVE = "status IN ('running','paused')";
  let duplicates;
  try {
    const rs = await client.execute(`SELECT user_id, COUNT(*) AS live_session_count
      FROM study_sessions WHERE ${LIVE}
      GROUP BY user_id HAVING COUNT(*) > 1 ORDER BY user_id LIMIT 20`);
    duplicates = rs.rows;
  } catch (e) {
    return { status: 'error', error: String(e?.message || e) };
  }
  if (duplicates.length) {
    console.warn('[schema] 發現重複的未結束讀書計時，未建立 idx_study_sessions_one_live；'
      + `影響 ${duplicates.length} 位使用者（最多列 20 筆）。未修改任何資料。`);
    return { status: 'blocked', duplicate_users: duplicates.length };
  }
  try {
    await client.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_study_sessions_one_live ON study_sessions(user_id) WHERE ${LIVE}`);
    return { status: 'ok' };
  } catch (e) {
    console.warn('[schema] 建立 idx_study_sessions_one_live 失敗：', e?.message || e);
    return { status: 'error', error: String(e?.message || e) };
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  sleep_start TEXT DEFAULT '23:00',
  sleep_end TEXT DEFAULT '07:00',
  meal_windows TEXT DEFAULT '[["07:30","08:00"],["12:00","12:30"],["18:00","18:30"]]',
  coins INTEGER DEFAULT 0,
  coins_total INTEGER DEFAULT 0,
  pet TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS fixed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  recurring TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#0086CC',
  order_index INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  list_id INTEGER,
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  due_date TEXT,
  due_time TEXT,
  priority INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  subtasks TEXT DEFAULT '[]',
  recurring TEXT,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  cancelled INTEGER DEFAULT 0,
  cancelled_at TEXT,
  order_index INTEGER DEFAULT 0,
  estimated_minutes INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '⭐',
  color TEXT DEFAULT '#16a34a',
  days TEXT DEFAULT '[0,1,2,3,4,5,6]'
);
CREATE TABLE IF NOT EXISTS habit_checkins (
  habit_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  PRIMARY KEY (habit_id, date)
);
CREATE TABLE IF NOT EXISTS pomo_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER,
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  rule TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS toc_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  list_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  level TEXT DEFAULT '章',
  sections TEXT DEFAULT '[]',
  order_index INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS coin_awards (
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  ref_key TEXT NOT NULL DEFAULT '',
  coins INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref_id, ref_key)
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT DEFAULT '',
  data TEXT NOT NULL,
  created_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS vocab_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  english TEXT NOT NULL,
  chinese TEXT DEFAULT '',
  kind TEXT DEFAULT '單字'
);
CREATE TABLE IF NOT EXISTS memos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  category TEXT DEFAULT '',
  content TEXT NOT NULL,
  color TEXT DEFAULT '',
  done INTEGER DEFAULT 0,
  order_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memo_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  order_index INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS list_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL
);

-- ↓ Phase 2A：正式 Plan domain。契約見 docs/phase2-plan-domain.md
-- Plan＝有目標、範圍、期限與生命週期的工作單位。跟 lists（科目分類）是兩回事：
-- 一個科目可以有多個 Plan，一個 Plan 也可以跨科目。
-- 進度不存在這裡（會不同步），一律從底下的 tasks 推導。
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  goal_id INTEGER,
  primary_list_id INTEGER,          -- 只是主要分類／顯示用，不代表 Plan 的身分
  start_date TEXT,
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | active | paused | completed | ended | archived
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | ai | legacy_migration | import
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  paused_at TEXT,
  ended_at TEXT,
  end_reason TEXT,
  archived_at TEXT,
  archived_from_status TEXT
);
-- Master Plan H：Goal 是 Plan 的可選上層目標，不取代 Plan。
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  target_date TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Master Plan C：AI 只產生並讓使用者確認 structured intent；原文與未支援項目
-- 可保留，但排程器只會收到明確標成 supported 的欄位。
CREATE TABLE IF NOT EXISTS plan_constraints (
  plan_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  intent_json TEXT NOT NULL DEFAULT '{}',
  unsupported_json TEXT NOT NULL DEFAULT '[]',
  source_text TEXT DEFAULT '',
  confirmed_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS plan_schedule_profiles (
  plan_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- ↓ 以下三張表 Phase 2A 只建不寫。排程持久化是 Phase 2C；
-- 先建好是為了避免之後又動一次 schema。
-- 注意：version 屬於「使用者的排程」而不是某一個 Plan——同一天可能同時在排
-- 好幾個 Plan，掛在單一 Plan 上跨 Plan 協調會立刻出問題。
CREATE TABLE IF NOT EXISTS schedule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  parent_version_id INTEGER,
  reason TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'initial',  -- initial | ai_replan | restore | manual
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- block 只認 task；要知道屬於哪個 Plan 就 task_id → tasks.plan_id。
-- 不在這裡放 plan_id，否則 task 改了 Plan 之後這裡會留著舊的。
CREATE TABLE IF NOT EXISTS scheduled_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  schedule_version_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  planned_minutes INTEGER
);
-- active version 的唯一來源。不做 MAX(version_no) 之類的 fallback 推導——
-- restore 之後最大號不等於現在生效的那一版，推導會直接錯。
-- active_version_id 為 NULL ＝ 這個使用者還沒進入 2C persistence，讀取端走 legacy。
CREATE TABLE IF NOT EXISTS user_schedule_state (
  user_id INTEGER PRIMARY KEY,
  active_version_id INTEGER,
  last_replan_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- 鎖是硬約束：排程引擎與 AI 永遠不得自動刪除或繞過。
-- time/day 鎖限制的是整體排程，不屬於任何 Plan。
CREATE TABLE IF NOT EXISTS schedule_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,               -- task | time | day
  task_id INTEGER,
  date TEXT,
  start_time TEXT,
  end_time TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Master Plan B：可重用作息／固定時間；不取代舊 fixed_events，而是逐步映射。
CREATE TABLE IF NOT EXISTS availability_routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- class | fixed_event | sleep | meal | availability
  title TEXT DEFAULT '',
  weekdays TEXT DEFAULT '[]',
  start_time TEXT,
  end_time TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS routine_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  routine_id INTEGER,
  date TEXT NOT NULL,
  kind TEXT NOT NULL, -- unavailable | available | cancel
  title TEXT DEFAULT '',
  start_time TEXT,
  end_time TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Master Plan F：實際讀書紀錄。排程 block 是不可變的「原定安排」，
-- 實際花多久則只寫在這裡，透過 task_id 間接歸屬 Plan。
CREATE TABLE IF NOT EXISTS study_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  scheduled_block_id INTEGER,
  task_title_snapshot TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  actual_minutes INTEGER DEFAULT 0,
  running_since TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running | paused | completed | cancelled
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | scheduled_block | pomo（僅保留舊歷史）
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Google Calendar（v1：單向唯讀）。
-- 只存「怎麼跟 Google 要資料」所需的憑證，不鏡射任何事件。
-- 沒有 google_calendar_events / google_busy_events：忙碌時段每次排程當下去問，
-- 不落地就不會有「資料庫那份過期了」的問題，也少一份可外洩的行程資料。
-- token 一律是 AES-256-GCM 密文；encryption_version 留給將來換金鑰用。
CREATE TABLE IF NOT EXISTS google_calendar_connections (
  user_id INTEGER PRIMARY KEY,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT NOT NULL,
  access_token_expires_at TEXT,
  scope TEXT NOT NULL,
  token_type TEXT,
  encryption_version INTEGER NOT NULL DEFAULT 1,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error_code TEXT
);

-- ===== Material domain =====================================================
-- 教材是「長期存在的東西」，Plan 是「這一次要做的事」。兩者刻意分開：
--   ・完成度的最小單位永遠是 ContentItem，而且是跨 Plan 的全域長期狀態
--   ・Chapter / Section / Topic 的完成度一律 derived，不另外保存
--   ・Plan 選取（plan_material_items）與教材進度（material_progress）互不寫入對方
--   ・排程仍然只認 Task：ScheduledBlock / ScheduleVersion 完全沒有 material 欄位
-- 契約見 docs/material-domain.md。

CREATE TABLE IF NOT EXISTS material_books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT DEFAULT '',
  subject_list_id INTEGER,               -- 顯示用的主要科目，不是書的身分
  source TEXT NOT NULL DEFAULT 'manual', -- manual | ocr_import | import
  -- 刪除的正常語意是封存。只有完全沒有任何 reference 的書才允許 hard delete。
  archived INTEGER DEFAULT 0,
  archived_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 章 / 節 / 主題共用一張表的自我參照樹。層級由 kind 表示，不用不同表，
-- 因為「節底下可以有主題、也可以沒有」這件事不該逼出兩套查詢。
CREATE TABLE IF NOT EXISTS material_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  book_id INTEGER NOT NULL,
  parent_id INTEGER,                     -- NULL = 直接掛在書底下（章）
  kind TEXT NOT NULL,                    -- chapter | section | topic
  title TEXT NOT NULL,
  order_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 完成度的最小單位。單元練習／歷屆試題直接掛在「章」底下，
-- 不得為了讓它有 parent 而捏造一個假的「節」。
CREATE TABLE IF NOT EXISTS material_content_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  book_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,              -- 可以是 chapter、section 或 topic
  kind TEXT NOT NULL,                    -- reading | example | unit_exercise | past_exam
  title TEXT NOT NULL,
  estimated_minutes INTEGER,
  order_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 跨 Plan 的全域教材進度。一個 ContentItem 一位使用者最多一列。
-- 沒有列 = 尚未完成；不需要為了「未完成」而預先寫滿整本書。
CREATE TABLE IF NOT EXISTS material_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content_item_id INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | task
  source_task_id INTEGER,                -- 由 Task 完成時的來源，僅 provenance
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 分類只 reference 書，不複製書。同一本書可以同時屬於多個分類。
CREATE TABLE IF NOT EXISTS material_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  order_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS material_category_books (
  user_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  book_id INTEGER NOT NULL,
  order_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (category_id, book_id)
);

-- 正式化來源：Formal Material Book ← 實際來源資料列。
--
-- 為什麼是一張表而不是 material_books 上的兩個欄位：
-- 書名是文字，會重複、會改，拿它當長期 linkage 就是 title matching 的變形。
-- 這裡直接記「這本正式教材是由哪幾列 toc_items 正式化來的」，
-- 一本書通常有多個章 row，所以是 1 對多。
--
-- source_row_id 上的 unique index 讓每一列 legacy 都能 deterministic 回答
-- 「我被正式化過了嗎」，unified library 也靠它隱藏已正式化的 legacy 副本——
-- 不做任何事後的書名比對。
CREATE TABLE IF NOT EXISTS material_book_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  book_id INTEGER NOT NULL,              -- material_books.id
  source_kind TEXT NOT NULL,             -- legacy_toc
  source_row_id INTEGER NOT NULL,        -- toc_items.id
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Plan 這一次選了哪些 ContentItem。這裡只記「選取」，不記完成度。
-- 取消選取不是完成、也不是刪除：selected 轉 0 並留下 removed_at 與 task_id，
-- 歷史 provenance 因此不會消失。
CREATE TABLE IF NOT EXISTS plan_material_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  content_item_id INTEGER NOT NULL,
  selected INTEGER NOT NULL DEFAULT 1,
  task_id INTEGER,                       -- 這次選取實際產生的 Task
  removed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

export async function initSchema() {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }
  // 舊資料庫補欄位
  for (const col of ["coins INTEGER DEFAULT 0", "coins_total INTEGER DEFAULT 0", "pet TEXT DEFAULT '{}'", "custom_tags TEXT DEFAULT '[]'"]) {
    try { await client.execute(`ALTER TABLE users ADD COLUMN ${col}`); } catch {}
  }
  try { await client.execute("ALTER TABLE toc_items ADD COLUMN level TEXT DEFAULT '章'"); } catch {}
  try { await client.execute("ALTER TABLE tasks ADD COLUMN miss_policy TEXT DEFAULT 'keep'"); } catch {}
  try { await client.execute("ALTER TABLE habits ADD COLUMN miss_policy TEXT DEFAULT 'drop'"); } catch {}
  try { await client.execute("ALTER TABLE fixed_events ADD COLUMN location TEXT DEFAULT ''"); } catch {}
  try { await client.execute("ALTER TABLE fixed_events ADD COLUMN color TEXT DEFAULT ''"); } catch {}
  try { await client.execute("ALTER TABLE habits ADD COLUMN category TEXT DEFAULT ''"); } catch {}
  try { await client.execute("ALTER TABLE tasks ADD COLUMN deleted INTEGER DEFAULT 0"); } catch {}
  try { await client.execute("ALTER TABLE lists ADD COLUMN icon TEXT DEFAULT 'book'"); } catch {}
  try { await client.execute("ALTER TABLE vocab_items ADD COLUMN color TEXT DEFAULT ''"); } catch {}
  try { await client.execute("ALTER TABLE toc_items ADD COLUMN book TEXT DEFAULT ''"); } catch {}
  try { await client.execute("ALTER TABLE toc_items ADD COLUMN publisher TEXT DEFAULT ''"); } catch {}
  try { await client.execute("ALTER TABLE fixed_events ADD COLUMN kind TEXT DEFAULT ''"); } catch {}
  try { await client.execute("ALTER TABLE memos ADD COLUMN due_date TEXT DEFAULT ''"); } catch {}
  // Phase 2A：任務歸屬哪個 Plan（可為 NULL——「買筆」這種事不該被迫塞進某個計畫）
  try { await client.execute("ALTER TABLE tasks ADD COLUMN plan_id INTEGER"); } catch {}
  // Phase 2A：正式截止日。跟 due_date（排定日期）分開，NULL＝沒有硬性截止
  try { await client.execute("ALTER TABLE tasks ADD COLUMN deadline_date TEXT"); } catch {}
  // Master A/F：估計時間是工作量的明確輸入；實際時間仍只寫 StudySession。
  // NULL 表示舊資料尚無估計，不能硬猜成一個看似精確的數字。
  try { await client.execute("ALTER TABLE tasks ADD COLUMN estimated_minutes INTEGER"); } catch {}
  // Phase 1 lifecycle：取消是任務結果，不是完成或刪除；舊資料預設仍是未取消。
  try { await client.execute("ALTER TABLE tasks ADD COLUMN cancelled INTEGER DEFAULT 0"); } catch {}
  try { await client.execute("ALTER TABLE tasks ADD COLUMN cancelled_at TEXT"); } catch {}
  try { await client.execute("ALTER TABLE plans ADD COLUMN paused_at TEXT"); } catch {}
  try { await client.execute("ALTER TABLE plans ADD COLUMN ended_at TEXT"); } catch {}
  try { await client.execute("ALTER TABLE plans ADD COLUMN end_reason TEXT"); } catch {}
  try { await client.execute("ALTER TABLE plans ADD COLUMN archived_from_status TEXT"); } catch {}
  // Phase 2C-P1：排程持久化。契約見 docs/phase2c-schedule-persistence.md §2
  // effective_from：這一版涵蓋哪一天起（過去不進 snapshot）
  try { await client.execute("ALTER TABLE schedule_versions ADD COLUMN effective_from TEXT"); } catch {}
  // block_count：刻意的冗餘。版本列表要顯示「這一版有幾項」，不該為此逐版 count。
  // 它是 immutable snapshot 的屬性，寫入後永不改變，所以不會不同步（§2.1）
  try { await client.execute("ALTER TABLE schedule_versions ADD COLUMN block_count INTEGER DEFAULT 0"); } catch {}
  // restored_from_version_id：模板來源，跟 parent_version_id（血緣）是兩件事（§12.1）
  try { await client.execute("ALTER TABLE schedule_versions ADD COLUMN restored_from_version_id INTEGER"); } catch {}
  // 顯示留影：任務被刪掉之後歷史版本仍看得懂。只作顯示，不是 identity（§2.2）
  try { await client.execute("ALTER TABLE scheduled_blocks ADD COLUMN task_title_snapshot TEXT"); } catch {}
  try { await client.execute("ALTER TABLE scheduled_blocks ADD COLUMN subject_name_snapshot TEXT"); } catch {}
  // StudySession 是歷史執行紀錄：Task 日後 hard delete 時仍需能顯示這筆紀錄。
  try { await client.execute("ALTER TABLE study_sessions ADD COLUMN task_title_snapshot TEXT"); } catch {}
  // 在所有 read/write path 開始前修復舊 ScheduledBlock shape。此 repair 與受
  // production audit gate 保護的 Task clustering migration 完全無關。
  await repairScheduledBlockTiming();
  // 版本號在同一個使用者底下唯一；併發時靠這個唯一鍵擋，再 bounded retry（§7.2）
  try { await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_sv_user_no ON schedule_versions(user_id, version_no)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_sb_version_date ON scheduled_blocks(schedule_version_id, date)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_sb_task ON scheduled_blocks(task_id)"); } catch {}
  // 刻意不加 UNIQUE(schedule_version_id, task_id)：目前生成器保證一個任務一版一個
  // block，但那是生成器的不變式、不是 schema 的。未來要支援「一個任務拆兩段」時
  // schema 不該擋路（§2.2）。這條由測試守。
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id)"); } catch {}
  // 2C-P4：Lock 是 current-state constraint；主動解鎖採 soft release，過期由讀取推導。
  try { await client.execute("ALTER TABLE schedule_locks ADD COLUMN released_at TEXT"); } catch {}
  try { await client.execute("ALTER TABLE schedule_locks ADD COLUMN release_reason TEXT"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_locks_user_live ON schedule_locks(user_id, released_at)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_locks_task ON schedule_locks(task_id)"); } catch {}
  try { await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_locks_task_one ON schedule_locks(user_id, task_id) WHERE type='task' AND released_at IS NULL"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, status)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id, target_date)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_plan_constraints_user ON plan_constraints(user_id)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_routines_user ON availability_routines(user_id, enabled)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_routine_exceptions_user_date ON routine_exceptions(user_id, date)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_study_sessions_user_started ON study_sessions(user_id, started_at)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_study_sessions_task ON study_sessions(task_id)"); } catch {}
  try { await client.execute("ALTER TABLE study_sessions ADD COLUMN running_since TEXT"); } catch {}
  // Task ↔ Material：Task 仍是排程的唯一單位，這兩個欄位只是「這個 Task 在做哪一
  // 份教材」的指向。scheduled_blocks 刻意不加 material 欄位（契約 10）。
  try { await client.execute("ALTER TABLE tasks ADD COLUMN material_content_item_id INTEGER"); } catch {}
  try { await client.execute("ALTER TABLE tasks ADD COLUMN material_book_id INTEGER"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_material_books_user ON material_books(user_id, archived)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_material_nodes_book ON material_nodes(book_id, parent_id, order_index)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_material_items_node ON material_content_items(node_id, order_index)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_material_items_book ON material_content_items(book_id)"); } catch {}
  // 一個 ContentItem 一位使用者只有一列進度——完成度的唯一真相由這條守。
  try { await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_material_progress_one ON material_progress(user_id, content_item_id)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_material_categories_user ON material_categories(user_id, order_index)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_material_category_books_book ON material_category_books(book_id)"); } catch {}
  // 同一個 Plan 對同一個 ContentItem 只能有一列 selection（含已移除的歷史列）。
  try { await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_material_one ON plan_material_items(plan_id, content_item_id)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_plan_material_item ON plan_material_items(user_id, content_item_id, selected)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_tasks_material_item ON tasks(user_id, material_content_item_id)"); } catch {}
  // 同一列 legacy 來源只能被正式化一次。重複正式化會生出兩本內容相同、
  // 完成度各自獨立的教材，而且沒有任何入口能合併回去。
  try { await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_material_book_source_row ON material_book_sources(user_id, source_kind, source_row_id)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_material_book_sources_book ON material_book_sources(book_id)"); } catch {}
  // 見 ensureStudySessionLiveIndex()：有重複 live session 時會跳過而不是靜默失敗。
  await ensureStudySessionLiveIndex();
  // 舊資料的分類補進「記住的分類」清單，之後直接用選的
  try { await client.execute("INSERT INTO memo_categories (user_id,name,order_index) SELECT DISTINCT user_id,category,0 FROM memos WHERE category<>'' AND category IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memo_categories c WHERE c.user_id=memos.user_id AND c.name=memos.category)"); } catch {}
  // 舊 bug（重複扣款）造成的負金幣歸零
  try { await client.execute('UPDATE users SET coins=0 WHERE coins<0'); } catch {}
  // 一次性清理：舊 bug 產生的碎片標籤（純 1–2 個英文字母，如 ek、ne、l）
  try {
    const rs = await client.execute('SELECT id, tags FROM tasks');
    for (const r of rs.rows) {
      let t;
      try { t = JSON.parse(r.tags); } catch { t = null; }
      if (!Array.isArray(t)) {
        await client.execute({ sql: 'UPDATE tasks SET tags=? WHERE id=?', args: ['[]', r.id] });
        continue;
      }
      const clean = t.filter(x => !(typeof x === 'string' && /^[a-zA-Z]{1,2}$/.test(x)));
      if (clean.length !== t.length) {
        await client.execute({ sql: 'UPDATE tasks SET tags=? WHERE id=?', args: [JSON.stringify(clean), r.id] });
      }
    }
  } catch (e) { console.error('tag cleanup:', e.message); }
  // 同樣清理帳號設定裡的自訂標籤
  try {
    const rs = await client.execute('SELECT id, custom_tags FROM users');
    for (const r of rs.rows) {
      let t;
      try { t = JSON.parse(r.custom_tags || '[]'); } catch { t = null; }
      const clean = (Array.isArray(t) ? t : []).filter(x => typeof x === 'string' && x.trim() && !/^[a-zA-Z]{1,2}$/.test(x.trim()));
      if (!Array.isArray(t) || clean.length !== t.length) {
        await client.execute({ sql: 'UPDATE users SET custom_tags=? WHERE id=?', args: [JSON.stringify(clean), r.id] });
      }
    }
  } catch (e) { console.error('custom_tags cleanup:', e.message); }
}
