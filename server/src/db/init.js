import { createClient } from '@libsql/client';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 有設定 Turso 就用雲端（永久保存）；否則用本機檔案（開發用）
const client = process.env.TURSO_DATABASE_URL
  ? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: 'file:' + path.join(__dirname, '..', '..', 'data.sqlite') });

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
CREATE TABLE IF NOT EXISTS list_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL
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
