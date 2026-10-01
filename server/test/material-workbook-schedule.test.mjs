import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'workbook-schedule-')), 'test.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const { runPreview } = await import('../src/routes/schedule.js');
const { todayTW, addDays } = await import('../src/util/date.js');

let userId, listId, workbookId;
before(async () => {
  await initSchema();
  userId = Number((await q.run('INSERT INTO users (email,password_hash,sleep_start,sleep_end,meal_windows) VALUES (?,?,?,?,?)',
    ['workbook@test', 'x', '23:00', '07:00', '[]'])).lastInsertRowid);
  listId = Number((await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [userId, '數學'])).lastInsertRowid);
  const bookId = Number((await q.run('INSERT INTO material_books (user_id,title,subject_list_id) VALUES (?,?,?)', [userId, '數學習作', listId])).lastInsertRowid);
  const chapterId = Number((await q.run("INSERT INTO material_nodes (user_id,book_id,kind,title) VALUES (?,?,'chapter',?)", [userId, bookId, '第一章'])).lastInsertRowid);
  workbookId = Number((await q.run(
    "INSERT INTO material_content_items (user_id,book_id,node_id,kind,title) VALUES (?,?,?,'workbook_exercise',?)",
    [userId, bookId, chapterId, '基礎題組 A'])).lastInsertRowid);
});

test('習作由 CURRENT canonical kind 強制純題目規則，不靠標題或 client flag', async () => {
  const start = todayTW(), end = addDays(start, 10);
  const r = await runPreview(userId, {
    startDate: start, endDate: end,
    items: [
      { subject_id: listId, title: '數學｜第一章｜基礎題組 A', minutes: 60, start, end, material_content_item_id: workbookId },
      { subject_id: listId, title: '數學｜第一章｜課本內容', minutes: 60, start, end },
    ],
  });
  assert.equal(r.status, 200);
  const [workbook] = r.body.blocks.filter(b => b.title.endsWith('基礎題組 A'));
  assert.ok(workbook);
  assert.equal(r.body.blocks.some(b => b.date === workbook.date && b.subject_id === listId && b.title.endsWith('課本內容')), false,
    '習作不得與同科一般節內容同日');
});

test('不存在或跨使用者的 material identity fail closed', async () => {
  const start = todayTW(), end = addDays(start, 2);
  const r = await runPreview(userId, { startDate: start, endDate: end,
    items: [{ subject_id: listId, title: '偽造教材', minutes: 60, start, end, material_content_item_id: 999999 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /找不到其中一項教材內容/);
});

test('一般 Task 的 null material identity 不會污染混合 preview，只有習作套用純題目語意', async () => {
  const start = todayTW(), next = addDays(start, 1);
  const r = await runPreview(userId, {
    startDate: start, endDate: next,
    items: [
      { subject_id: listId, title: '一般複習', minutes: 60, start, end: start, material_content_item_id: null },
      { subject_id: listId, title: '自訂名稱不含題目關鍵字', minutes: 60, start, end: next, material_content_item_id: workbookId },
    ],
  });
  assert.equal(r.status, 200);
  const dates = new Map(r.body.blocks.map(block => [block.title, block.date]));
  assert.equal(dates.get('一般複習'), start);
  assert.equal(dates.get('自訂名稱不含題目關鍵字'), next,
    '習作的 canonical kind 應使它避開同科一般內容，不靠自訂標題猜');
});

test('只有 null material identity 的一般 Task preview 維持正常', async () => {
  const start = todayTW(), end = addDays(start, 2);
  const r = await runPreview(userId, { startDate: start, endDate: end,
    items: [{ subject_id: listId, title: '一般複習', minutes: 60, start, end, material_content_item_id: null }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.blocks.length, 1);
});
