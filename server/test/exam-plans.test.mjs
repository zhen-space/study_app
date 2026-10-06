// 段考計畫原子建立（POST /exam-plans）+ 投影（GET /plans/:id/exam）。
//
// server-authoritative 契約（P0 修正）：
//   ・排程由伺服器用 CURRENT scope 自己算，client 送的 schedule/blocks 一律忽略（P0-2）。
//   ・daily/timed 排不下、缺估時、空 scope → fail closed（422），不建立任何 Plan（P0-1）。
//   ・每科 Task 的 deadline＝該科 CURRENT 考試日，且沒有 block 超過它（P0-3）。
//   ・單一交易：任一步失敗零可見殘留（P0-4，另見 exam-plan-atomic.test.mjs 的中途注入）。
//   ・驗證與 ownership 全部在交易內以 CURRENT 重讀（P0-5）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day } from './helpers.mjs';

let S, base, H, other;
const call = async (path, opts = {}, headers = H) => {
  const r = await fetch(base + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (p, b, h) => {
  if (p === '/exam-plans') {
    const preview = await call('/exam-plans/preview', { method: 'POST', body: b ?? {} }, h);
    if (preview.status !== 200) return preview;
    return call(p, { method: 'POST', body: { ...(b ?? {}), preview_token: preview.body.preview_token } }, h);
  }
  return call(p, { method: 'POST', body: b ?? {} }, h);
};
const get = (p, h) => call(p, {}, h);
before(async () => { S = await startServer(); base = S.base; H = S.H; other = (await S.secondUser()).H; });
after(() => S?.stop());

async function subject(name, h = H) { return (await post('/lists', { name }, h)).body; }
async function contentItem(subjId, chTitle = '第一課', minutes = 60, h = H) {
  const book = (await post('/material/books', { title: `${chTitle}課本`, subject_list_id: subjId }, h)).body;
  const ch = (await post('/material/nodes', { book_id: book.id, kind: 'chapter', title: chTitle }, h)).body;
  const it = (await post('/material/content-items', { node_id: ch.id, kind: 'reading', title: '內文', estimated_minutes: minutes }, h)).body;
  return { book, ch, it };
}
const tasksNow = async (h = H) => { const b = (await get('/tasks', h)).body; return Array.isArray(b) ? b : []; };
const plansCount = async (h = H) => (await get('/plans', h)).body.length;

describe('POST /exam-plans（server-authoritative 原子建立）', () => {
  test('EP1 progress：一次建立 Plan＋各科考試日＋教材選取＋手動 scope；手動 scope 不是 Task', async () => {
    const math = await subject('數學EP1');
    const eng = await subject('英文EP1');
    const m = await contentItem(math.id, '第一章多項式');
    const created = await post('/exam-plans', {
      name: '第二次段考', start_date: day(0), end_date: day(14), level: 'progress',
      subjects: [{ subject_list_id: math.id, exam_date: day(10) }, { subject_list_id: eng.id }],
      material_scope: [m.it.id],
      manual_scope: [{ subject_list_id: math.id, label: '老師講義第三章' }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const p = created.body;
    assert.equal(p.plan.target_date, day(14));
    assert.equal(p.subjects.find(s => s.subject_list_id === math.id).exam_date, day(10));
    assert.equal(p.subjects.find(s => s.subject_list_id === eng.id).exam_date, day(14));
    assert.equal(p.material.length, 1);
    assert.equal(p.material[0].chapter_title, '第一章多項式');
    assert.equal(p.manual_scope.length, 1);
    assert.equal(p.manual_scope[0].label, '老師講義第三章');
    assert.equal(p.manual_scope[0].task_id, null, 'progress 不建 Task');
    assert.ok(!(await tasksNow()).some(t => t.title === '老師講義第三章'), '手動範圍不得建成 Task');
  });

  test('EP2 daily：伺服器自排；Task deadline＝該科考試日，且沒有 block 超過它', async () => {
    const math = await subject('數學EP2');
    const m = await contentItem(math.id, '第一章');
    const created = await post('/exam-plans', {
      name: '段考daily', start_date: day(0), end_date: day(10), level: 'daily',
      subjects: [{ subject_list_id: math.id, exam_date: day(8) }],
      material_scope: [m.it.id], manual_scope: [],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const t = (await tasksNow()).find(x => x.material_content_item_id === m.it.id);
    assert.ok(t, '應建立 material Task');
    assert.equal(t.deadline_date, day(8), 'Task deadline 應為該科考試日（有效完成上限）');
    assert.ok(t.due_date && t.due_date <= day(8), 'block 鏡射的 due_date 不得超過考試日');
  });

  test('EP2-start：使用者設定未來開始日，正式安排不得提早到開始日前', async () => {
    const math = await subject('數學EP2-start');
    const m = await contentItem(math.id, '未來才開始');
    const created = await post('/exam-plans', {
      name: '段考未來開始', start_date: day(4), end_date: day(10), level: 'daily',
      subjects: [{ subject_list_id: math.id, exam_date: day(8) }],
      material_scope: [m.it.id], manual_scope: [],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const t = (await tasksNow()).find(x => x.material_content_item_id === m.it.id);
    assert.ok(t?.due_date >= day(4), `安排 ${t?.due_date} 不得早於準備開始日 ${day(4)}`);
    assert.ok(t.due_date <= day(8), '安排仍不得超過該科考試日');
  });

  test('EP2b P0-3：client 傳的 deadline/排程一律忽略，deadline 以 CURRENT 考試日為準', async () => {
    const math = await subject('數學EP2b');
    const m = await contentItem(math.id, '第一章');
    const created = await post('/exam-plans', {
      name: '段考覆寫', start_date: day(0), end_date: day(10), level: 'daily',
      subjects: [{ subject_list_id: math.id, exam_date: day(6) }],
      material_scope: [m.it.id], manual_scope: [],
      // 惡意/過時 client：偽造一個超過考試日、且不屬於本 scope 的排程
      schedule: {
        task_creates: [{ client_key: 'evil', title: '惡意任務', list_id: math.id, deadline_date: day(30) }],
        blocks: [{ client_key: 'evil', date: day(30) }],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const ts = await tasksNow();
    assert.ok(!ts.some(t => t.title === '惡意任務'), 'client 送的 task_creates 必須被忽略');
    const t = ts.find(x => x.material_content_item_id === m.it.id);
    assert.equal(t.deadline_date, day(6), 'deadline 以 CURRENT 考試日為準，不信 client 的 day(30)');
    assert.ok(t.due_date && t.due_date <= day(6));
  });

  test('EP2c P0-2 覆蓋：只有 CURRENT 選取的教材會被排；未選取的不會混進來', async () => {
    const math = await subject('數學EP2c');
    const picked = await contentItem(math.id, '選到的章');
    const notPicked = await contentItem(math.id, '沒選的章');
    const created = await post('/exam-plans', {
      name: '段考覆蓋', start_date: day(0), end_date: day(10), level: 'daily',
      subjects: [{ subject_list_id: math.id }],
      material_scope: [picked.it.id], manual_scope: [],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const ts = await tasksNow();
    assert.ok(ts.some(t => t.material_content_item_id === picked.it.id), '選取的教材要排入');
    assert.ok(!ts.some(t => t.material_content_item_id === notPicked.it.id), '沒選取的教材不得混入');
  });

  test('EP3 P0-1：daily 空 scope → 422 fail closed，不留 Plan', async () => {
    const math = await subject('數學EP3');
    const before = await plansCount();
    const r = await post('/exam-plans', {
      name: '段考空', start_date: day(0), end_date: day(10), level: 'daily',
      subjects: [{ subject_list_id: math.id }], material_scope: [], manual_scope: [],
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'EXAM_SCOPE_EMPTY');
    assert.equal(await plansCount(), before, '不得殘留 Plan');
  });

  test('EP3b P0-1：timed 排不下（估時遠超容量）→ 422 gap，不留 Plan', async () => {
    const math = await subject('數學EP3b');
    const m = await contentItem(math.id, '巨量', 100000);   // 遠超任何日期容量
    const before = await plansCount();
    const r = await post('/exam-plans', {
      name: '段考爆量', start_date: day(0), end_date: day(2), level: 'timed',
      subjects: [{ subject_list_id: math.id, exam_date: day(2) }],
      material_scope: [m.it.id], manual_scope: [],
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(await plansCount(), before, 'gap 時不得殘留 Plan');
  });

  test('EP3c P0-2：daily 下缺預估的手動範圍不得靜默略過 → 422，不留 Plan', async () => {
    const math = await subject('數學EP3c');
    const m = await contentItem(math.id, '第一章');
    const before = await plansCount();
    const r = await post('/exam-plans', {
      name: '段考手動缺估', start_date: day(0), end_date: day(10), level: 'daily',
      subjects: [{ subject_list_id: math.id }],
      material_scope: [m.it.id],
      manual_scope: [{ subject_list_id: math.id, label: '老師講義（沒給時間）' }],   // 缺 est
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'MANUAL_ESTIMATE_MISSING');
    assert.equal(await plansCount(), before, '不得殘留 Plan');
  });

  test('EP3d daily：有估時的手動範圍會排入並綁定 task_id', async () => {
    const math = await subject('數學EP3d');
    const created = await post('/exam-plans', {
      name: '段考手動有估', start_date: day(0), end_date: day(10), level: 'daily',
      subjects: [{ subject_list_id: math.id, exam_date: day(7) }],
      material_scope: [],
      manual_scope: [{ subject_list_id: math.id, label: '老師講義第三章', estimated_minutes: 60 }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.manual_scope.length, 1);
    assert.ok(created.body.manual_scope[0].task_id, '有估時的手動範圍 daily 應綁 task_id');
    const t = (await tasksNow()).find(x => x.title === '老師講義第三章');
    assert.ok(t, '手動範圍應建成可排程 Task');
    assert.equal(t.deadline_date, day(7));
  });

  test('EP4 ownership / 驗證 fail-closed（不建 Plan）', async () => {
    const mine = await subject('數學EP4');
    const foreign = await contentItem((await subject('外人科', other)).id, '外章', 60, other);
    const before = await plansCount();
    assert.equal((await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [{ subject_list_id: mine.id }], material_scope: [foreign.it.id] })).status, 400);
    assert.equal((await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [{ subject_list_id: 999999 }] })).status, 400);
    assert.equal((await post('/exam-plans', { end_date: day(5), subjects: [{ subject_list_id: mine.id }] })).status, 400);
    assert.equal((await post('/exam-plans', { name: 'x', subjects: [{ subject_list_id: mine.id }] })).status, 400);
    assert.equal((await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [] })).status, 400);
    assert.equal((await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [{ subject_list_id: mine.id, exam_date: day(9) }] })).status, 400);
    assert.equal(await plansCount(), before, 'fail-closed：不得建立任何 Plan');
  });

  test('EP4b P0-5：重複科目 / 非 canonical 日期 fail-closed', async () => {
    const mine = await subject('數學EP4b');
    const before = await plansCount();
    // 重複科目
    assert.equal((await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [{ subject_list_id: mine.id }, { subject_list_id: mine.id }] })).status, 400);
    // 格式對但不存在的日子（2 月 30 日）：純 regex 會放行，canonical 驗證要擋下
    const y = day(0).slice(0, 4);
    assert.equal((await post('/exam-plans', { name: 'x', end_date: `${y}-02-30`, subjects: [{ subject_list_id: mine.id }] })).status, 400);
    assert.equal(await plansCount(), before, 'fail-closed');
  });

  test('EP4c P0-5：教材科目不在本次考試科目內 → 400', async () => {
    const inExam = await subject('數學EP4c');
    const outExam = await subject('沒加入的科目EP4c');
    const m = await contentItem(outExam.id, '外科章');
    const before = await plansCount();
    const r = await post('/exam-plans', {
      name: 'x', end_date: day(5), level: 'daily',
      subjects: [{ subject_list_id: inExam.id }], material_scope: [m.it.id],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'MATERIAL_SUBJECT_NOT_IN_EXAM');
    assert.equal(await plansCount(), before);
  });

  test('EP5 跨使用者：別人的 exam 投影 404', async () => {
    const math = await subject('數學EP5');
    const created = await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [{ subject_list_id: math.id }] });
    assert.equal((await get(`/plans/${created.body.plan.id}/exam`, other)).status, 404);
  });

  test('EP6 每個考科都必須有範圍：preview/formal 都 fail closed 且零寫入', async () => {
    const math = await subject('數學EP6');
    const eng = await subject('英文EP6');
    const m = await contentItem(math.id, '數學範圍');
    const body = { name: '逐科完整', end_date: day(5), level: 'progress',
      subjects: [{ subject_list_id: math.id }, { subject_list_id: eng.id }], material_scope: [m.it.id] };
    const before = await plansCount();
    const preview = await call('/exam-plans/preview', { method: 'POST', body });
    assert.equal(preview.status, 422);
    assert.equal(preview.body.code, 'SUBJECT_SCOPE_MISSING');
    assert.deepEqual(preview.body.subject_ids, [eng.id]);
    const formal = await call('/exam-plans', { method: 'POST', body: { ...body, preview_token: 'forged' } });
    assert.equal(formal.status, 409);
    assert.equal(await plansCount(), before);
  });
});
