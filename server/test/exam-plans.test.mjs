// 段考計畫原子建立（POST /exam-plans）+ 投影（GET /plans/:id/exam）：
//   ・不先建空 Plan：一次交易建立 Plan＋各科考試日＋教材選取＋手動 scope。
//   ・per-subject 考試日；預設沿用段考結束日。
//   ・手動範圍是 first-class scope（plan_manual_scope），不是 Task、不是完成。
//   ・每日/時段：用既有 applySchedule 建立 ScheduleVersion，各科 deadline＝該科考試日；
//     排程失敗 → 補償刪除，不留半成品（Plan 不存在）。
//   ・ownership / 驗證 fail-closed。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day } from './helpers.mjs';

let S, base, H, other;
const call = async (path, opts = {}, headers = H) => {
  const r = await fetch(base + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (p, b, h) => call(p, { method: 'POST', body: b ?? {} }, h);
const get = (p, h) => call(p, {}, h);
before(async () => { S = await startServer(); base = S.base; H = S.H; other = (await S.secondUser()).H; });
after(() => S?.stop());

async function subject(name, h = H) { return (await post('/lists', { name }, h)).body; }
async function contentItem(subjId, chTitle = '第一課', h = H) {
  const book = (await post('/material/books', { title: `${chTitle}課本`, subject_list_id: subjId }, h)).body;
  const ch = (await post('/material/nodes', { book_id: book.id, kind: 'chapter', title: chTitle }, h)).body;
  const it = (await post('/material/content-items', { node_id: ch.id, kind: 'reading', title: '內文', estimated_minutes: 60 }, h)).body;
  return { book, ch, it };
}

describe('POST /exam-plans（原子建立）', () => {
  test('EP1 progress：一次建立 Plan＋各科考試日＋教材選取＋手動 scope', async () => {
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
    assert.equal(p.plan.target_date, day(14));               // 整個段考最後一天
    const mathSub = p.subjects.find(s => s.subject_list_id === math.id);
    const engSub = p.subjects.find(s => s.subject_list_id === eng.id);
    assert.equal(mathSub.exam_date, day(10));                // 單科考試日
    assert.equal(engSub.exam_date, day(14));                 // 未指定 → 沿用結束日
    assert.equal(p.material.length, 1);
    assert.equal(p.material[0].chapter_title, '第一章多項式');
    assert.equal(p.manual_scope.length, 1);
    assert.equal(p.manual_scope[0].label, '老師講義第三章');
    // 手動 scope 不是 Task：progress 層不建任何 Task
    const tasks = (await get('/tasks')).body;
    assert.ok(!(Array.isArray(tasks) ? tasks : []).some(t => t.title === '老師講義第三章'), '手動範圍不得建成 Task');
  });

  test('EP2 daily：applySchedule 建 ScheduleVersion，Task deadline＝該科考試日', async () => {
    const math = await subject('數學EP2');
    const m = await contentItem(math.id, '第一章');
    const created = await post('/exam-plans', {
      name: '段考daily', start_date: day(0), end_date: day(10), level: 'daily',
      subjects: [{ subject_list_id: math.id, exam_date: day(8) }],
      material_scope: [m.it.id],
      manual_scope: [],
      schedule: {
        task_creates: [{ client_key: 'k1', title: '數學 內文', list_id: math.id, deadline_date: day(8), material_content_item_id: m.it.id, tags: ['讀書計劃'] }],
        blocks: [{ client_key: 'k1', date: day(2), planned_minutes: 60 }],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const tasks = (await get('/tasks')).body;
    const t = (Array.isArray(tasks) ? tasks : []).find(x => x.title === '數學 內文');
    assert.ok(t, '應建立 material Task');
    assert.equal(t.deadline_date, day(8), 'Task deadline 應為該科考試日（有效完成上限）');
  });

  test('EP3 daily 排程失敗 → 補償刪除，不留半成品', async () => {
    const math = await subject('數學EP3');
    const before = (await get('/plans')).body.length;
    const created = await post('/exam-plans', {
      name: '段考壞排程', start_date: day(0), end_date: day(10), level: 'daily',
      subjects: [{ subject_list_id: math.id }],
      material_scope: [], manual_scope: [],
      // 空標題 task_create → applySchedule 丟錯 → 補償
      schedule: { task_creates: [{ client_key: 'bad', title: '', list_id: math.id }], blocks: [{ client_key: 'bad', date: day(1) }] },
    });
    assert.equal(created.status >= 400, true);
    const after = (await get('/plans')).body.length;
    assert.equal(after, before, '排程失敗後不得殘留 Plan');
  });

  test('EP4 ownership / 驗證 fail-closed（不建 Plan）', async () => {
    const mine = await subject('數學EP4');
    const foreignItem = await contentItem((await subject('外人科', other)).id, '外章', other);
    const before = (await get('/plans')).body.length;
    // 別人的教材內容
    assert.equal((await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [{ subject_list_id: mine.id }], material_scope: [foreignItem.it.id] })).status, 400);
    // 別人的科目
    assert.equal((await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [{ subject_list_id: 999999 }] })).status, 400);
    // 缺名稱／缺結束日／無科目
    assert.equal((await post('/exam-plans', { end_date: day(5), subjects: [{ subject_list_id: mine.id }] })).status, 400);
    assert.equal((await post('/exam-plans', { name: 'x', subjects: [{ subject_list_id: mine.id }] })).status, 400);
    assert.equal((await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [] })).status, 400);
    // 單科考試日晚於段考結束日
    assert.equal((await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [{ subject_list_id: mine.id, exam_date: day(9) }] })).status, 400);
    assert.equal((await get('/plans')).body.length, before, 'fail-closed：不得建立任何 Plan');
  });

  test('EP5 跨使用者：別人的 exam 投影 404', async () => {
    const math = await subject('數學EP5');
    const created = await post('/exam-plans', { name: 'x', end_date: day(5), subjects: [{ subject_list_id: math.id }] });
    assert.equal((await get(`/plans/${created.body.plan.id}/exam`, other)).status, 404);
  });
});
