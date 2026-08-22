// Material full-tree commit 的交易邊界。
//
// 這一支直接呼叫 service（不走 HTTP），因為要**故意讓中途失敗**才驗得到
// rollback——commitMaterialDraft 會先跑 validateDraft，合法性問題根本到不了
// 交易裡。要證明 transaction 真的有用，必須從 writeDraftTree 這一層進去，
// 用「驗證看不到的失敗」（DB 錯誤）打斷它。
//
// 契約：整本教材全成功或全不做。絕不能留下
//   ・Book 存在但沒有章
//   ・只有前面幾章
//   ・ContentItem 寫一半

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'mtx-')), 'm.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const svc = await import('../src/material/service.js');
const { validateDraft } = await import('../src/material/draft.js');

const USER = 1;

before(async () => {
  await initSchema();
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER, 'mtx@test', 'x']);
  await q.run('INSERT INTO lists (id,user_id,name) VALUES (?,?,?)', [1, USER, '數學']);
});

const counts = async () => ({
  books: Number((await q.get('SELECT COUNT(*) c FROM material_books WHERE user_id=?', [USER])).c),
  nodes: Number((await q.get('SELECT COUNT(*) c FROM material_nodes WHERE user_id=?', [USER])).c),
  items: Number((await q.get('SELECT COUNT(*) c FROM material_content_items WHERE user_id=?', [USER])).c),
});

const okDraft = () => validateDraft({
  book: { title: '正常教材', subject_list_id: 1 },
  chapters: [{
    title: '第一章',
    content_items: [{ title: '單元練習', kind: 'unit_exercise' }],
    children: [{ kind: 'section', title: '1-1', content_items: [{ title: '範例', kind: 'example' }] }],
  }],
}).draft;

describe('writeDraftTree 的交易邊界', () => {
  test('正常寫入：Book、章節、內容一次到位', async () => {
    const before = await counts();
    await svc.writeDraftTree(USER, okDraft());
    const after = await counts();
    assert.equal(after.books, before.books + 1);
    assert.equal(after.nodes, before.nodes + 2);   // 章 + 節
    assert.equal(after.items, before.items + 2);
  });

  test('★ 第二章的 ContentItem 寫入失敗 → Book、第一章、已寫的內容全部回滾', async () => {
    const before = await counts();
    // title 為 null → material_content_items.title NOT NULL，在迴圈中途炸掉。
    // 第一章此時已經 INSERT 過，必須跟著整筆消失。
    const draft = {
      book: { title: '不該留下的書', publisher: '', subject_list_id: 1 },
      chapters: [
        {
          title: '第一章', order: 0,
          content_items: [{ title: '單元練習', kind: 'unit_exercise', order: 0, estimated_minutes: null }],
          children: [],
        },
        {
          title: '第二章', order: 1,
          content_items: [{ title: null, kind: 'past_exam', order: 0, estimated_minutes: null }],
          children: [],
        },
      ],
    };
    await assert.rejects(() => svc.writeDraftTree(USER, draft));

    const after = await counts();
    assert.deepEqual(after, before, '★ Book、章、ContentItem 都必須回滾');
    const orphan = await q.get(
      'SELECT id FROM material_books WHERE user_id=? AND title=?', [USER, '不該留下的書']);
    assert.equal(orphan, undefined, '★ 不得留下沒有內容的空 Book');
  });

  test('★ 節點寫入失敗 → 同樣整筆回滾，不留下半本教材', async () => {
    const before = await counts();
    const draft = {
      book: { title: '節點失敗', publisher: '', subject_list_id: 1 },
      chapters: [
        { title: '第一章', order: 0, content_items: [], children: [{ kind: 'section', title: '1-1', order: 0, content_items: [] }] },
        // 章名 null → material_nodes.title NOT NULL
        { title: null, order: 1, content_items: [], children: [] },
      ],
    };
    await assert.rejects(() => svc.writeDraftTree(USER, draft));
    assert.deepEqual(await counts(), before);
  });

  test('★ 迴圈裡的 placement guard 觸發時也整筆回滾（defence in depth）', async () => {
    const before = await counts();
    // 這份 draft 繞過了 validateDraft（直接呼叫 writer），
    // 交易裡的 itemPlacementProblem 必須擋下來，而且不留下第一章。
    const draft = {
      book: { title: 'guard 回滾', publisher: '', subject_list_id: 1 },
      chapters: [
        { title: '第一章', order: 0, content_items: [{ title: '單元練習', kind: 'unit_exercise', order: 0 }], children: [] },
        { title: '第二章', order: 1, content_items: [], children: [{ kind: 'section', title: '2-1', order: 0, content_items: [{ title: '塞錯的歷屆試題', kind: 'past_exam', order: 0 }] }] },
      ],
    };
    await assert.rejects(() => svc.writeDraftTree(USER, draft), /直接屬於章/);
    assert.deepEqual(await counts(), before, '★ guard 擋下時也不得留下第一章');
  });

  test('★ 科目不屬於自己時，一列都不會寫進去', async () => {
    const before = await counts();
    await assert.rejects(
      () => svc.writeDraftTree(USER, { ...okDraft(), book: { title: '別人的科目', publisher: '', subject_list_id: 999999 } }),
      /找不到這個科目/);
    assert.deepEqual(await counts(), before);
  });

  test('失敗之後仍然可以正常寫入下一本（交易沒有卡住連線）', async () => {
    const before = await counts();
    await svc.writeDraftTree(USER, { ...okDraft(), book: { title: '失敗後的下一本', publisher: '', subject_list_id: 1 } });
    const after = await counts();
    assert.equal(after.books, before.books + 1);
  });
});
