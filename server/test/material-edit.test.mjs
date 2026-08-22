// 教材的錯誤修正：改名、改內容種類、刪除。
//
// 學生自己建立教材之後一定會打錯字。沒有修正的路，那本教材就永遠壞著。
//
// 這一支守的界線：
//   ・改名**不換 identity**：完成度、Plan selection、既有 Task linkage 全部留著
//   ・改內容種類要重驗 placement（單元練習不能掛在節底下）
//   ・有使用紀錄（完成度／計畫選取／任務）的一律不能刪，而且說得出原因
//   ・刪一段是連同底下的內容一起，全成功或全不做，不留孤兒
//   ・底下任何一筆有紀錄，整段都不刪——不做「刪一半」

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'medit-')), 'e.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const svc = await import('../src/material/service.js');

const USER = 1;
let listId = 0;
let planId = 0;

before(async () => {
  await initSchema();
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER, 'e@test', 'x']);
  listId = Number((await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [USER, '數學'])).lastInsertRowid);
  planId = Number((await q.run('INSERT INTO plans (user_id,name) VALUES (?,?)', [USER, '段考'])).lastInsertRowid);
});

// 每個測試一本乾淨的教材：一章、一節、一主題，節底下三種內容，章底下單元練習
async function seed() {
  const out = await svc.commitMaterialDraft(USER, {
    book: { title: '打錯字的教材', publisher: '龍騰', subject_list_id: listId },
    chapters: [{
      title: '第 1 章 數與式',
      content_items: [{ kind: 'unit_exercise', title: '單元練習' }],
      children: [
        {
          kind: 'section',
          title: '1-1 數與數線',
          content_items: [
            { kind: 'reading', title: '課本內容' },
            { kind: 'example', title: '範例' },
            { kind: 'example_problem', title: '例題' },
          ],
        },
        { kind: 'topic', title: '主題 陷阱', content_items: [{ kind: 'reading', title: '課本內容' }] },
      ],
    }],
  });
  const bookId = out.book.id;
  const nodes = await q.all(
    'SELECT * FROM material_nodes WHERE user_id=? AND book_id=? ORDER BY id', [USER, bookId]);
  const items = await q.all(
    'SELECT * FROM material_content_items WHERE user_id=? AND book_id=? ORDER BY id', [USER, bookId]);
  return {
    bookId,
    chapter: nodes.find(n => n.kind === 'chapter'),
    section: nodes.find(n => n.kind === 'section'),
    topic: nodes.find(n => n.kind === 'topic'),
    unitEx: items.find(i => i.kind === 'unit_exercise'),
    reading: items.find(i => i.kind === 'reading' && i.node_id === nodes.find(n => n.kind === 'section').id),
    example: items.find(i => i.kind === 'example'),
  };
}

let B;
beforeEach(async () => { B = await seed(); });

describe('改名', () => {
  test('書名、出版社、科目都改得動', async () => {
    const b = await svc.updateBook(USER, B.bookId, { title: '改好的教材', publisher: '翰林' });
    assert.equal(b.title, '改好的教材');
    assert.equal(b.publisher, '翰林');
  });

  test('章／節／主題改得動', async () => {
    assert.equal((await svc.updateNode(USER, B.chapter.id, { title: '第 1 章 實數' })).title, '第 1 章 實數');
    assert.equal((await svc.updateNode(USER, B.section.id, { title: '1-1 實數線' })).title, '1-1 實數線');
    assert.equal((await svc.updateNode(USER, B.topic.id, { title: '主題 常見錯誤' })).title, '主題 常見錯誤');
  });

  test('內容項目改得動名字', async () => {
    assert.equal((await svc.updateContentItem(USER, B.example.id, { title: '範例 1' })).title, '範例 1');
  });

  test('空白名稱擋下來，不會留下一個沒有名字的節點', async () => {
    await assert.rejects(() => svc.updateNode(USER, B.section.id, { title: '   ' }), /請輸入名稱/);
    assert.equal((await q.get('SELECT title FROM material_nodes WHERE id=?', [B.section.id])).title, '1-1 數與數線');
  });

  test('別人的教材改不動', async () => {
    await assert.rejects(() => svc.updateNode(2, B.section.id, { title: '偷改' }), /找不到/);
    await assert.rejects(() => svc.updateContentItem(2, B.example.id, { title: '偷改' }), /找不到/);
  });
});

describe('改名不換 identity', () => {
  test('完成度、Plan selection、Task linkage 全部留著', async () => {
    await svc.setCompletion(USER, B.example.id, { completed: true });
    await svc.selectItems(USER, planId, [B.reading.id], true);
    await q.run(
      'INSERT INTO tasks (user_id,title,material_content_item_id,material_book_id) VALUES (?,?,?,?)',
      [USER, '舊標題', B.reading.id, B.bookId]);

    await svc.updateContentItem(USER, B.example.id, { title: '範例 一' });
    await svc.updateContentItem(USER, B.reading.id, { title: '課文' });

    // 改的是同一筆東西的名字，不是換一個東西
    const done = await q.get(
      'SELECT completed FROM material_progress WHERE user_id=? AND content_item_id=?',
      [USER, B.example.id]);
    assert.equal(Number(done.completed), 1);
    const sel = await q.get(
      'SELECT selected FROM plan_material_items WHERE user_id=? AND plan_id=? AND content_item_id=?',
      [USER, planId, B.reading.id]);
    assert.equal(Number(sel.selected), 1);
    const task = await q.get(
      'SELECT material_content_item_id FROM tasks WHERE user_id=? AND material_content_item_id=?',
      [USER, B.reading.id]);
    assert.equal(Number(task.material_content_item_id), B.reading.id);
  });
});

describe('改內容種類', () => {
  test('節底下的範例可以改成例題', async () => {
    const it = await svc.updateContentItem(USER, B.example.id, { kind: 'example_problem' });
    assert.equal(it.kind, 'example_problem');
    assert.equal(it.title, '範例', '沒有指定 title 就不動它');
  });

  test('節底下不能改成單元練習——那只屬於章', async () => {
    await assert.rejects(() => svc.updateContentItem(USER, B.example.id, { kind: 'unit_exercise' }));
    assert.equal((await q.get('SELECT kind FROM material_content_items WHERE id=?', [B.example.id])).kind, 'example');
  });

  test('章底下的單元練習不能改成範例——範例只屬於節或主題', async () => {
    await assert.rejects(() => svc.updateContentItem(USER, B.unitEx.id, { kind: 'example' }));
  });

  test('不認識的種類擋下來', async () => {
    await assert.rejects(() => svc.updateContentItem(USER, B.example.id, { kind: '講義' }), /類型不正確/);
  });
});

describe('刪除：有使用紀錄就不刪', () => {
  test('乾淨的項目刪得掉', async () => {
    await svc.deleteContentItem(USER, B.example.id);
    assert.equal(await q.get('SELECT id FROM material_content_items WHERE id=?', [B.example.id]), undefined);
  });

  test('已完成的項目不刪，而且說得出原因', async () => {
    await svc.setCompletion(USER, B.example.id, { completed: true });
    await assert.rejects(() => svc.deleteContentItem(USER, B.example.id), e => {
      assert.equal(e.status, 409);
      assert.equal(e.references.progress, 1);
      return true;
    });
    assert.ok(await q.get('SELECT id FROM material_content_items WHERE id=?', [B.example.id]));
  });

  test('被計畫選取中的項目不刪', async () => {
    await svc.selectItems(USER, planId, [B.example.id], true);
    await assert.rejects(() => svc.deleteContentItem(USER, B.example.id), e => {
      assert.equal(e.references.plan_selections, 1);
      return true;
    });
  });

  test('有任務指著的項目不刪', async () => {
    await q.run(
      'INSERT INTO tasks (user_id,title,material_content_item_id) VALUES (?,?,?)',
      [USER, '在排程裡', B.example.id]);
    await assert.rejects(() => svc.deleteContentItem(USER, B.example.id), e => {
      assert.equal(e.references.tasks, 1);
      return true;
    });
  });

  test('已刪除（垃圾桶）的任務不算數', async () => {
    await q.run(
      'INSERT INTO tasks (user_id,title,material_content_item_id,deleted) VALUES (?,?,?,1)',
      [USER, '已丟掉', B.example.id]);
    await svc.deleteContentItem(USER, B.example.id);
    assert.equal(await q.get('SELECT id FROM material_content_items WHERE id=?', [B.example.id]), undefined);
  });
});

describe('刪一整段', () => {
  test('乾淨的節連同底下的內容一起消失，不留孤兒', async () => {
    const r = await svc.deleteNode(USER, B.section.id);
    assert.equal(r.content_items, 3);
    assert.equal(await q.get('SELECT id FROM material_nodes WHERE id=?', [B.section.id]), undefined);
    const left = await q.all(
      'SELECT id FROM material_content_items WHERE user_id=? AND node_id=?', [USER, B.section.id]);
    assert.equal(left.length, 0);
  });

  test('刪整章會連節與主題一起帶走', async () => {
    const r = await svc.deleteNode(USER, B.chapter.id);
    assert.equal(r.nodes, 3, '章＋節＋主題');
    assert.equal(r.content_items, 5);
    const nodes = await q.all(
      'SELECT id FROM material_nodes WHERE user_id=? AND book_id=?', [USER, B.bookId]);
    assert.equal(nodes.length, 0);
  });

  test('底下任何一筆有紀錄，整段都不刪——不做「刪一半」', async () => {
    await svc.setCompletion(USER, B.reading.id, { completed: true });
    await assert.rejects(() => svc.deleteNode(USER, B.section.id), e => {
      assert.equal(e.status, 409);
      return true;
    });
    // 同一節底下沒有紀錄的那兩筆也必須完好
    const still = await q.all(
      'SELECT id FROM material_content_items WHERE user_id=? AND node_id=?', [USER, B.section.id]);
    assert.equal(still.length, 3);
    assert.ok(await q.get('SELECT id FROM material_nodes WHERE id=?', [B.section.id]));
  });

  test('子節點有紀錄時，刪上層的章同樣整段不刪', async () => {
    await svc.setCompletion(USER, B.reading.id, { completed: true });
    await assert.rejects(() => svc.deleteNode(USER, B.chapter.id), /使用紀錄/);
    assert.ok(await q.get('SELECT id FROM material_nodes WHERE id=?', [B.chapter.id]));
    assert.ok(await q.get('SELECT id FROM material_nodes WHERE id=?', [B.topic.id]));
  });

  test('別人的節點刪不動', async () => {
    await assert.rejects(() => svc.deleteNode(2, B.section.id), /找不到/);
    assert.ok(await q.get('SELECT id FROM material_nodes WHERE id=?', [B.section.id]));
  });
});
