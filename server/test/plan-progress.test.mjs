// 段考「進度安排」（A 層）迴歸：
//   ・純投影 buildPlanProgress：把 segment 的「範圍目標＋期限」疊上 CURRENT 完成
//     事實，算出已完成幾項／落後或超前。不冒充完成、不臆測配速。
//   ・HTTP 契約：CRUD、驗證、fail-closed 的 scope 擁有權、跨使用者隔離。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day } from './helpers.mjs';
import { buildPlanProgress, projectSegment } from '../src/schedule/progress.js';

/* ---------------- 純投影（無 DB、可 mutation 測） ---------------- */

describe('buildPlanProgress projection', () => {
  test('PP1 完成度：percent 與 completed_count 以 scope 為分母', () => {
    const { segments } = buildPlanProgress({
      segments: [{ id: 1, title: '第一段', end_date: '2026-10-02', scope: [1, 2, 3, 4] }],
      completedItemIds: new Set([1, 2]),
      today: '2026-09-28',
    });
    assert.equal(segments[0].total, 4);
    assert.equal(segments[0].completed_count, 2);
    assert.equal(segments[0].percent, 50);
  });

  test('PP2 全部完成 → done，且不受日期影響', () => {
    const s = projectSegment(
      { id: 1, title: 'x', start_date: '2026-09-01', end_date: '2026-09-10', scope: [1, 2] },
      new Set([1, 2]), '2026-09-30');
    assert.equal(s.status, 'done');
    assert.equal(s.behind, false);
  });

  test('PP3 期限已過又沒讀完 → behind，needs_attention 為真', () => {
    const r = buildPlanProgress({
      segments: [{ id: 1, title: 'x', end_date: '2026-09-20', scope: [1, 2] }],
      completedItemIds: new Set([1]),
      today: '2026-09-28',
    });
    assert.equal(r.segments[0].status, 'behind');
    assert.equal(r.segments[0].behind, true);
    assert.equal(r.summary.needs_attention, true);
  });

  test('PP4 還沒到 start_date → upcoming（不算落後）', () => {
    const s = projectSegment(
      { id: 1, title: 'x', start_date: '2026-10-05', end_date: '2026-10-10', scope: [1, 2] },
      new Set(), '2026-09-28');
    assert.equal(s.time_status, 'upcoming');
    assert.equal(s.status, 'upcoming');
    assert.equal(s.behind, false);
  });

  test('PP5 視窗內依配速判 behind / ahead / on_track', () => {
    // 9/28–10/07 共 10 天；到 10/02 已過 5 天 → 期望 50%
    const base = { id: 1, title: 'x', start_date: '2026-09-28', end_date: '2026-10-07', scope: [1, 2, 3, 4] };
    const behind = projectSegment(base, new Set([1]), '2026-10-02');      // 實際 25% < 50%
    const ahead = projectSegment(base, new Set([1, 2, 3]), '2026-10-02'); // 實際 75% > 50%
    assert.equal(behind.expected_percent, 50);
    assert.equal(behind.status, 'behind');
    assert.equal(ahead.status, 'ahead');
  });

  test('PP6 沒有 start_date 時不臆測配速：expected_percent 為 null、視窗內回 on_track', () => {
    const s = projectSegment(
      { id: 1, title: 'x', end_date: '2026-10-10', scope: [1, 2] },
      new Set([1]), '2026-09-28');
    assert.equal(s.expected_percent, null);
    assert.equal(s.status, 'on_track');
  });

  test('PP7 依 order_index，再依 end_date 排序', () => {
    const { segments } = buildPlanProgress({
      segments: [
        { id: 1, title: 'B', end_date: '2026-10-10', order_index: 1, scope: [] },
        { id: 2, title: 'A', end_date: '2026-10-01', order_index: 0, scope: [] },
      ],
      today: '2026-09-28',
    });
    assert.deepEqual(segments.map(s => s.title), ['A', 'B']);
  });

  test('PP8 沒有 segment → empty，摘要歸零', () => {
    const r = buildPlanProgress({ segments: [], today: '2026-09-28' });
    assert.equal(r.empty, true);
    assert.equal(r.summary.segment_count, 0);
    assert.equal(r.summary.needs_attention, false);
  });
});

/* ---------------- HTTP 契約 ---------------- */

let S, base, H, other;
const call = async (path, opts = {}, headers = H) => {
  const r = await fetch(base + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (p, b, h) => call(p, { method: 'POST', body: b ?? {} }, h);
const get = (p, h) => call(p, {}, h);
const patch = (p, b, h) => call(p, { method: 'PATCH', body: b ?? {} }, h);
const del = (p, h) => call(p, { method: 'DELETE' }, h);

before(async () => { S = await startServer(); base = S.base; H = S.H; other = (await S.secondUser()).H; });
after(() => S?.stop());

// 建一本書 + 一章 + n 個 reading content item，回傳 content_item_id 陣列。
async function makeItems(n, h = H) {
  const book = (await post('/material/books', { title: '課本' }, h)).body;
  const ch = (await post('/material/nodes', { book_id: book.id, kind: 'chapter', title: '第一章' }, h)).body;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const it = (await post('/material/content-items', { node_id: ch.id, kind: 'reading', title: `節${i}` }, h)).body;
    ids.push(it.id);
  }
  return ids;
}
const mkPlan = async (h = H) => (await post('/plans', { name: '段考計畫', status: 'active' }, h)).body;

describe('progress-segments API', () => {
  test('API1 建立→投影→完成一項後 percent 更新', async () => {
    const plan = await mkPlan();
    const items = await makeItems(2);
    const created = await post(`/plans/${plan.id}/progress-segments`,
      { title: '數學第一課～第二課', end_date: day(5), start_date: day(0), scope: items, subject_list_id: null });
    assert.equal(created.status, 201);
    assert.equal(created.body.segments.length, 1);
    assert.equal(created.body.segments[0].total, 2);
    assert.equal(created.body.segments[0].completed_count, 0);
    // 在 Material 層完成一項 → 進度投影跟著更新（完成度不存 segment，投影時疊上）
    await call(`/material/content-items/${items[0]}/completion`, { method: 'PUT', body: { completed: true } });
    const got = await get(`/plans/${plan.id}/progress-segments`);
    assert.equal(got.body.segments[0].completed_count, 1);
    assert.equal(got.body.segments[0].percent, 50);
  });

  test('API2 缺 end_date / 壞 kind / 顛倒日期 一律 400', async () => {
    const plan = await mkPlan();
    assert.equal((await post(`/plans/${plan.id}/progress-segments`, { title: 'x' })).status, 400);
    assert.equal((await post(`/plans/${plan.id}/progress-segments`, { title: 'x', end_date: day(3), kind: '亂' })).status, 400);
    assert.equal((await post(`/plans/${plan.id}/progress-segments`, { title: 'x', end_date: day(1), start_date: day(5) })).status, 400);
  });

  test('API3 scope 含非自己的教材內容 → 400（fail-closed，不寫入）', async () => {
    const plan = await mkPlan();
    const foreign = await makeItems(1, other);
    const r = await post(`/plans/${plan.id}/progress-segments`, { title: 'x', end_date: day(3), scope: foreign });
    assert.equal(r.status, 400);
    // 沒有任何 segment 被寫入
    assert.equal((await get(`/plans/${plan.id}/progress-segments`)).body.segments.length, 0);
  });

  test('API4 PATCH 改期限與範圍、DELETE 移除', async () => {
    const plan = await mkPlan();
    const items = await makeItems(3);
    await post(`/plans/${plan.id}/progress-segments`, { title: 'x', end_date: day(3), scope: items.slice(0, 2) });
    let list = await get(`/plans/${plan.id}/progress-segments`);
    const sid = list.body.segments[0].id;
    const upd = await patch(`/plans/${plan.id}/progress-segments/${sid}`, { end_date: day(7), scope: items });
    assert.equal(upd.body.segments[0].total, 3);
    assert.equal(upd.body.segments[0].end_date, day(7));
    const gone = await del(`/plans/${plan.id}/progress-segments/${sid}`);
    assert.equal(gone.body.segments.length, 0);
  });

  test('API5 跨使用者：別人的計畫一律 404', async () => {
    const plan = await mkPlan();
    assert.equal((await get(`/plans/${plan.id}/progress-segments`, other)).status, 404);
    assert.equal((await post(`/plans/${plan.id}/progress-segments`, { title: 'x', end_date: day(3) }, other)).status, 404);
  });
});
