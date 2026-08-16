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
};

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
  order_index INTEGER DEFAULT 0,
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
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | active | completed | archived
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | ai | legacy_migration | import
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  archived_at TEXT
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
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id)"); } catch {}
  try { await client.execute("CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, status)"); } catch {}
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
