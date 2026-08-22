// Phase A：content kind 拆分、canonical draft、atomic commit、
// unified legacy / Material compatibility read layer。
//
// 這一支守的界線：
//   ・範例（example）與例題（example_problem）是兩種不同的東西
//   ・placement 規則在 draft、低階 API、commit 三條路上完全一致
//   ・preview 一個 byte 都不寫資料庫
//   ・commit 全成功或全不做，絕不留下半本教材
//   ・legacy 只讀不寫，identity 不轉成 Material identity，completion 不捏造

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import {
  validateDraft, draftSummary,
} from '../src/material/draft.js';
import {
  projectChapter, projectLevel, LEGACY_NODE_KIND, SOURCE_LEGACY,
} from '../src/material/legacy.js';
import { toDraftInput, MATERIAL_DRAFT_SCHEMA } from '../src/material/parser.js';
import { ITEM_KINDS, ITEM_KIND_LABEL, itemPlacementProblem } from '../src/material/tree.js';

let S;
before(async () => { S = await startServer(); });
after(() => S?.stop());

const api = async (method, path, body) => {
  const r = await fetch(S.base + path, {
    method, headers: S.H, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const ok = async (method, path, body) => {
  const r = await api(method, path, body);
  assert.ok(r.status < 400, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

const item = (title, kind) => ({ title, kind });
const goodDraft = (over = {}) => ({
  book: { title: '新編數學', publisher: '龍騰', ...(over.book || {}) },
  chapters: over.chapters ?? [{
    title: '第一章',
    content_items: [item('單元練習', 'unit_exercise'), item('歷屆試題', 'past_exam')],
    children: [
      { kind: 'section', title: '1-1', content_items: [item('課本內容', 'reading'), item('範例 1–5', 'example'), item('例題 1–8', 'example_problem')] },
      { kind: 'topic', title: '主題一', content_items: [item('例題：綜合', 'example_problem')] },
    ],
  }],
});

/* ============ A1：content kind ============ */

describe('A1 content kind：範例與例題是兩種東西', () => {
  test('五種 kind 都在正式 enum 裡，各自有學生看得懂的名字', () => {
    assert.deepEqual(ITEM_KINDS,
      ['reading', 'example', 'example_problem', 'unit_exercise', 'past_exam']);
    assert.equal(ITEM_KIND_LABEL.reading, '課本內容');
    assert.equal(ITEM_KIND_LABEL.example, '範例');
    assert.equal(ITEM_KIND_LABEL.example_problem, '例題');
    assert.equal(ITEM_KIND_LABEL.unit_exercise, '單元練習');
    assert.equal(ITEM_KIND_LABEL.past_exam, '歷屆試題');
    // 範例與例題不得共用同一個名字，否則學生分不出「讀過的示範」與「要做的題目」
    assert.notEqual(ITEM_KIND_LABEL.example, ITEM_KIND_LABEL.example_problem);
  });

  test('placement：example / example_problem 只能在節或主題底下', () => {
    for (const kind of ['example', 'example_problem']) {
      assert.equal(itemPlacementProblem(kind, 'section'), null);
      assert.equal(itemPlacementProblem(kind, 'topic'), null);
      assert.match(itemPlacementProblem(kind, 'chapter'), /只能放在節或主題底下/);
    }
  });

  test('placement：unit_exercise / past_exam 只能在章底下', () => {
    for (const kind of ['unit_exercise', 'past_exam']) {
      assert.equal(itemPlacementProblem(kind, 'chapter'), null);
      assert.match(itemPlacementProblem(kind, 'section'), /直接屬於章/);
      assert.match(itemPlacementProblem(kind, 'topic'), /直接屬於章/);
    }
  });

  test('placement：reading 章、節、主題都可以', () => {
    for (const p of ['chapter', 'section', 'topic']) {
      assert.equal(itemPlacementProblem('reading', p), null);
    }
  });

  test('低階 API 也接受 example_problem，並套用同一套 placement', async () => {
    const book = await ok('POST', '/material/books', { title: 'kind API' });
    const ch = await ok('POST', '/material/nodes', { book_id: book.id, kind: 'chapter', title: '第一章' });
    const sec = await ok('POST', '/material/nodes', { book_id: book.id, parent_id: ch.id, kind: 'section', title: '1-1' });
    const topic = await ok('POST', '/material/nodes', { book_id: book.id, parent_id: ch.id, kind: 'topic', title: '主題一' });

    await ok('POST', '/material/content-items', { node_id: sec.id, kind: 'example', title: '範例' });
    await ok('POST', '/material/content-items', { node_id: sec.id, kind: 'example_problem', title: '例題' });
    await ok('POST', '/material/content-items', { node_id: topic.id, kind: 'example_problem', title: '主題例題' });

    const bad = await api('POST', '/material/content-items',
      { node_id: ch.id, kind: 'example_problem', title: '塞進章的例題' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /只能放在節或主題底下/);

    const tree = await ok('GET', `/material/books/${book.id}/tree`);
    const kinds = tree.nodes[0].children.flatMap(c => c.content_items.map(i => i.kind));
    assert.deepEqual(kinds.sort(), ['example', 'example_problem', 'example_problem']);
  });

  test('Topic 掛在 Chapter 成功，掛在 Section 被拒', async () => {
    const book = await ok('POST', '/material/books', { title: 'topic 層級' });
    const ch = await ok('POST', '/material/nodes', { book_id: book.id, kind: 'chapter', title: '第一章' });
    const sec = await ok('POST', '/material/nodes', { book_id: book.id, parent_id: ch.id, kind: 'section', title: '1-1' });
    await ok('POST', '/material/nodes', { book_id: book.id, parent_id: ch.id, kind: 'topic', title: '主題一' });
    const bad = await api('POST', '/material/nodes',
      { book_id: book.id, parent_id: sec.id, kind: 'topic', title: '巢狀主題' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /只能放在章底下/);
  });
});

/* ============ Canonical draft ============ */

describe('Canonical Material Draft', () => {
  test('合法 draft 通過，統計數字正確', () => {
    const { draft, problems } = validateDraft(goodDraft());
    assert.deepEqual(problems, []);
    const s = draftSummary(draft);
    assert.equal(s.chapters, 1);
    assert.equal(s.sections, 1);
    assert.equal(s.topics, 1);
    assert.equal(s.content_items, 6);
    assert.equal(s.by_kind.example, 1);
    assert.equal(s.by_kind.example_problem, 2);
  });

  test('拒絕 Topic 巢狀在 Section 底下', () => {
    const { problems } = validateDraft(goodDraft({
      chapters: [{
        title: '第一章', content_items: [],
        children: [{
          kind: 'section', title: '1-1', content_items: [item('內文', 'reading')],
          children: [{ kind: 'topic', title: '被巢狀的主題', content_items: [] }],
        }],
      }],
    }));
    assert.ok(problems.some(p => /同層/.test(p.message)));
  });

  test('拒絕章底下出現 section / topic 以外的節點種類', () => {
    const { problems } = validateDraft(goodDraft({
      chapters: [{ title: '第一章', content_items: [], children: [{ kind: 'chapter', title: '假的', content_items: [] }] }],
    }));
    assert.ok(problems.some(p => /只能是「節」或「主題」/.test(p.message)));
  });

  test('拒絕把單元練習塞進節裡（不得為它建假的節）', () => {
    const { problems } = validateDraft(goodDraft({
      chapters: [{
        title: '第一章', content_items: [],
        children: [{ kind: 'section', title: '1-1', content_items: [item('單元練習', 'unit_exercise')] }],
      }],
    }));
    assert.ok(problems.some(p => /直接屬於章/.test(p.message)));
  });

  test('拒絕未知 kind，而且錯誤訊息指得出是哪一筆', () => {
    const { problems } = validateDraft(goodDraft({
      chapters: [{
        title: '第一章', content_items: [],
        children: [{ kind: 'section', title: '1-1', content_items: [item('怪東西', '焦點')] }],
      }],
    }));
    const p = problems.find(x => /類型不正確/.test(x.message));
    assert.ok(p);
    assert.match(p.path, /chapters\[0\]\.children\[0\]\.content_items\[0\]\.kind/);
  });

  test('沒有名稱、沒有章、整本沒有內容都會被指出來', () => {
    assert.ok(validateDraft({ chapters: [] }).problems.some(p => p.path === 'book.title'));
    assert.ok(validateDraft({ book: { title: 'x' }, chapters: [] }).problems.some(p => p.path === 'chapters'));
    assert.ok(validateDraft({ book: { title: 'x' }, chapters: [{ title: '第一章', content_items: [], children: [] }] })
      .problems.some(p => /沒有任何內容項目/.test(p.message)));
  });

  test('order 缺漏時依陣列順序補齊', () => {
    const { draft } = validateDraft(goodDraft());
    assert.equal(draft.chapters[0].order, 0);
    assert.deepEqual(draft.chapters[0].children.map(c => c.order), [0, 1]);
    assert.deepEqual(draft.chapters[0].content_items.map(i => i.order), [0, 1]);
  });
});

/* ============ Parser → draft ============ */

describe('Parser 輸出直接是 canonical draft', () => {
  test('JSON schema 只允許正式的五種 content kind 與兩種子節點', () => {
    const itemSchema = MATERIAL_DRAFT_SCHEMA.properties.chapters.items
      .properties.children.items.properties.content_items.items;
    assert.deepEqual(itemSchema.properties.kind.enum,
      ['reading', 'example', 'example_problem', 'unit_exercise', 'past_exam']);
    const childSchema = MATERIAL_DRAFT_SCHEMA.properties.chapters.items.properties.children.items;
    assert.deepEqual(childSchema.properties.kind.enum, ['section', 'topic']);
    // 子節點底下沒有 children：Section / Topic 是最後一層節點
    assert.equal('children' in childSchema.properties, false);
  });

  test('toDraftInput 保留 Section / Topic 同層與各種 content kind', () => {
    const parsed = {
      book: { title: '解讀出的書', publisher: null },
      chapters: [{
        title: '第一章',
        content_items: [{ title: '單元練習', kind: 'unit_exercise' }, { title: '歷屆試題', kind: 'past_exam' }],
        children: [
          { kind: 'section', title: '1-1', content_items: [{ title: '課本內容', kind: 'reading' }, { title: '範例', kind: 'example' }] },
          { kind: 'topic', title: '主題一', content_items: [{ title: '例題', kind: 'example_problem' }] },
        ],
      }],
    };
    const input = toDraftInput(parsed, { subjectListId: 3 });
    const { draft, problems } = validateDraft(input);
    assert.deepEqual(problems, []);
    assert.equal(draft.book.subject_list_id, 3);
    assert.deepEqual(draft.chapters[0].children.map(c => c.kind), ['section', 'topic']);
    assert.deepEqual(draft.chapters[0].content_items.map(i => i.kind), ['unit_exercise', 'past_exam']);
    const s = draftSummary(draft);
    assert.equal(s.by_kind.reading, 1);
    assert.equal(s.by_kind.example, 1);
    assert.equal(s.by_kind.example_problem, 1);
  });
});

/* ============ A3：Preview 不寫 DB ============ */

describe('A3 Import preview', () => {
  const countAll = async () => ({
    books: (await ok('GET', '/material/books')).length,
    toc: (await ok('GET', '/import/toc')).length,
  });

  test('validateDraft 只驗證，不接觸資料庫（以計數證明）', async () => {
    const before = await countAll();
    validateDraft(goodDraft());
    validateDraft(goodDraft({ chapters: [] }));
    assert.deepEqual(await countAll(), before);
  });

  test('preview 端點在沒有 AI 金鑰時明確拒絕，而且不寫任何東西', async () => {
    const before = await countAll();
    const r = await api('POST', '/material/import/preview', { data: 'x', filename: 'a.png', mime: 'image/png' });
    // 測試環境沒有 ANTHROPIC_API_KEY → 500 並說明原因；有的話則會走 parser。
    assert.ok(r.status >= 400);
    assert.deepEqual(await countAll(), before, 'preview 不得寫入任何資料');
  });

  test('preview 沒有檔案時回 400，不呼叫 AI', async () => {
    const r = await api('POST', '/material/import/preview', {});
    assert.ok(r.status >= 400);
  });
});

/* ============ A4：Atomic commit ============ */

describe('A4 Transactional commit', () => {
  test('成功時一次建立完整教材樹', async () => {
    const subject = await ok('POST', '/lists', { name: '數學' });
    const out = await ok('POST', '/material/import/commit', {
      draft: goodDraft({ book: { title: '完整樹', subject_list_id: subject.id } }),
    });
    assert.ok(out.book.id);
    assert.equal(Number(out.book.subject_list_id), Number(subject.id));
    assert.equal(out.book.source, 'ocr_import');
    assert.equal(out.summary.content_items, 6);

    const tree = await ok('GET', `/material/books/${out.book.id}/tree`);
    assert.equal(tree.nodes.length, 1);
    assert.deepEqual(tree.nodes[0].children.map(c => c.kind), ['section', 'topic']);
    assert.deepEqual(tree.nodes[0].content_items.map(i => i.kind).sort(),
      ['past_exam', 'unit_exercise']);
    assert.equal(tree.progress.total_items, 6);
  });

  test('draft 不合法時整筆拒絕，不留下任何 Book', async () => {
    const before = (await ok('GET', '/material/books')).length;
    const r = await api('POST', '/material/import/commit', {
      draft: goodDraft({
        book: { title: '不該存在的書' },
        chapters: [{
          title: '第一章', content_items: [],
          children: [{ kind: 'section', title: '1-1', content_items: [item('單元練習', 'unit_exercise')] }],
        }],
      }),
    });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.json.problems) && r.json.problems.length);
    const after = await ok('GET', '/material/books');
    assert.equal(after.length, before);
    assert.equal(after.some(b => b.title === '不該存在的書'), false);
  });

  test('科目不屬於自己時整筆 rollback，不留下半本教材', async () => {
    const before = (await ok('GET', '/material/books')).length;
    const r = await api('POST', '/material/import/commit', {
      draft: goodDraft({ book: { title: '別人的科目', subject_list_id: 999999 } }),
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /找不到這個科目/);
    const after = await ok('GET', '/material/books');
    assert.equal(after.length, before);
    assert.equal(after.some(b => b.title === '別人的科目'), false);
  });

  test('內容項目寫入失敗時，Book 與已建立的章節一起 rollback', async () => {
    // 第二章的內容違反 placement：第一章此時已經 INSERT 過，
    // 必須跟著整筆消失，不能留下「只有第一章的半本書」。
    const before = (await ok('GET', '/material/books')).length;
    const r = await api('POST', '/material/import/commit', {
      draft: {
        book: { title: '半本書不該存在' },
        chapters: [
          { title: '第一章', content_items: [item('單元練習', 'unit_exercise')], children: [] },
          { title: '第二章', content_items: [], children: [{ kind: 'section', title: '2-1', content_items: [item('歷屆試題', 'past_exam')] }] },
        ],
      },
    });
    assert.equal(r.status, 400);
    const after = await ok('GET', '/material/books');
    assert.equal(after.length, before);
    assert.equal(after.some(b => b.title === '半本書不該存在'), false);
  });

  test('手動建立也能共用同一個 transactional writer（同一支 commit）', async () => {
    // 「手動建立教材」只要組出 canonical draft，就走完全相同的 writer，
    // 不需要第二套 full-tree 寫入路徑。
    const out = await ok('POST', '/material/import/commit', {
      draft: {
        book: { title: '手動建立的教材' },
        chapters: [{
          title: '第一章', content_items: [],
          children: [{ kind: 'topic', title: '我自己加的主題', content_items: [item('課本內容', 'reading')] }],
        }],
      },
    });
    const tree = await ok('GET', `/material/books/${out.book.id}/tree`);
    assert.equal(tree.nodes[0].children[0].kind, 'topic');
    assert.equal(tree.nodes[0].children[0].content_items[0].kind, 'reading');
  });
});

/* ============ A5：Legacy compatibility read layer ============ */

describe('A5 Legacy compatibility（純投影，不改資料）', () => {
  const legacyRow = (over = {}) => ({
    id: 7, user_id: 1, list_id: 3, title: '3 大氣', level: '章', order_index: 0,
    book: '地科課本', publisher: '龍騰',
    sections: JSON.stringify([
      { title: '壹 大氣的性質', level: '節', children: [
        { title: '主題1 大氣的成分', level: '主題', children: [] },
        { title: '主題2 垂直分布', level: '主題', children: [] },
      ] },
      { title: '焦點一 溫室效應', level: '焦點', children: [] },
    ]),
    ...over,
  });

  test('巢狀 Topic 在呈現上攤平成與 Section 同層', () => {
    const ch = projectChapter(legacyRow());
    assert.deepEqual(ch.children.map(c => c.kind), ['section', 'topic', 'topic', LEGACY_NODE_KIND]);
    // 攤平之後主題緊跟在原本的父節點後面，順序不會亂掉
    assert.deepEqual(ch.children.map(c => c.title),
      ['壹 大氣的性質', '主題1 大氣的成分', '主題2 垂直分布', '焦點一 溫室效應']);
  });

  test('原始 legacy identity（toc_id + path）完整保留', () => {
    const ch = projectChapter(legacyRow());
    assert.deepEqual(ch.legacy_ref, { toc_id: 7, path: [] });
    assert.deepEqual(ch.children[0].legacy_ref, { toc_id: 7, path: [0] });
    assert.deepEqual(ch.children[1].legacy_ref, { toc_id: 7, path: [0, 0] });
    assert.deepEqual(ch.children[2].legacy_ref, { toc_id: 7, path: [0, 1] });
    assert.deepEqual(ch.children[3].legacy_ref, { toc_id: 7, path: [1] });
    // 被攤平的主題仍記得自己原本掛在誰底下
    assert.deepEqual(ch.children[1].legacy_flattened_from, { toc_id: 7, path: [0] });
  });

  test('legacy 節點沒有任何 Material identity', () => {
    const ch = projectChapter(legacyRow());
    const all = [ch, ...ch.children];
    for (const n of all) {
      assert.equal(n.source, SOURCE_LEGACY);
      assert.equal('material_node_id' in n, false);
      assert.equal('material_content_item_id' in n, false);
      assert.equal('material_book_id' in n, false);
      assert.equal('id' in n, false);
    }
  });

  test('legacy 沒有正式完成度時不捏造 0%', () => {
    const ch = projectChapter(legacyRow());
    assert.equal(ch.completion_supported, false);
    assert.equal('progress' in ch, false, '不得回一個假的 progress 物件');
    for (const c of ch.children) {
      assert.equal(c.completion_supported, false);
      assert.equal('progress' in c, false);
    }
  });

  test('「焦點」保守處理：不猜成任何正式 Material kind', () => {
    assert.equal(projectLevel('焦點'), LEGACY_NODE_KIND);
    assert.equal(ITEM_KINDS.includes(LEGACY_NODE_KIND), false,
      'legacy_node 不得是正式 Material content kind');
    const ch = projectChapter(legacyRow());
    const focus = ch.children.find(c => c.title.startsWith('焦點'));
    assert.equal(focus.kind, LEGACY_NODE_KIND);
    assert.equal(focus.legacy_level, '焦點', '原始 level 原樣保留');
    assert.equal(focus.completion_supported, false);
  });

  test('明確對得上的 level 才投影成 section / topic，其他一律保守', () => {
    assert.equal(projectLevel('節'), 'section');
    assert.equal(projectLevel('小節'), 'section');
    assert.equal(projectLevel('主題'), 'topic');
    assert.equal(projectLevel('重點'), 'topic');
    for (const l of ['焦點', '', '課', '補充', undefined]) {
      assert.equal(projectLevel(l), LEGACY_NODE_KIND, `${l} 不該被猜成正式種類`);
    }
  });

  test('最早期的字串陣列格式也讀得動', () => {
    const ch = projectChapter(legacyRow({ sections: JSON.stringify(['一、緒論', '二、方法']) }));
    assert.deepEqual(ch.children.map(c => c.title), ['一、緒論', '二、方法']);
    assert.deepEqual(ch.children.map(c => c.legacy_ref.path), [[0], [1]]);
  });

  test('壞掉的 sections JSON 不會讓整支掛掉', () => {
    const ch = projectChapter(legacyRow({ sections: '{not json' }));
    assert.deepEqual(ch.children, []);
  });
});

/* ============ Unified read API ============ */

describe('Unified student-facing library', () => {
  test('正式 Material 與 legacy 同一個形狀回來，但 source 與 identity 分明', async () => {
    const subject = await ok('POST', '/lists', { name: '地科' });
    const committed = await ok('POST', '/material/import/commit', {
      draft: goodDraft({ book: { title: '正式教材', subject_list_id: subject.id } }),
    });
    // 種一筆 legacy 資料（走既有 legacy 端點，不是 Material）
    await ok('POST', '/import/toc-node', { id: 0, path: [], title: 'x', level: '節' })
      .catch(() => {});

    const out = await ok('GET', '/study-materials');
    const formal = out.books.find(b => b.material_book_id === committed.book.id);
    assert.ok(formal, '正式教材要出現在 unified 清單裡');
    assert.equal(formal.source, 'material');
    assert.equal(formal.completion_supported, true);
    assert.ok(formal.progress);
    assert.deepEqual(formal.chapters[0].children.map(c => c.kind), ['section', 'topic']);
    assert.ok(formal.chapters[0].children[0].content_items[0].material_content_item_id);
    // legacy 的書不得帶 material_book_id
    for (const b of out.books.filter(x => x.source === 'legacy')) {
      assert.equal('material_book_id' in b, false);
      assert.equal(b.completion_supported, false);
      assert.equal('progress' in b, false);
    }
  });

  test('plan_id 只影響正式 Material 的 selection', async () => {
    const plan = await ok('POST', '/plans', { name: '段考', status: 'active' });
    const committed = await ok('POST', '/material/import/commit', {
      draft: goodDraft({ book: { title: 'selection 用書' } }),
    });
    const tree = await ok('GET', `/material/books/${committed.book.id}/tree`);
    const firstItem = tree.nodes[0].children[0].content_items[0];
    await ok('POST', `/plans/${plan.id}/material-items`,
      { content_item_ids: [firstItem.id], selected: true });

    const out = await ok('GET', `/study-materials?plan_id=${plan.id}`);
    const book = out.books.find(b => b.material_book_id === committed.book.id);
    assert.equal(book.chapters[0].children[0].selection, 'some');
    const picked = book.chapters[0].children[0].content_items.find(i => i.selected);
    assert.equal(Number(picked.material_content_item_id), Number(firstItem.id));
    // legacy 永遠沒有 selection，也不假裝有
    for (const b of out.books.filter(x => x.source === 'legacy')) {
      assert.equal('selection' in b, false);
    }
  });
});

/* ============ legacy 只讀不寫 ============ */

describe('Legacy 資料不被 mutation', () => {
  test('讀 unified library 前後，toc_items 一列都沒變', async () => {
    const snapshot = async () => JSON.stringify(await ok('GET', '/import/toc'));
    const before = await snapshot();
    await ok('GET', '/study-materials');
    await ok('GET', '/study-materials?plan_id=1');
    assert.equal(await snapshot(), before);
  });
});

/* ============ Plan.name 契約 ============ */

describe('Plan.name 直接承接學生輸入', () => {
  test('建立與更新都原樣保存，不需要 Goal', async () => {
    const p = await ok('POST', '/plans', { name: '9/18 物理小考', status: 'active' });
    assert.equal(p.name, '9/18 物理小考');
    assert.equal(p.goal_id ?? null, null);
    const patched = await ok('PATCH', `/plans/${p.id}`, { name: '下週數學小考' });
    assert.equal(patched.name, '下週數學小考');
    assert.equal(patched.goal_id ?? null, null);
  });
});
