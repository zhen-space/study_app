// 教材目錄匯入的資料安全。
//
// 這一組全部是負向測試：匯入一本新教材，**不得**刪掉、覆蓋或完成既有教材，
// 也不得動到 Plan、Plan 選取或 material_progress。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTocWrite, deleteScope, wouldDelete, MODES } from '../src/import/toc-replace.js';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const row = (o = {}) => ({ user_id: 1, list_id: 10, book: '物理課本', ...o });

/* ---------- 預設不刪 ---------- */

test('沒帶 replace 就是新增，一列都不刪', () => {
  const p = planTocWrite({ book: '物理課本' });
  assert.equal(p.mode, 'append');
  assert.equal(deleteScope({ book: '物理課本', userId: 1, listId: 10 }), null);
});

test('replace 是 false / null / 字串 / 0 都當作新增', () => {
  for (const replace of [false, null, undefined, 0, '', 'true', 1, {}]) {
    assert.equal(planTocWrite({ replace, book: 'A' }).mode, 'append', JSON.stringify(replace));
    assert.equal(deleteScope({ replace, book: 'A', userId: 1, listId: 10 }), null, JSON.stringify(replace));
  }
});

test('只有明確 replace===true 才會刪', () => {
  assert.equal(planTocWrite({ replace: true, book: 'A' }).mode, 'replace');
  assert.deepEqual(deleteScope({ replace: true, book: 'A', userId: 1, listId: 10 }),
    { user_id: 1, list_id: 10, book: 'A' });
});

/* ---------- 讀不到書名 ---------- */

test('要求取代但讀不到書名 → 停下來問，不整科刪除', () => {
  for (const book of [undefined, null, '', '   ']) {
    const p = planTocWrite({ replace: true, book });
    assert.equal(p.mode, 'refuse', JSON.stringify(book));
    assert.equal(p.reason, 'replace_requires_book');
    assert.equal(deleteScope({ replace: true, book, userId: 1, listId: 10 }), null,
      '沒有書名時絕不能產生刪除範圍');
  }
});

/* ---------- 不得波及其他書 ---------- */

test('取代只刪同名那一本，不碰同科的其他書', () => {
  const scope = deleteScope({ replace: true, book: '物理課本', userId: 1, listId: 10 });
  assert.equal(wouldDelete(row({ book: '物理課本' }), scope), true);
  assert.equal(wouldDelete(row({ book: '化學課本' }), scope), false);
});

test('空書名的既有列不得被順手刪掉', () => {
  // 舊版是 `book=? OR book=''`——上一次讀不到書名的那本會被新的一本吃掉
  const scope = deleteScope({ replace: true, book: '物理課本', userId: 1, listId: 10 });
  assert.equal(wouldDelete(row({ book: '' }), scope), false, '沒讀到書名的舊教材不得被刪');
});

test('不碰其他科目、不碰其他使用者', () => {
  const scope = deleteScope({ replace: true, book: '物理課本', userId: 1, listId: 10 });
  assert.equal(wouldDelete(row({ list_id: 99 }), scope), false);
  assert.equal(wouldDelete(row({ user_id: 2 }), scope), false);
});

test('書名前後空白不影響比對', () => {
  assert.deepEqual(deleteScope({ replace: true, book: '  物理課本  ', userId: 1, listId: 10 }),
    { user_id: 1, list_id: 10, book: '物理課本' });
});

test('只有三種模式', () => {
  assert.deepEqual(MODES, ['append', 'replace', 'refuse']);
});

/* ---------- 路由層的靜態契約 ---------- */

const importSrc = () => readFileSync(path.join(serverDir, 'src/routes/import.js'), 'utf8');
// 註解裡會提到這些做法（正是在說明「不可以這樣」），比對前先去掉註解
const importCode = () => importSrc().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('匯入路徑不得有「整科刪除」的 SQL', () => {
  const code = importCode();
  const i = code.indexOf("router.post('/toc'");
  const block = code.slice(i, code.indexOf('res.json({ items, book, publisher })', i));
  // 條件停在 list_id（後面沒有再 AND 別的）就是整科刪除
  assert.equal(/DELETE FROM toc_items WHERE user_id=\? AND list_id=\?(?!\s*AND)/.test(block), false,
    '不得出現只以 (user_id, list_id) 為條件的刪除');
  assert.ok(/DELETE FROM toc_items WHERE user_id=\? AND list_id=\? AND book=\?/.test(block),
    '刪除必須精確限定到某一本書');
  assert.equal(/book=\? OR book=/.test(block), false, '不得順手刪掉空書名的列');
});

test('匯入路徑不得有 replace !== false 這種「預設就刪」的判斷', () => {
  assert.equal(/replace\s*!==\s*false/.test(importCode()), false);
});

test('刪除與新增在同一個交易裡——中途失敗不得留下「舊的刪了、新的沒進來」', () => {
  const code = importCode();
  const i = code.indexOf("router.post('/toc'");
  const block = code.slice(i, code.indexOf('res.json({ items, book, publisher })', i));
  assert.ok(/q\.tx\(/.test(block), '必須用交易包起來');
  const del = block.indexOf('DELETE FROM toc_items');
  const tx = block.indexOf('q.tx(');
  assert.ok(del > tx, '刪除必須在交易內');
});

test('教材匯入完全不碰 Plan、Plan 選取與教材完成度', () => {
  const code = importCode();
  const i = code.indexOf("router.post('/toc'");
  const block = code.slice(i, code.indexOf('res.json({ items, book, publisher })', i));
  for (const forbidden of [
    /material_progress/, /plan_material_items/, /UPDATE plans/, /DELETE FROM plans/,
    /schedule_versions/, /scheduled_blocks/, /study_sessions/, /completed\s*=\s*1/,
  ]) {
    assert.equal(forbidden.test(block), false, `匯入不該碰：${forbidden}`);
  }
});

test('判斷模組不碰資料庫', () => {
  const src = readFileSync(path.join(serverDir, 'src/import/toc-replace.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/db\/init/.test(code), false);
  assert.equal(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(code), false);
});
