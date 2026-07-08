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
  color TEXT DEFAULT '#4772fa',
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
`;

export async function initSchema() {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }
  // 舊資料庫補欄位
  for (const col of ["coins INTEGER DEFAULT 0", "coins_total INTEGER DEFAULT 0", "pet TEXT DEFAULT '{}'"]) {
    try { await client.execute(`ALTER TABLE users ADD COLUMN ${col}`); } catch {}
  }
  try { await client.execute("ALTER TABLE toc_items ADD COLUMN level TEXT DEFAULT '章'"); } catch {}
  try { await client.execute("ALTER TABLE tasks ADD COLUMN miss_policy TEXT DEFAULT 'keep'"); } catch {}
  try { await client.execute("ALTER TABLE habits ADD COLUMN miss_policy TEXT DEFAULT 'drop'"); } catch {}
}
