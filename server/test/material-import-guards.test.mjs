// 教材匯入的輸入防線（hotfix）：payload 上限／格式（純函式）、重複章節警告（純函式）、
// 以及 commit 的科目 ownership fail-closed + 零殘留（真 HTTP）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { importPayloadError } from '../src/material/draft.js';
import { previewMaterialDraft, draftWarnings } from '../src/material/service.js';
import { startServer } from './helpers.mjs';

describe('importPayloadError（純函式，不依賴 AI 金鑰）', () => {
  const img = (chars, mime = 'image/jpeg') => ({ mime, data: 'a'.repeat(chars) });
  test('沒有檔案 → 明確錯誤', () => {
    assert.equal(importPayloadError([]), '沒有收到檔案');
    assert.equal(importPayloadError(null), '沒有收到檔案');
  });
  test('超過張數上限', () => {
    assert.match(importPayloadError(Array.from({ length: 13 }, () => img(4)), { maxFileBytes: 999, maxTotalBytes: 9999 }), /一次最多 12 張/);
  });
  test('不支援的格式或空內容', () => {
    assert.match(importPayloadError([{ mime: 'text/plain', data: 'x' }]), /格式不支援或內容為空/);
    assert.match(importPayloadError([{ mime: 'image/png', data: '' }]), /格式不支援或內容為空/);
  });
  test('單張超過大小上限（以小 limit 驗邏輯，不做巨量配置）', () => {
    // 12 chars → 9 bytes；maxFileBytes=8 → 超過
    assert.match(importPayloadError([img(12)], { maxFileBytes: 8, maxTotalBytes: 1000 }), /超過單張/);
  });
  test('全部合計超過總上限', () => {
    // 兩張各 9 bytes（每張未超單張 20），合計 18 > total 15
    assert.match(importPayloadError([img(12), img(12)], { maxFileBytes: 20, maxTotalBytes: 15 }), /合計超過/);
  });
  test('合法 payload → null', () => {
    assert.equal(importPayloadError([img(8), img(8)], { maxFileBytes: 100, maxTotalBytes: 100 }), null);
    assert.equal(importPayloadError([{ mime: 'application/pdf', data: 'aaaa' }]), null);
  });
});

describe('draftWarnings（多頁重複章節需確認，不覆蓋、不誤標完成）', () => {
  const draft = chapters => ({ book: { title: 'x', subject_list_id: null }, chapters });
  test('重複章節標題 → 標示需確認', () => {
    const w = draftWarnings(draft([
      { title: '第一章 多項式', content_items: [], children: [] },
      { title: '第一章 多項式', content_items: [], children: [] },
      { title: '第二章', content_items: [], children: [] },
    ]));
    assert.equal(w.length, 1);
    assert.equal(w[0].type, 'duplicate_chapter');
    assert.match(w[0].message, /重複的章節「第一章 多項式」/);
  });
  test('沒有重複 → 無警告', () => {
    assert.deepEqual(draftWarnings(draft([{ title: '甲', content_items: [], children: [] }, { title: '乙', content_items: [], children: [] }])), []);
  });
  test('previewMaterialDraft 帶 warnings 欄位', () => {
    const r = previewMaterialDraft({ book: { title: 'B' }, chapters: [
      { title: '同', content_items: [{ kind: 'unit_exercise', title: '單元練習' }], children: [] },
      { title: '同', content_items: [{ kind: 'unit_exercise', title: '單元練習' }], children: [] },
    ] });
    assert.ok(Array.isArray(r.warnings) && r.warnings.length === 1);
  });
});

describe('commit ownership fail-closed + 零殘留（HTTP）', () => {
  let S, H, other;
  before(async () => { S = await startServer(); H = S.H; other = (await S.secondUser()).H; });
  after(() => S?.stop());
  const post = async (path, body, headers = H) => {
    const r = await fetch(S.base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const get = async (path, headers = H) => {
    const r = await fetch(S.base + path, { headers });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  test('commit 用別人的科目 → 400，且不建立任何書', async () => {
    // 別的使用者建一個科目
    const foreignList = (await post('/lists', { name: '別人科目' }, other)).body;
    const before = (await get('/study-materials?shelf=1')).body.books?.length ?? 0;
    const r = await post('/material/import/commit', { draft: {
      book: { title: '偷渡教材', subject_list_id: foreignList.id },
      chapters: [{ title: '第一章', content_items: [{ kind: 'unit_exercise', title: '單元練習' }], children: [] }],
    } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    const after = (await get('/study-materials?shelf=1')).body.books?.length ?? 0;
    assert.equal(after, before, 'ownership 失敗不得留下半本書');
  });

  test('commit 真正空白的內容 → 400，零殘留', async () => {
    const mine = (await post('/lists', { name: '我的科目' })).body;
    const before = (await get('/study-materials?shelf=1')).body.books?.length ?? 0;
    const r = await post('/material/import/commit', { draft: {
      book: { title: '空殼', subject_list_id: mine.id }, chapters: [{ title: '', content_items: [], children: [] }],
    } });
    assert.equal(r.status, 400);
    const after = (await get('/study-materials?shelf=1')).body.books?.length ?? 0;
    assert.equal(after, before);
  });

  test('只有 L1/L2 標題的葉章也會真正建立 ContentItem，刷新仍存在', async () => {
    const mine = (await post('/lists', { name: '英文' })).body;
    const r = await post('/material/import/commit', { draft: {
      book: { title: '課本3', publisher: '龍騰', subject_list_id: mine.id },
      chapters: [
        { title: 'L1', content_items: [], children: [] },
        { title: 'Unit 2', content_items: [], children: [{ kind: 'section', title: 'L2', content_items: [] }] },
      ],
    } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tree = (await get(`/material/books/${r.body.book.id}/tree`)).body;
    assert.equal(tree.nodes[0].content_items[0].title, 'L1');
    assert.equal(tree.nodes[0].content_items[0].completed, false);
    assert.equal(tree.nodes[1].content_items.length, 0, '有子節的章仍是純容器');
    assert.equal(tree.nodes[1].children[0].content_items[0].title, 'L2');
    assert.equal(tree.nodes[1].children[0].content_items[0].completed, false);
  });

  test('preview payload 上限不依賴 AI 金鑰（沒有金鑰也先擋壞輸入）', async () => {
    assert.equal((await post('/material/import/preview', { files: [] })).status, 400);
    assert.equal((await post('/material/import/preview', { files: [{ mime: 'text/plain', data: 'x' }] })).status, 400);
    // 別人的科目 → 找不到科目（ownership fail-closed），也在金鑰檢查之前
    const foreign = (await post('/lists', { name: 'X' }, other)).body;
    const r = await post('/material/import/preview', { files: [{ mime: 'image/jpeg', data: 'aaaa' }], subject_list_id: foreign.id });
    assert.equal(r.status, 400);
    assert.match(r.body.error || '', /找不到這個科目/);
  });
});
