// 教材編輯器新增章節／內容項目的冪等與交易邊界。

import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'material-editor-idem-')), 'db.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const material = await import('../src/material/service.js');

const USER_A = 9101;
const USER_B = 9102;
let bookA;
let bookB;
let chapterA;
let chapterB;

const count = async (table, where, args) => Number((await q.get(
  `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, args)).count);

before(async () => {
  await initSchema();
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER_A, 'editor-a@test.local', 'x']);
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER_B, 'editor-b@test.local', 'x']);
  bookA = Number((await q.run('INSERT INTO material_books (user_id,title) VALUES (?,?)', [USER_A, '甲教材'])).lastInsertRowid);
  bookB = Number((await q.run('INSERT INTO material_books (user_id,title) VALUES (?,?)', [USER_B, '乙教材'])).lastInsertRowid);
  chapterA = Number((await q.run(
    "INSERT INTO material_nodes (user_id,book_id,parent_id,kind,title,order_index) VALUES (?,?,NULL,'chapter',?,0)",
    [USER_A, bookA, '甲第一章'])).lastInsertRowid);
  chapterB = Number((await q.run(
    "INSERT INTO material_nodes (user_id,book_id,parent_id,kind,title,order_index) VALUES (?,?,NULL,'chapter',?,0)",
    [USER_B, bookB, '乙第一章'])).lastInsertRowid);
});

describe('教材編輯器新增冪等契約', () => {
  test('node response loss 後同 key、同 canonical payload 回原結果，不重複新增', async () => {
    const key = 'material_node_response_loss_0001';
    const before = await count('material_nodes', 'user_id=? AND book_id=?', [USER_A, bookA]);
    const first = await material.createNode(USER_A, {
      book_id: bookA, parent_id: chapterA, kind: 'section', title: ' 1-1 ',
    }, { clientRequestId: key });
    const replay = await material.createNode(USER_A, {
      title: '1-1', kind: 'section', parent_id: chapterA, book_id: bookA,
    }, { clientRequestId: key });

    assert.equal(replay.id, first.id);
    assert.equal(await count('material_nodes', 'user_id=? AND book_id=?', [USER_A, bookA]), before + 1);
  });

  test('content item 同 key 同 payload 回原結果；不同 payload 回 409', async () => {
    const key = 'material_item_response_loss_0001';
    const body = { node_id: chapterA, kind: 'unit_exercise', title: '單元練習', estimated_minutes: 30 };
    const first = await material.createContentItem(USER_A, body, { clientRequestId: key });
    const replay = await material.createContentItem(USER_A, body, { clientRequestId: key });
    assert.equal(replay.id, first.id);

    await assert.rejects(
      () => material.createContentItem(USER_A, { ...body, title: '偷換內容' }, { clientRequestId: key }),
      error => error?.status === 409 && error?.code === 'IDEMPOTENCY_KEY_REUSED');
  });

  test('key 以 user 與 operation scope 隔離', async () => {
    const key = 'material_shared_scope_key_0001';
    const aNode = await material.createNode(USER_A, {
      book_id: bookA, parent_id: chapterA, kind: 'section', title: '甲新增節',
    }, { clientRequestId: key });
    const bNode = await material.createNode(USER_B, {
      book_id: bookB, parent_id: chapterB, kind: 'section', title: '乙新增節',
    }, { clientRequestId: key });
    const aItem = await material.createContentItem(USER_A, {
      node_id: chapterA, kind: 'past_exam', title: '甲歷屆試題',
    }, { clientRequestId: key });

    assert.notEqual(aNode.id, bNode.id);
    assert.equal(bNode.user_id, USER_B);
    assert.equal(aItem.user_id, USER_A);
  });

  test('result marker 最後更新失敗時，新增列與 marker 一起 rollback', async () => {
    const key = 'material_marker_update_fail_0001';
    const beforeNodes = await count('material_nodes', 'user_id=? AND book_id=?', [USER_A, bookA]);
    await q.run(`CREATE TRIGGER fail_material_marker_update
      BEFORE UPDATE OF result_id ON material_create_requests
      WHEN NEW.request_key='${key}'
      BEGIN SELECT RAISE(ABORT, 'injected marker update failure'); END`);
    try {
      await assert.rejects(() => material.createNode(USER_A, {
        book_id: bookA, parent_id: chapterA, kind: 'section', title: '不得殘留',
      }, { clientRequestId: key }), /injected marker update failure/);
    } finally {
      await q.run('DROP TRIGGER fail_material_marker_update');
    }

    assert.equal(await count('material_nodes', 'user_id=? AND book_id=?', [USER_A, bookA]), beforeNodes);
    assert.equal(await count('material_create_requests',
      'user_id=? AND operation_scope=? AND request_key=?', [USER_A, 'node', key]), 0);
  });

  test('同 key 不同 payload 的 409 不會污染後續新的 key', async () => {
    const firstKey = 'material_retry_after_conflict_0001';
    const secondKey = 'material_retry_after_conflict_0002';
    const base = { book_id: bookA, parent_id: chapterA, kind: 'section', title: '原內容' };
    await material.createNode(USER_A, base, { clientRequestId: firstKey });
    await assert.rejects(() => material.createNode(USER_A, { ...base, title: '不同內容' }, {
      clientRequestId: firstKey,
    }), /不同內容/);
    const retried = await material.createNode(USER_A, { ...base, title: '不同內容' }, {
      clientRequestId: secondKey,
    });
    assert.equal(retried.title, '不同內容');
  });

  test('已移到垃圾桶的教材拒絕新增 node，且不殘留冪等 marker', async () => {
    const key = 'material_deleted_book_node_0001';
    const deletedBook = Number((await q.run(
      "INSERT INTO material_books (user_id,title,deleted_at) VALUES (?,?,CURRENT_TIMESTAMP)",
      [USER_A, '已刪除教材'])).lastInsertRowid);

    await assert.rejects(() => material.createNode(USER_A, {
      book_id: deletedBook, parent_id: null, kind: 'chapter', title: '不可新增的章',
    }, { clientRequestId: key }), error => error?.status === 404);

    assert.equal(await count('material_nodes', 'user_id=? AND book_id=?', [USER_A, deletedBook]), 0);
    assert.equal(await count('material_create_requests',
      'user_id=? AND operation_scope=? AND request_key=?', [USER_A, 'node', key]), 0);
  });

  test('已移到垃圾桶的教材拒絕新增 content item，且不殘留冪等 marker', async () => {
    const key = 'material_deleted_book_item_0001';
    const deletedBook = Number((await q.run(
      "INSERT INTO material_books (user_id,title,deleted_at) VALUES (?,?,CURRENT_TIMESTAMP)",
      [USER_A, '已刪除教材內容'])).lastInsertRowid);
    const tombstoneChapter = Number((await q.run(
      "INSERT INTO material_nodes (user_id,book_id,parent_id,kind,title,order_index) VALUES (?,?,NULL,'chapter',?,0)",
      [USER_A, deletedBook, '仍供歷史引用的章'])).lastInsertRowid);

    await assert.rejects(() => material.createContentItem(USER_A, {
      node_id: tombstoneChapter, kind: 'unit_exercise', title: '不可新增的內容',
    }, { clientRequestId: key }), error => error?.status === 404);

    assert.equal(await count('material_content_items', 'user_id=? AND book_id=?', [USER_A, deletedBook]), 0);
    assert.equal(await count('material_create_requests',
      'user_id=? AND operation_scope=? AND request_key=?', [USER_A, 'content_item', key]), 0);
  });

  test('原新增結果已不存在時 replay 明確拒絕，不會建立第二筆', async () => {
    const key = 'material_result_missing_0001';
    const created = await material.createContentItem(USER_A, {
      node_id: chapterA, kind: 'past_exam', title: '稍後移除的結果',
    }, { clientRequestId: key });
    await q.run('DELETE FROM material_content_items WHERE id=? AND user_id=?', [created.id, USER_A]);

    await assert.rejects(() => material.createContentItem(USER_A, {
      node_id: chapterA, kind: 'past_exam', title: '稍後移除的結果',
    }, { clientRequestId: key }), error => error?.status === 409
      && error?.code === 'IDEMPOTENCY_RESULT_MISSING');
    assert.equal(await count('material_content_items',
      'user_id=? AND node_id=? AND title=?', [USER_A, chapterA, '稍後移除的結果']), 0);
  });
});
