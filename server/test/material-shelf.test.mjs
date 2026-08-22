// 統一教材書櫃（GET /study-materials?shelf=1）。
//
// 學生的第 1 步一眼只需要「有哪些教材」。走完整的 unified library 會為了畫一份
// 書單把每一本的完整教材樹都建起來——教材一多就是 N 次全樹查詢。
//
// 這一支守的界線：
//   ・書櫃裡正式教材與尚未確認內容的教材是同一份清單、同一個形狀
//   ・identity 仍然分得清楚：正式的有 material_book_id，另一種只有來源座標
//   ・已經確認過內容的來源列不再以另一本教材的身分出現（不會變成兩本）
//   ・尚未確認內容的教材不給 progress，也不捏造 0%
//   ・selected_count 只算「已選且尚未完成」，而且只跟指定的那個 Plan 有關
//   ・書櫃內容與完整 library 一致：不是第二套 truth

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'mshelf-')), 's.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const svc = await import('../src/material/service.js');
const { listStudyMaterials, listStudyMaterialShelf } = await import('../src/material/library.js');

const USER = 1;
const OTHER = 2;
let listId = 0;
let planId = 0;
let bookId = 0;
let itemIds = [];

before(async () => {
  await initSchema();
  for (const [id, email] of [[USER, 'a@test'], [OTHER, 'b@test']]) {
    await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [id, email, 'x']);
  }
  const l = await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [USER, '數學']);
  listId = Number(l.lastInsertRowid);
  const p = await q.run('INSERT INTO plans (user_id,name) VALUES (?,?)', [USER, '第一次段考']);
  planId = Number(p.lastInsertRowid);

  // 一本正式教材：一章一節，節底下三種內容
  const out = await svc.commitMaterialDraft(USER, {
    book: { title: '新大滿貫數學 2', publisher: '龍騰', subject_list_id: listId },
    chapters: [{
      title: '第 1 章 數與式',
      content_items: [{ kind: 'unit_exercise', title: '單元練習' }],
      children: [{
        kind: 'section',
        title: '1-1 數與數線',
        content_items: [
          { kind: 'reading', title: '課本內容' },
          { kind: 'example', title: '範例' },
          { kind: 'example_problem', title: '例題' },
        ],
      }],
    }],
  });
  bookId = out.book.id;
  const rows = await q.all(
    'SELECT id,kind FROM material_content_items WHERE user_id=? AND book_id=? ORDER BY id', [USER, bookId]);
  itemIds = rows.map(r => r.id);

  // 一本還沒確認過內容的舊教材
  await q.run(
    `INSERT INTO toc_items (user_id,list_id,title,level,sections,order_index,book,publisher)
     VALUES (?,?,?,?,?,?,?,?)`,
    [USER, listId, '第 1 章 三角', '章',
      JSON.stringify([{ title: '1-1 正弦', level: '節', children: [] }]), 0, '舊講義', '翰林']);
  // 別人的資料：一列都不該出現
  await q.run(
    `INSERT INTO toc_items (user_id,list_id,title,level,sections,order_index,book)
     VALUES (?,?,?,?,?,?,?)`,
    [OTHER, listId, '別人的章', '章', '[]', 0, '別人的書']);
});

const byTitle = (books, t) => books.find(b => b.title === t);

describe('統一書櫃', () => {
  test('正式教材與尚未確認內容的教材在同一份清單、同一個形狀', async () => {
    const { books, counts } = await listStudyMaterialShelf(USER);
    assert.equal(books.length, 2);
    assert.deepEqual(counts, { material: 1, legacy: 1 });
    // 兩者都有的欄位：學生端畫面只需要認識這一種形狀
    for (const b of books) {
      for (const k of ['source', 'title', 'publisher', 'subject_list_id',
        'completion_supported', 'requires_content_confirmation', 'selectable', 'chapter_count']) {
        assert.ok(k in b, `${b.title} 缺少 ${k}`);
      }
    }
  });

  test('identity 分得清楚：正式教材才有 material_book_id，另一種只有來源座標', async () => {
    const { books } = await listStudyMaterialShelf(USER);
    const formal = byTitle(books, '新大滿貫數學 2');
    const pending = byTitle(books, '舊講義');
    assert.equal(formal.material_book_id, bookId);
    assert.equal(formal.legacy_ref, undefined);
    assert.equal(pending.material_book_id, undefined);
    assert.deepEqual(pending.legacy_ref, { list_id: listId, book: '舊講義' });
  });

  test('尚未確認內容的教材不給 progress，也不捏造 0%', async () => {
    const { books } = await listStudyMaterialShelf(USER);
    const pending = byTitle(books, '舊講義');
    assert.equal(pending.progress, undefined);
    assert.equal(pending.completion_supported, false);
    assert.equal(pending.requires_content_confirmation, true);
    assert.equal(pending.selectable, false);
  });

  test('正式教材帶真正的進度與章數', async () => {
    const { books } = await listStudyMaterialShelf(USER);
    const formal = byTitle(books, '新大滿貫數學 2');
    assert.equal(formal.progress.total_items, 4);
    assert.equal(formal.chapter_count, 1);
    assert.equal(formal.completion_supported, true);
    assert.equal(formal.requires_content_confirmation, false);
  });

  test('只看得到自己的教材', async () => {
    const { books } = await listStudyMaterialShelf(USER);
    assert.equal(books.some(b => b.title === '別人的書'), false);
  });

  test('書櫃與完整 library 是同一份事實，不是第二套 truth', async () => {
    const shelf = await listStudyMaterialShelf(USER);
    const full = await listStudyMaterials(USER);
    assert.deepEqual(
      shelf.books.map(b => [b.source, b.title]).sort(),
      full.books.map(b => [b.source, b.title]).sort());
    assert.deepEqual(shelf.counts, full.counts);
  });
});

describe('這次選了幾項', () => {
  test('沒帶 plan_id 時一律是 0——書櫃不猜是哪個計畫', async () => {
    const { books } = await listStudyMaterialShelf(USER);
    assert.equal(byTitle(books, '新大滿貫數學 2').selected_count, 0);
  });

  test('帶 plan_id 時只算這個 Plan 已選且尚未完成的項目', async () => {
    await svc.selectItems(USER, planId, itemIds.slice(0, 3), true);
    let { books } = await listStudyMaterialShelf(USER, { planId });
    assert.equal(byTitle(books, '新大滿貫數學 2').selected_count, 3);

    // 其中一項在教材層被標成完成 → 這次要讀的份量少一項，但選取本身沒有被動到
    await svc.setCompletion(USER, itemIds[0], { completed: true });
    ({ books } = await listStudyMaterialShelf(USER, { planId }));
    assert.equal(byTitle(books, '新大滿貫數學 2').selected_count, 2);
    const sel = await svc.getPlanSelection(USER, planId);
    assert.equal(sel.filter(r => r.selected).length, 3);
  });

  test('別的 Plan 的選取不會算進來', async () => {
    const p2 = Number((await q.run('INSERT INTO plans (user_id,name) VALUES (?,?)',
      [USER, '另一個計畫'])).lastInsertRowid);
    const { books } = await listStudyMaterialShelf(USER, { planId: p2 });
    assert.equal(byTitle(books, '新大滿貫數學 2').selected_count, 0);
  });
});

describe('確認過內容之後', () => {
  test('同一本教材不會同時以兩種身分出現在書櫃裡', async () => {
    const before2 = await listStudyMaterialShelf(USER);
    assert.equal(before2.books.filter(b => b.title === '舊講義').length, 1);

    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: '舊講義' });
    const draft = {
      ...pre.draft,
      chapters: pre.draft.chapters.map(c => ({
        ...c,
        children: c.children.map(s => ({
          ...s, content_items: [{ kind: 'reading', title: '課本內容' }],
        })),
      })),
    };
    await svc.formalizeLegacyBook(USER, {
      listId, book: '舊講義', draft, sourceSnapshot: pre.source_snapshot,
    });

    const after = await listStudyMaterialShelf(USER);
    const same = after.books.filter(b => b.title === '舊講義');
    assert.equal(same.length, 1, '確認之後仍然只有一本');
    assert.equal(same[0].source, 'material');
    assert.equal(same[0].requires_content_confirmation, false);
    assert.ok(same[0].material_book_id > 0);
    assert.equal(after.counts.legacy, 0);
  });

  test('來源列一列都沒有被 UPDATE 或 DELETE', async () => {
    const rows = await q.all(
      'SELECT title, sections FROM toc_items WHERE user_id=? AND book=?', [USER, '舊講義']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, '第 1 章 三角');
    assert.deepEqual(JSON.parse(rows[0].sections),
      [{ title: '1-1 正弦', level: '節', children: [] }]);
  });
});

describe('整本教材的快速選取', () => {
  // 一支 API 一次算完。前端不該為了「全選節」對每一章各打一次。
  let quickPlan = 0;
  let quickBook = 0;
  let byKind = {};

  before(async () => {
    quickPlan = Number((await q.run('INSERT INTO plans (user_id,name) VALUES (?,?)',
      [USER, '快速選取'])).lastInsertRowid);
    const out = await svc.commitMaterialDraft(USER, {
      book: { title: '快速選取用書', subject_list_id: listId },
      chapters: [1, 2, 3].map(c => ({
        title: `第 ${c} 章`,
        content_items: [{ kind: 'unit_exercise', title: '單元練習' }],
        children: [
          { kind: 'section', title: `${c}-1`, content_items: [{ kind: 'reading', title: '課本內容' }] },
          { kind: 'topic', title: `主題 ${c}`, content_items: [{ kind: 'example_problem', title: '例題' }] },
        ],
      })),
    });
    quickBook = out.book.id;
    const rows = await q.all(
      `SELECT i.id, n.kind FROM material_content_items i
         JOIN material_nodes n ON n.id=i.node_id
        WHERE i.user_id=? AND i.book_id=?`, [USER, quickBook]);
    byKind = rows.reduce((m, r) => { (m[r.kind] = m[r.kind] || []).push(r.id); return m; }, {});
  });

  const selectedIds = async () => (await q.all(
    `SELECT content_item_id FROM plan_material_items
      WHERE user_id=? AND plan_id=? AND selected=1`, [USER, quickPlan]))
    .map(r => Number(r.content_item_id)).sort((a, b) => a - b);

  test('只選「節」底下的內容，章與主題不受影響', async () => {
    await svc.selectBookNodes(USER, quickPlan, quickBook, { selected: true, nodeKinds: ['section'] });
    assert.deepEqual(await selectedIds(), [...byKind.section].sort((a, b) => a - b));
  });

  test('只選「主題」底下的內容', async () => {
    await svc.selectBookNodes(USER, quickPlan, quickBook, { selected: false });   // 先清空
    await svc.selectBookNodes(USER, quickPlan, quickBook, { selected: true, nodeKinds: ['topic'] });
    assert.deepEqual(await selectedIds(), [...byKind.topic].sort((a, b) => a - b));
  });

  test('不指定種類＝整本，章直屬的單元練習也算進來', async () => {
    await svc.selectBookNodes(USER, quickPlan, quickBook, { selected: false });
    await svc.selectBookNodes(USER, quickPlan, quickBook, { selected: true });
    const all = [...byKind.chapter, ...byKind.section, ...byKind.topic].sort((a, b) => a - b);
    assert.deepEqual(await selectedIds(), all);
  });

  test('清除把整本的選取拿掉', async () => {
    await svc.selectBookNodes(USER, quickPlan, quickBook, { selected: true });
    await svc.selectBookNodes(USER, quickPlan, quickBook, { selected: false });
    assert.deepEqual(await selectedIds(), []);
  });

  test('已完成的項目不會被全選重新選起來', async () => {
    await svc.selectBookNodes(USER, quickPlan, quickBook, { selected: false });
    const done = byKind.section[0];
    await svc.setCompletion(USER, done, { completed: true });
    await svc.selectBookNodes(USER, quickPlan, quickBook, { selected: true });
    const sel = await selectedIds();
    assert.equal(sel.includes(done), false, '已完成的不該被重新選取');
    // 而且它的完成度沒有被動到
    const p = await q.get(
      'SELECT completed FROM material_progress WHERE user_id=? AND content_item_id=?', [USER, done]);
    assert.equal(Number(p.completed), 1);
    await svc.setCompletion(USER, done, { completed: false });
  });

  test('教材裡沒有那一層時回空結果，不是錯誤', async () => {
    const flat = await svc.commitMaterialDraft(USER, {
      book: { title: '只有章的書', subject_list_id: listId },
      chapters: [{ title: '第 1 章', content_items: [{ kind: 'past_exam', title: '歷屆試題' }], children: [] }],
    });
    const r = await svc.selectBookNodes(USER, quickPlan, flat.book.id,
      { selected: true, nodeKinds: ['topic'] });
    assert.deepEqual(r.selected, []);
    assert.deepEqual(r.task_exits, { cancelled: [], blocked: [] });
  });

  test('別人的教材動不了', async () => {
    await assert.rejects(
      () => svc.selectBookNodes(OTHER, quickPlan, quickBook, { selected: true }), /找不到/);
  });
});
