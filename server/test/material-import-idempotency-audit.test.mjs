// 整本教材建立冪等性的獨立資料安全稽核。
//
// 這支不走 UI，也不重用其他教材測試的 fixture：直接驗證 service 與資料庫交易的
// 最小安全契約，避免 HTTP 回應遺失或同一請求重送時留下重複／半本教材。

import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'material-idempotency-audit-')), 'db.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const material = await import('../src/material/service.js');
const { validateDraft } = await import('../src/material/draft.js');

const USER_A = 8101;
const USER_B = 8102;
const LIST_A = 8201;
const LIST_B = 8202;

const draftFor = (title, subjectListId) => ({
  book: { title, publisher: '測試出版社', subject_list_id: subjectListId },
  chapters: [{
    title: '第一章',
    content_items: [{ title: '第一章重點', kind: 'reading' }],
    children: [],
  }],
});

const count = async (table, userId) => Number((await q.get(
  `SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`, [userId])).count);

before(async () => {
  await initSchema();
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER_A, 'material-a@test.local', 'x']);
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER_B, 'material-b@test.local', 'x']);
  await q.run('INSERT INTO lists (id,user_id,name) VALUES (?,?,?)', [LIST_A, USER_A, '數學']);
  await q.run('INSERT INTO lists (id,user_id,name) VALUES (?,?,?)', [LIST_B, USER_B, '數學']);
});

describe('教材 import commit 冪等資料安全稽核', () => {
  test('同 user/key/payload 並行送出時，兩邊都取得同一本教材', async () => {
    const key = 'material_audit_concurrent_0001';
    const payload = draftFor('並行建立教材', LIST_A);
    const before = await count('material_books', USER_A);
    const [a, b] = await Promise.all([
      material.commitMaterialDraft(USER_A, payload, { clientRequestId: key }),
      material.commitMaterialDraft(USER_A, payload, { clientRequestId: key }),
    ]);
    assert.equal(a.book.id, b.book.id);
    assert.equal(await count('material_books', USER_A), before + 1);
  });

  test('回應遺失後以同 key、同 canonical payload 重送，只取得原 Book', async () => {
    const key = 'material_audit_response_loss_0001';
    const payload = draftFor('回應遺失教材', LIST_A);
    const before = await count('material_books', USER_A);

    const first = await material.commitMaterialDraft(USER_A, payload, { clientRequestId: key });
    // 模擬 client 沒收到 first：不使用 first 的任何狀態，直接以同一請求重送。
    const replay = await material.commitMaterialDraft(USER_A, {
      chapters: payload.chapters,
      book: { subject_list_id: LIST_A, publisher: '測試出版社', title: '回應遺失教材' },
    }, { clientRequestId: key });

    assert.deepEqual(replay.book, first.book, 'exact replay 必須從 marker 指向的 Book 回原完整結果');
    assert.equal(await count('material_books', USER_A), before + 1);
  });

  test('同 key 換 payload fail closed，且 key 以 user_id 隔離', async () => {
    const key = 'material_audit_account_scope_0001';
    const a = await material.commitMaterialDraft(
      USER_A, draftFor('甲帳號教材', LIST_A), { clientRequestId: key });

    await assert.rejects(
      () => material.commitMaterialDraft(
        USER_A, draftFor('偷換內容', LIST_A), { clientRequestId: key }),
      error => error?.status === 409 && error?.code === 'IDEMPOTENCY_KEY_REUSED');

    const b = await material.commitMaterialDraft(
      USER_B, draftFor('乙帳號教材', LIST_B), { clientRequestId: key });
    assert.notEqual(b.book.id, a.book.id, '不同帳號不得取得另一人的 replay 結果');
    assert.equal(b.book.user_id, USER_B);
  });

  test('冪等 marker 寫入失敗時，前面已寫的完整教材樹也必須 rollback', async () => {
    const canonical = validateDraft(draftFor('marker 失敗不得殘留', LIST_A)).draft;
    const before = {
      books: await count('material_books', USER_A),
      nodes: await count('material_nodes', USER_A),
      items: await count('material_content_items', USER_A),
      requests: await count('material_import_commit_requests', USER_A),
    };

    // payload_hash 是 NOT NULL；不論錯誤發生在 claim 或後續教材樹寫入，整筆都不能殘留。
    await assert.rejects(() => material.writeDraftTree(USER_A, canonical, {
      idempotency: { requestKey: 'material_audit_marker_failure_0001', payloadHash: null },
    }));

    assert.deepEqual({
      books: await count('material_books', USER_A),
      nodes: await count('material_nodes', USER_A),
      items: await count('material_content_items', USER_A),
      requests: await count('material_import_commit_requests', USER_A),
    }, before, 'marker 與教材樹必須共享同一交易，不得留下半成品或 poison key');
  });
});
