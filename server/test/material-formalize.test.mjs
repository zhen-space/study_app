// 舊教材的 just-in-time 正式化。
//
// 產品契約：學生第一次真的要用這本舊教材時，確認一次「這本教材裡有哪些內容」，
// 之後它就是正式教材。學生不需要理解 legacy / migration / identity。
//
// 這一支守的界線：
//   ・legacy 教材不是「看得到但永遠不能用」的死路
//   ・ContentItem 的 kind 一律由使用者確認，系統不猜（舊資料根本沒存）
//   ・教材樹與 provenance 在同一筆交易內建立，任一步失敗全部 rollback
//   ・provenance 用來源列 id，**不是**書名比對
//   ・同一列 legacy 來源不能被正式化兩次
//   ・正式化之後 unified library 不再重複顯示 legacy 副本
//   ・legacy row 全程不被 UPDATE / DELETE

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'mfz-')), 'f.sqlite');
process.env.TURSO_DATABASE_URL = '';

const { q, initSchema } = await import('../src/db/init.js');
const svc = await import('../src/material/service.js');
const { listStudyMaterials } = await import('../src/material/library.js');
const { LEGACY_NODE_KIND } = await import('../src/material/legacy.js');

const USER = 1;
let listId = 0;

before(async () => {
  await initSchema();
  await q.run('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [USER, 'fz@test', 'x']);
  const l = await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [USER, '地科']);
  listId = Number(l.lastInsertRowid);
});

// 種一本 legacy 教材：兩章，含巢狀 Topic 與一個「焦點」
async function seedLegacyBook(book = '地科課本') {
  const ids = [];
  const chapters = [
    {
      title: '3 大氣',
      sections: [
        { title: '壹 大氣的性質', level: '節', children: [{ title: '主題1 大氣的成分', level: '主題', children: [] }] },
        { title: '焦點一 溫室效應', level: '焦點', children: [] },
      ],
    },
    { title: '4 海洋', sections: [{ title: '壹 洋流', level: '節', children: [] }] },
  ];
  for (let i = 0; i < chapters.length; i++) {
    const r = await q.run(
      `INSERT INTO toc_items (user_id,list_id,title,level,sections,order_index,book,publisher)
       VALUES (?,?,?,?,?,?,?,?)`,
      [USER, listId, chapters[i].title, '章', JSON.stringify(chapters[i].sections), i, book, '龍騰']);
    ids.push(Number(r.lastInsertRowid));
  }
  return { book, sourceRowIds: ids };
}

const counts = async () => ({
  books: Number((await q.get('SELECT COUNT(*) c FROM material_books WHERE user_id=?', [USER])).c),
  nodes: Number((await q.get('SELECT COUNT(*) c FROM material_nodes WHERE user_id=?', [USER])).c),
  items: Number((await q.get('SELECT COUNT(*) c FROM material_content_items WHERE user_id=?', [USER])).c),
  sources: Number((await q.get('SELECT COUNT(*) c FROM material_book_sources WHERE user_id=?', [USER])).c),
});

const tocSnapshot = async () =>
  JSON.stringify(await q.all('SELECT * FROM toc_items WHERE user_id=? ORDER BY id', [USER]));

// 使用者確認內容：每個節／主題勾「課本內容 + 例題」，章底勾「單元練習」
const confirmContent = draft => ({
  ...draft,
  chapters: draft.chapters.map(c => ({
    ...c,
    content_items: [{ title: '單元練習', kind: 'unit_exercise' }],
    children: c.children.map(s => ({
      ...s,
      content_items: [
        { title: '課本內容', kind: 'reading' },
        { title: '例題', kind: 'example_problem' },
      ],
    })),
  })),
});

describe('內容確認（preview）', () => {
  test('結構 deterministic 帶入，但 ContentItem 一律留空給使用者確認', async () => {
    const L = await seedLegacyBook('確認結構');
    const out = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });

    assert.equal(out.requires_content_confirmation, true);
    assert.equal(out.draft.book.title, '確認結構');
    assert.equal(out.draft.book.publisher, '龍騰');
    assert.equal(Number(out.draft.book.subject_list_id), listId);
    assert.deepEqual(out.draft.chapters.map(c => c.title), ['3 大氣', '4 海洋']);

    // ★ 每一個節點的 content_items 都是空的——舊資料沒有存內容類型，系統不猜
    for (const c of out.draft.chapters) {
      assert.deepEqual(c.content_items, [], '章的內容不得被自動猜出來');
      for (const s of c.children) {
        assert.deepEqual(s.content_items, [], '節／主題的內容不得被自動猜出來');
      }
    }
  });

  test('巢狀 Topic 攤平成與 Section 同層，不污染正式 hierarchy', async () => {
    const L = await seedLegacyBook('巢狀');
    const out = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const ch = out.draft.chapters[0];
    assert.deepEqual(ch.children.map(c => c.kind), ['section', 'topic']);
    // 正式 draft 裡的節點底下沒有再一層 children —— 不建假 Section，也不巢狀
    for (const c of ch.children) assert.equal('children' in c, false);
  });

  test('對不上正式種類的節點（焦點）不進 draft，而是如實列出', async () => {
    const L = await seedLegacyBook('焦點');
    const out = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    assert.equal(out.draft.chapters[0].children.some(c => c.title.startsWith('焦點')), false,
      '焦點不得被猜成 section 或 topic');
    assert.equal(out.unsupported_nodes.length, 1);
    assert.equal(out.unsupported_nodes[0].legacy_level, '焦點');
    assert.ok(out.unsupported_nodes[0].legacy_ref.toc_id);
  });

  test('preview 完全不寫任何東西', async () => {
    const L = await seedLegacyBook('preview 不寫');
    const before = await counts();
    const toc = await tocSnapshot();
    await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    assert.deepEqual(await counts(), before);
    assert.equal(await tocSnapshot(), toc, 'legacy row 不得被 UPDATE / DELETE');
  });

  test('使用者取消（不呼叫 commit）→ 什麼都不會發生', async () => {
    const L = await seedLegacyBook('取消');
    const before = await counts();
    const out = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    confirmContent(out.draft);       // 使用者填了，但沒有送出
    assert.deepEqual(await counts(), before, '取消不得留下半本教材');
  });
});

describe('正式化（commit）', () => {
  test('★ legacy 教材不是死路：確認後成為正式教材，拿得到正式 identity', async () => {
    const L = await seedLegacyBook('可用的舊教材');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const out = await svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot,
    });

    assert.ok(out.book.id, '必須拿到正式 material_books.id');
    assert.equal(Number(out.book.subject_list_id), listId);
    const tree = await svc.getBookTree(USER, out.book.id);
    assert.equal(tree.nodes.length, 2);
    // 正式 ContentItem 都有 stable id
    const ids = tree.nodes.flatMap(c => [
      ...c.content_items.map(i => i.id),
      ...c.children.flatMap(s => s.content_items.map(i => i.id)),
    ]);
    assert.ok(ids.length > 0);
    assert.ok(ids.every(id => Number.isInteger(id) && id > 0));
  });

  test('★ 教材樹與 provenance 同一筆交易；一個正式 Book link 多個 toc_items 列', async () => {
    const L = await seedLegacyBook('多章來源');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const out = await svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });

    const sources = await q.all(
      'SELECT * FROM material_book_sources WHERE user_id=? AND book_id=? ORDER BY source_row_id',
      [USER, out.book.id]);
    assert.equal(sources.length, L.sourceRowIds.length, '兩章 → 兩列 provenance');
    assert.deepEqual(sources.map(s => Number(s.source_row_id)).sort((a, b) => a - b),
      [...L.sourceRowIds].sort((a, b) => a - b));
    for (const s of sources) assert.equal(s.source_kind, 'legacy_toc');
  });

  test('★ provenance 用來源列 id，不含任何書名／出版社欄位', async () => {
    const cols = (await q.all('PRAGMA table_info(material_book_sources)')).map(c => c.name);
    assert.deepEqual(cols.sort(),
      ['book_id', 'created_at', 'id', 'source_kind', 'source_row_id', 'user_id'].sort());
    for (const forbidden of ['title', 'book', 'publisher', 'name']) {
      assert.equal(cols.includes(forbidden), false, `provenance 不得有 ${forbidden} 欄位`);
    }
  });

  test('★ 同一列 legacy 來源不可被重複正式化', async () => {
    const L = await seedLegacyBook('不可重複');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    await svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });

    const before = await counts();
    await assert.rejects(
      () => svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot }),
      e => e.status === 409);
    assert.deepEqual(await counts(), before, '第二次不得生出第二本重複教材');
    // preview 也要擋，讓學生不會又看到一次確認畫面
    await assert.rejects(
      () => svc.getLegacyFormalizationPreview(USER, { listId, book: L.book }),
      e => e.status === 409);
  });

  test('★ DB 層唯一鍵擋得住：直接繞過 service 也插不進第二筆', async () => {
    const L = await seedLegacyBook('唯一鍵');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const out = await svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });
    await assert.rejects(() => q.run(
      `INSERT INTO material_book_sources (user_id,book_id,source_kind,source_row_id) VALUES (?,?,?,?)`,
      [USER, out.book.id, 'legacy_toc', L.sourceRowIds[0]]), /UNIQUE|constraint/i);
  });

  test('★ Material 寫入失敗 → provenance 不存在', async () => {
    const L = await seedLegacyBook('material 失敗');
    const before = await counts();
    // title 為 null → material_content_items.title NOT NULL，在迴圈中途炸掉
    await assert.rejects(() => svc.writeDraftTree(USER, {
      book: { title: '不該留下', publisher: '', subject_list_id: listId },
      chapters: [{
        title: '第一章', order: 0,
        content_items: [{ title: null, kind: 'unit_exercise', order: 0 }],
        children: [],
      }],
    }, { sources: L.sourceRowIds.map(id => ({ source_kind: 'legacy_toc', source_row_id: id })) }));

    assert.deepEqual(await counts(), before);
    const orphan = await q.all(
      'SELECT * FROM material_book_sources WHERE user_id=? AND source_row_id IN (?,?)',
      [USER, L.sourceRowIds[0], L.sourceRowIds[1]]);
    assert.deepEqual(orphan, [], '★ 不得留下孤兒 provenance');
  });

  test('★ provenance 寫入失敗 → 整棵 Material tree rollback', async () => {
    const L = await seedLegacyBook('provenance 失敗');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    await svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });

    const before = await counts();
    // 同一批來源列再正式化一次：Material tree 會先寫，provenance 的 UNIQUE 才炸。
    // 這正是「provenance 失敗要讓已寫的教材樹一起回滾」的情況。
    await assert.rejects(() => svc.writeDraftTree(USER, {
      book: { title: '樹要回滾', publisher: '', subject_list_id: listId },
      chapters: [{
        title: '第一章', order: 0,
        content_items: [{ title: '單元練習', kind: 'unit_exercise', order: 0 }],
        children: [{ kind: 'section', title: '1-1', order: 0, content_items: [{ title: '課本內容', kind: 'reading', order: 0 }] }],
      }],
    }, { sources: [{ source_kind: 'legacy_toc', source_row_id: L.sourceRowIds[0] }] }));

    assert.deepEqual(await counts(), before, '★ provenance 失敗時教材樹必須整棵回滾');
    const ghost = await q.get(
      'SELECT id FROM material_books WHERE user_id=? AND title=?', [USER, '樹要回滾']);
    assert.equal(ghost, undefined);
  });

  test('★ 使用者填的內容有問題時整筆拒絕，不留下半本教材', async () => {
    const L = await seedLegacyBook('內容有問題');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const before = await counts();
    const bad = {
      ...pre.draft,
      chapters: pre.draft.chapters.map(c => ({
        ...c, content_items: [],
        // 單元練習被塞進節裡 → 違反 placement
        children: c.children.map(s => ({ ...s, content_items: [{ title: '單元練習', kind: 'unit_exercise' }] })),
      })),
    };
    await assert.rejects(
      () => svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: bad, sourceSnapshot: pre.source_snapshot }),
      e => e.status === 400 && Array.isArray(e.problems) && e.problems.length > 0);
    assert.deepEqual(await counts(), before);
  });

  test('legacy row 在整個正式化過程中完全沒有被改動', async () => {
    const L = await seedLegacyBook('legacy 不變');
    const toc = await tocSnapshot();
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    await svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });
    assert.equal(await tocSnapshot(), toc, '★ toc_items 不得被 UPDATE / DELETE');
  });
});

describe('Unified library 的去重', () => {
  test('★ 正式化之後不再重複顯示 legacy 副本', async () => {
    const L = await seedLegacyBook('去重');
    const beforeLib = await listStudyMaterials(USER);
    const legacyBefore = beforeLib.books.filter(b => b.source === 'legacy' && b.title === '去重');
    assert.equal(legacyBefore.length, 1, '正式化前以 legacy 身分出現一次');
    assert.equal(legacyBefore[0].requires_content_confirmation, true);

    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const out = await svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });

    const after = await listStudyMaterials(USER);
    const legacyAfter = after.books.filter(b => b.source === 'legacy' && b.title === '去重');
    assert.deepEqual(legacyAfter, [], '★ 正式化後 legacy 副本必須消失');
    const formal = after.books.filter(b => b.source === 'material' && b.material_book_id === out.book.id);
    assert.equal(formal.length, 1, '★ 只留下一本正式教材');
    assert.equal(formal[0].completion_supported, true);
  });

  test('★ 去重靠來源列 id，不是書名：同名但未正式化的另一本仍然看得到', async () => {
    const A = await seedLegacyBook('同名教材');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: A.book });
    await svc.formalizeLegacyBook(USER, { listId, book: A.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });

    // 另一個科目底下有一本**同名**的舊教材，來源列不同 → 不該被連坐隱藏
    const other = await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [USER, '物理']);
    await q.run(
      `INSERT INTO toc_items (user_id,list_id,title,level,sections,order_index,book,publisher)
       VALUES (?,?,?,?,?,?,?,?)`,
      [USER, Number(other.lastInsertRowid), '1 力學', '章', '[]', 0, '同名教材', '']);

    const lib = await listStudyMaterials(USER);
    const stillLegacy = lib.books.filter(b => b.source === 'legacy' && b.title === '同名教材');
    assert.equal(stillLegacy.length, 1, '★ 同名但不同來源列的舊教材不得被書名連坐隱藏');
  });
});

describe('正式化之後走的是正式路徑', () => {
  test('★ Plan selection 只指向正式 material_content_item_id', async () => {
    const L = await seedLegacyBook('選取');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const out = await svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });

    const plan = await q.run(
      'INSERT INTO plans (user_id,name,status) VALUES (?,?,?)', [USER, '段考', 'active']);
    const planId = Number(plan.lastInsertRowid);
    const tree = await svc.getBookTree(USER, out.book.id);
    const itemId = tree.nodes[0].children[0].content_items[0].id;

    await svc.selectItems(USER, planId, [itemId], true);
    const rows = await q.all(
      'SELECT * FROM plan_material_items WHERE user_id=? AND plan_id=?', [USER, planId]);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].content_item_id), Number(itemId));
    // 指到的必須是真的存在於 material_content_items 的列
    const real = await q.get(
      'SELECT id FROM material_content_items WHERE id=? AND user_id=?', [rows[0].content_item_id, USER]);
    assert.ok(real, '★ selection 不得指向不存在的假 ContentItem');
  });

  test('★ 正式化不產生任何 ScheduleVersion / ScheduledBlock / StudySession', async () => {
    const L = await seedLegacyBook('排程不變');
    const snap = async () => ({
      versions: Number((await q.get('SELECT COUNT(*) c FROM schedule_versions WHERE user_id=?', [USER])).c),
      blocks: Number((await q.get('SELECT COUNT(*) c FROM scheduled_blocks WHERE user_id=?', [USER])).c),
      sessions: Number((await q.get('SELECT COUNT(*) c FROM study_sessions WHERE user_id=?', [USER])).c),
      tasks: Number((await q.get('SELECT COUNT(*) c FROM tasks WHERE user_id=?', [USER])).c),
    });
    const before = await snap();
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    await svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });
    assert.deepEqual(await snap(), before, '★ 正式化不得碰任何排程資料');
  });
});

/* ============ Stale preview / source-set drift ============ */

describe('來源快照（stale preview / source drift）', () => {
  const isStale = e => e.status === 409 && e.stale === true;

  test('preview 回傳明確的來源快照：row_ids ＋ fingerprint', async () => {
    const L = await seedLegacyBook('快照格式');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const snap = pre.source_snapshot;
    assert.equal(snap.source_kind, 'legacy_toc');
    assert.deepEqual(snap.row_ids, [...L.sourceRowIds].sort((a, b) => a - b));
    assert.equal(typeof snap.fingerprint, 'string');
    assert.equal(snap.fingerprint.length, 64, 'sha256 hex');
    assert.equal(Number(snap.list_id), listId);
    assert.equal(snap.book, L.book);
  });

  test('★ preview [A,B]，commit 前新增 C → 409，零 Material / provenance', async () => {
    const L = await seedLegacyBook('新增 C');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const before = await counts();

    // 使用者還在確認內容時，同一本書多了一章
    const c = await q.run(
      `INSERT INTO toc_items (user_id,list_id,title,level,sections,order_index,book,publisher)
       VALUES (?,?,?,?,?,?,?,?)`,
      [USER, listId, '5 新增的一章', '章', '[]', 9, L.book, '龍騰']);

    await assert.rejects(() => svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot,
    }), isStale);

    assert.deepEqual(await counts(), before, '★ 不得留下任何 Material 或 provenance');
    // ★ 最關鍵：新增的那一列絕不能被標成已正式化
    const marked = await q.get(
      'SELECT id FROM material_book_sources WHERE user_id=? AND source_row_id=?',
      [USER, Number(c.lastInsertRowid)]);
    assert.equal(marked, undefined, '★ 使用者沒看過的來源列不得進 provenance');
  });

  test('★ preview [A,B]，commit 前刪除 B → 409', async () => {
    const L = await seedLegacyBook('刪除 B');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const before = await counts();
    await q.run('DELETE FROM toc_items WHERE id=?', [L.sourceRowIds[1]]);

    await assert.rejects(() => svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot,
    }), isStale);
    assert.deepEqual(await counts(), before);
  });

  test('★ commit 前改動 sections（結構變了）→ 409', async () => {
    const L = await seedLegacyBook('改 sections');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const before = await counts();
    await q.run('UPDATE toc_items SET sections=? WHERE id=?',
      [JSON.stringify([{ title: '換掉的節', level: '節', children: [] }]), L.sourceRowIds[0]]);

    await assert.rejects(() => svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot,
    }), isStale);
    assert.deepEqual(await counts(), before);
  });

  test('★ commit 前改動章名 → 409', async () => {
    const L = await seedLegacyBook('改章名');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    await q.run('UPDATE toc_items SET title=? WHERE id=?', ['改過的章名', L.sourceRowIds[0]]);
    await assert.rejects(() => svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot,
    }), isStale);
  });

  test('★ commit 前改動出版社 → 409（會影響 draft，必須算進指紋）', async () => {
    const L = await seedLegacyBook('改出版社');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    assert.equal(pre.draft.book.publisher, '龍騰');
    await q.run('UPDATE toc_items SET publisher=? WHERE id=?', ['換一家', L.sourceRowIds[0]]);
    await assert.rejects(() => svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot,
    }), isStale);
  });

  test('★ commit 前改動順序 → 409', async () => {
    const L = await seedLegacyBook('改順序');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    await q.run('UPDATE toc_items SET order_index=? WHERE id=?', [99, L.sourceRowIds[0]]);
    await assert.rejects(() => svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot,
    }), isStale);
  });

  test('★ row_ids 被竄改成別人的列 → 拒絕', async () => {
    const L = await seedLegacyBook('跨帳號竄改');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const before = await counts();

    // 另一個帳號的 legacy 列
    const other = await q.run('INSERT INTO users (email,password_hash) VALUES (?,?)', ['other@t', 'x']);
    const otherUser = Number(other.lastInsertRowid);
    const otherList = await q.run('INSERT INTO lists (user_id,name) VALUES (?,?)', [otherUser, '別人的科目']);
    const otherRow = await q.run(
      `INSERT INTO toc_items (user_id,list_id,title,level,sections,order_index,book,publisher)
       VALUES (?,?,?,?,?,?,?,?)`,
      [otherUser, Number(otherList.lastInsertRowid), '別人的章', '章', '[]', 0, '別人的書', '']);

    await assert.rejects(() => svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft),
      sourceSnapshot: { ...pre.source_snapshot, row_ids: [...pre.source_snapshot.row_ids, Number(otherRow.lastInsertRowid)] },
    }), e => e.status === 409);

    assert.deepEqual(await counts(), before);
    const leaked = await q.get(
      'SELECT id FROM material_book_sources WHERE source_row_id=?', [Number(otherRow.lastInsertRowid)]);
    assert.equal(leaked, undefined, '★ 別人的來源列不得被寫進 provenance');
  });

  test('★ 缺少來源快照時直接拒絕，不用 list_id + book 重新決定來源', async () => {
    const L = await seedLegacyBook('沒有快照');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const before = await counts();
    await assert.rejects(
      () => svc.formalizeLegacyBook(USER, { listId, book: L.book, draft: confirmContent(pre.draft) }),
      e => e.status === 400);
    assert.deepEqual(await counts(), before);
  });

  test('★ snapshot 裡已被正式化的列 → 409', async () => {
    const L = await seedLegacyBook('已正式化');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    await svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });
    const before = await counts();
    await assert.rejects(() => svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot,
    }), e => e.status === 409);
    assert.deepEqual(await counts(), before);
  });

  test('★ 完全一致的 snapshot → atomic success，provenance 只含快照裡的列', async () => {
    const L = await seedLegacyBook('一致');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    const out = await svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot });
    const sources = await q.all(
      'SELECT source_row_id FROM material_book_sources WHERE user_id=? AND book_id=?',
      [USER, out.book.id]);
    assert.deepEqual(sources.map(s => Number(s.source_row_id)).sort((a, b) => a - b),
      pre.source_snapshot.row_ids);
  });

  test('★ stale 失敗之後 legacy row 本身仍未被改動，而且可以重新 preview 再來一次', async () => {
    const L = await seedLegacyBook('重來');
    const pre = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    await q.run(
      `INSERT INTO toc_items (user_id,list_id,title,level,sections,order_index,book,publisher)
       VALUES (?,?,?,?,?,?,?,?)`,
      [USER, listId, '插進來的一章', '章', '[]', 9, L.book, '龍騰']);
    await assert.rejects(() => svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre.draft), sourceSnapshot: pre.source_snapshot,
    }), isStale);

    // 重新 preview（拿到新的快照）之後可以正常完成——不是死路，也沒有自動 retry
    const toc = await tocSnapshot();
    const pre2 = await svc.getLegacyFormalizationPreview(USER, { listId, book: L.book });
    assert.notEqual(pre2.source_snapshot.fingerprint, pre.source_snapshot.fingerprint);
    assert.equal(pre2.source_snapshot.row_ids.length, 3);
    const out = await svc.formalizeLegacyBook(USER, {
      listId, book: L.book, draft: confirmContent(pre2.draft), sourceSnapshot: pre2.source_snapshot });
    assert.ok(out.book.id);
    assert.equal(await tocSnapshot(), toc, '★ legacy row 全程不被 UPDATE / DELETE');
  });
});

describe('來源快照的授權邊界', () => {
  test('★ snapshot 與 listId/book 參數不一致時，寫入的是 snapshot 描述的那一組', async () => {
    // 兩本不同的舊教材。使用者確認的是 A，但呼叫端把參數指到 B。
    // commit 必須以 snapshot（A）為準，絕不能改成寫 B 的來源列。
    const A = await seedLegacyBook('參數 A');
    const B = await seedLegacyBook('參數 B');
    const preA = await svc.getLegacyFormalizationPreview(USER, { listId, book: A.book });

    const out = await svc.formalizeLegacyBook(USER, {
      listId, book: B.book,                       // ← 參數指到 B
      draft: confirmContent(preA.draft),
      sourceSnapshot: preA.source_snapshot,       // ← 但使用者確認的是 A
    });

    const written = (await q.all(
      'SELECT source_row_id FROM material_book_sources WHERE user_id=? AND book_id=?',
      [USER, out.book.id])).map(r => Number(r.source_row_id)).sort((a, b) => a - b);
    assert.deepEqual(written, [...A.sourceRowIds].sort((a, b) => a - b),
      '★ 必須寫 snapshot（A）的來源列');
    for (const id of B.sourceRowIds) {
      assert.equal(written.includes(id), false, '★ 不得因為參數而把 B 的來源列吃進去');
    }
    // B 仍然是可以正式化的舊教材，沒有被連坐標記
    const preB = await svc.getLegacyFormalizationPreview(USER, { listId, book: B.book });
    assert.deepEqual(preB.source_snapshot.row_ids, [...B.sourceRowIds].sort((a, b) => a - b));
  });
});
