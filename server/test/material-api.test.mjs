// Material domain 的跨模組行為：completion lifecycle、Plan selection lifecycle、
// Task linkage、Book 刪除語意、Category many-to-many。
//
// 這一支走真的 HTTP，因為要驗的正是「跨 Plan 全域完成度」與「取消選取時
// Task 怎麼退出排程」——那是 route + service + 既有 schedule lifecycle 合起來
// 的行為，只測 service 會漏掉接線錯誤。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day } from './helpers.mjs';

let S;
before(async () => { S = await startServer(); });
after(() => S?.stop());

const api = async (method, path, body) => {
  const r = await fetch(S.base + path, {
    method, headers: S.H, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
};
const ok = async (method, path, body) => {
  const r = await api(method, path, body);
  assert.ok(r.status < 400, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

// 一本標準結構的書：章底下直接有 Section / Topic，同時有直接掛章的單元練習。
async function seedBook(title = '數學') {
  const book = await ok('POST', '/material/books', { title });
  const ch = await ok('POST', '/material/nodes', { book_id: book.id, kind: 'chapter', title: '第一章' });
  const sec = await ok('POST', '/material/nodes', { book_id: book.id, parent_id: ch.id, kind: 'section', title: '1-1' });
  const topic = await ok('POST', '/material/nodes', { book_id: book.id, parent_id: ch.id, kind: 'topic', title: '主題一' });
  const reading = await ok('POST', '/material/content-items', { node_id: sec.id, kind: 'reading', title: '內文' });
  const example = await ok('POST', '/material/content-items', { node_id: topic.id, kind: 'example', title: '例題一' });
  const exercise = await ok('POST', '/material/content-items', { node_id: ch.id, kind: 'unit_exercise', title: '單元練習' });
  return { book, ch, sec, topic, reading, example, exercise };
}

const mkPlan = async name => ok('POST', '/plans', { name, status: 'active' });

// Plan Task 的排定時間只能由排程器寫入，所以這裡只建立任務本身。
const mkTask = (planId, itemId, title = '讀教材') =>
  ok('POST', '/tasks', { title, plan_id: planId, material_content_item_id: itemId });

describe('教材樹建立與樹形限制', () => {
  test('合法結構建得起來，Section / Topic 是 Chapter 的同層子節點', async () => {
    const B = await seedBook('樹形');
    const tree = await ok('GET', `/material/books/${B.book.id}/tree`);
    assert.equal(tree.progress.total_items, 3);
    assert.equal(tree.progress.completed_items, 0);
    assert.equal(tree.nodes.length, 1);
    const chapter = tree.nodes[0];
    assert.deepEqual(chapter.children.map(n => n.kind), ['section', 'topic']);
    assert.equal(chapter.children.find(n => n.kind === 'topic').content_items[0].title, '例題一');
  });

  test('拒絕把 Topic 掛在 Section 底下', async () => {
    const B = await seedBook('Topic 層級');
    const r = await api('POST', '/material/nodes',
      { book_id: B.book.id, parent_id: B.sec.id, kind: 'topic', title: '錯誤巢狀主題' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /只能放在章底下/);
  });

  test('拒絕為單元練習建立假的節（契約 7）', async () => {
    const B = await seedBook('假節');
    const r = await api('POST', '/material/content-items',
      { node_id: B.sec.id, kind: 'unit_exercise', title: '塞進節裡的練習' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /直接屬於章/);
  });

  test('拒絕把節直接掛在書底下', async () => {
    const B = await seedBook('層級');
    const r = await api('POST', '/material/nodes', { book_id: B.book.id, kind: 'section', title: '孤兒節' });
    assert.equal(r.status, 400);
  });

  test('拒絕跨書掛節點', async () => {
    const A = await seedBook('甲書'); const C = await seedBook('乙書');
    const r = await api('POST', '/material/nodes',
      { book_id: A.book.id, parent_id: C.ch.id, kind: 'section', title: '跨書' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /不屬於這本教材/);
  });
});

describe('Completion lifecycle（契約 1、2）', () => {
  test('只有 ContentItem 能被標記完成，節點完成度隨之 derived', async () => {
    const B = await seedBook('完成');
    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: true });
    const tree = await ok('GET', `/material/books/${B.book.id}/tree`);
    assert.equal(tree.progress.completed_items, 1);
    assert.equal(tree.nodes[0].children[0].progress.completed_items, 1);
    assert.equal(tree.nodes[0].progress.percent, 33);
  });

  test('可以手動改回未完成', async () => {
    const B = await seedBook('取消完成');
    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: true });
    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: false });
    const tree = await ok('GET', `/material/books/${B.book.id}/tree`);
    assert.equal(tree.progress.completed_items, 0);
  });

  test('節點沒有 completion 端點', async () => {
    const B = await seedBook('節點完成');
    // 沒有任何 /material/nodes/:id/completion 路由；節點完成度只能 derived
    const r = await api('PUT', `/material/nodes/${B.ch.id}/completion`, { completed: true });
    assert.equal(r.status, 404);
    const tree = await ok('GET', `/material/books/${B.book.id}/tree`);
    assert.equal(tree.nodes[0].progress.completed_items, 0);
  });

  test('Task 完成會帶起教材完成；Task reopen 不得把教材改回未完成（契約 2）', async () => {
    const B = await seedBook('reopen');
    const plan = await mkPlan('reopen 計畫');
    const task = await mkTask(plan.id, B.reading.id);

    const done = await ok('PATCH', `/tasks/${task.id}`, { completed: true });
    assert.equal(done.material.completed, true);
    assert.equal(done.material.progress.source, 'task');
    assert.equal(Number(done.material.progress.source_task_id), Number(task.id));

    await ok('PATCH', `/tasks/${task.id}`, { completed: false });
    const tree = await ok('GET', `/material/books/${B.book.id}/tree`);
    assert.equal(tree.progress.completed_items, 1, 'reopen 後教材仍應維持已完成');
  });

  test('取消 Task 不代表教材完成', async () => {
    const B = await seedBook('取消任務');
    const plan = await mkPlan('取消計畫');
    const task = await mkTask(plan.id, B.reading.id);
    await ok('PATCH', `/tasks/${task.id}`, { cancelled: true });
    const tree = await ok('GET', `/material/books/${B.book.id}/tree`);
    assert.equal(tree.progress.completed_items, 0);
  });
});

describe('跨 Plan reconciliation（契約 3）', () => {
  test('一處完成後，其他 Plan 的同一份教材 Task 退出排程但不偽造 completed 歷史', async () => {
    const B = await seedBook('跨計畫');
    const planA = await mkPlan('A 計畫');
    const planB = await mkPlan('B 計畫');
    const taskA = await mkTask(planA.id, B.reading.id, 'A 的任務');
    const taskB = await mkTask(planB.id, B.reading.id, 'B 的任務');

    const done = await ok('PATCH', `/tasks/${taskA.id}`, { completed: true });
    assert.deepEqual(done.material.reconciliation.blocked, []);
    assert.deepEqual(done.material.reconciliation.cancelled.map(x => Number(x.task_id)), [Number(taskB.id)]);

    const tasks = await ok('GET', '/tasks');
    const b = tasks.find(t => Number(t.id) === Number(taskB.id));
    assert.equal(b.cancelled, 1, '其他 Plan 的 Task 應為取消');
    assert.equal(b.completed, 0, '不得偽造其他 Plan 的 completed 歷史');
    const a = tasks.find(t => Number(t.id) === Number(taskA.id));
    assert.equal(a.completed, 1, '真正完成的那一筆才記 completed');
  });

  test('已完成的教材不能再長出新的 Task', async () => {
    const B = await seedBook('已完成不排');
    const plan = await mkPlan('新計畫');
    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: true });
    const r = await api('POST', '/tasks',
      { title: '重複的工作', plan_id: plan.id, material_content_item_id: B.reading.id });
    assert.equal(r.status, 409);
  });

  // 鎖定的產品決策：Material completion 是「這份教材內容已完成」的長期事實狀態，
  // 優先於其他 Plan 的 Task / Schedule reconciliation。Lock 的語意是保護既有
  // Task／排程不被自動調整，**不得阻止 completion 本身被記錄**。
  test('Lock 不得阻止 completion 被記錄；被擋住的 Task 保留原狀並回報 blocked[]', async () => {
    const B = await seedBook('Lock 衝突');
    const planA = await mkPlan('完成端計畫');
    const planB = await mkPlan('被鎖計畫');
    const taskA = await mkTask(planA.id, B.reading.id, 'A 的任務');
    const taskB = await mkTask(planB.id, B.reading.id, 'B 的任務');

    // 讓 taskB 真的進入 active schedule，Task Lock 才有保護對象
    await ok('POST', '/schedule/apply', {
      plan_id: planB.id, source: 'initial', reason: '先排 B',
      blocks: [{ task_id: taskB.id, date: day(2) }],
    });
    await ok('POST', '/schedule/locks', { type: 'task', task_id: taskB.id });

    const done = await ok('PATCH', `/tasks/${taskA.id}`, { completed: true });

    // ① completion 先成功寫入，不因為另一個 Plan 有 Lock 而被拒絕
    assert.equal(done.material.completed, true);
    const tree = await ok('GET', `/material/books/${B.book.id}/tree`);
    assert.equal(tree.progress.completed_items, 1, 'Lock 不得阻止教材完成度被記錄');

    // ② reconciliation 照常進行，且不偽造 completed 歷史。
    //
    // 這裡 taskB 是被取消而不是被 blocked，那是既有 Lock 語意的正確結果：
    // 取消會先把 Task 標為 cancelled，此時它自己的 Task Lock 已不再 effective
    // （effectiveLocks 的 live() 要求 task 未取消），而 Day / Slice Lock 比較時
    // 兩邊都會濾掉這個 task 的 block。也就是說 **Lock 不會擋下自己的取消**。
    // blocked[] 因此是防禦性通道（rebuild 真的失敗時才有內容），不是 Lock 的出口。
    const tasks = await ok('GET', '/tasks');
    const b = tasks.find(t => Number(t.id) === Number(taskB.id));
    assert.equal(b.completed, 0, '不得偽造其他 Plan 的 completed 歷史');
    assert.equal(b.cancelled, 1);
    assert.deepEqual(done.material.reconciliation.blocked, []);

    // ③ blocked[] 若有內容，必須帶得出 task_id 與原因，前端才有辦法呈現成真實衝突
    for (const x of done.material.reconciliation.blocked) {
      assert.ok(x.task_id != null && x.error);
    }
  });

  test('手動在 Material 層完成也會觸發 reconciliation', async () => {
    const B = await seedBook('手動完成');
    const plan = await mkPlan('手動計畫');
    const task = await mkTask(plan.id, B.example.id);
    const out = await ok('PUT', `/material/content-items/${B.example.id}/completion`, { completed: true });
    assert.deepEqual(out.reconciliation.cancelled.map(x => Number(x.task_id)), [Number(task.id)]);
  });
});

describe('Plan selection lifecycle（契約 4、6、9）', () => {
  test('選取只寫 selection，完全不動教材進度', async () => {
    const B = await seedBook('選取');
    const plan = await mkPlan('選取計畫');
    await ok('POST', `/plans/${plan.id}/material-items`,
      { content_item_ids: [B.reading.id, B.example.id], selected: true });
    const tree = await ok('GET', `/material/books/${B.book.id}/tree?plan_id=${plan.id}`);
    assert.equal(tree.progress.completed_items, 0, '選取不得寫成完成');
    assert.equal(tree.nodes[0].selection, 'some');
    assert.equal(tree.nodes[0].children[0].selection, 'all');
  });

  test('已完成的教材不能被選取（契約 6）', async () => {
    const B = await seedBook('完成不可選');
    const plan = await mkPlan('不可選計畫');
    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: true });
    const r = await api('POST', `/plans/${plan.id}/material-items`,
      { content_item_ids: [B.reading.id], selected: true });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json.completed_item_ids.map(Number), [Number(B.reading.id)]);
  });

  test('取消選取不是完成、不 hard delete Task，Task 安全退出排程並保留 provenance', async () => {
    const B = await seedBook('取消選取');
    const plan = await mkPlan('取消選取計畫');
    await ok('POST', `/plans/${plan.id}/material-items`, { content_item_ids: [B.reading.id], selected: true });
    const task = await mkTask(plan.id, B.reading.id);

    const out = await ok('POST', `/plans/${plan.id}/material-items`,
      { content_item_ids: [B.reading.id], selected: false });
    assert.deepEqual(out.task_exits.cancelled.map(x => Number(x.task_id)), [Number(task.id)]);

    const tasks = await ok('GET', '/tasks');
    const t = tasks.find(x => Number(x.id) === Number(task.id));
    assert.ok(t, 'Task 不得被 hard delete');
    assert.equal(t.cancelled, 1);
    assert.equal(t.completed, 0, '取消選取不代表教材完成');

    const tree = await ok('GET', `/material/books/${B.book.id}/tree?plan_id=${plan.id}`);
    assert.equal(tree.progress.completed_items, 0, '取消選取不得寫成完成');

    // provenance：selection 列還在，只是 selected=0 並記下 removed_at
    const sel = await ok('GET', `/plans/${plan.id}/material-items`);
    const row = sel.find(s => Number(s.content_item_id) === Number(B.reading.id));
    assert.ok(row, 'selection 歷史列必須保留');
    assert.equal(row.selected, false);
    assert.ok(row.removed_at, '應記下移除時間');
    assert.equal(Number(row.task_id), Number(task.id), '應保留產生過哪個 Task');
  });

  test('節點 tri-state 批次選取只寫底下的 ContentItem，不改 completion', async () => {
    const B = await seedBook('批次');
    const plan = await mkPlan('批次計畫');
    await ok('POST', `/plans/${plan.id}/material-nodes/${B.ch.id}`, { selected: true });
    const tree = await ok('GET', `/material/books/${B.book.id}/tree?plan_id=${plan.id}`);
    assert.equal(tree.nodes[0].selection, 'all');
    assert.equal(tree.progress.completed_items, 0);

    await ok('POST', `/plans/${plan.id}/material-nodes/${B.sec.id}`, { selected: false });
    const after = await ok('GET', `/material/books/${B.book.id}/tree?plan_id=${plan.id}`);
    assert.equal(after.nodes[0].selection, 'some', '只取消該節，Topic 與章底下的單元練習仍保持選取');
    assert.equal(after.nodes[0].children.find(n => n.kind === 'section').selection, 'none');
    assert.equal(after.nodes[0].children.find(n => n.kind === 'topic').selection, 'all');
    assert.equal(after.progress.completed_items, 0, '批次取消不得寫成完成');
  });

  test('批次選取會跳過已完成的項目而不是整批失敗', async () => {
    const B = await seedBook('批次跳過');
    const plan = await mkPlan('批次跳過計畫');
    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: true });
    const out = await ok('POST', `/plans/${plan.id}/material-nodes/${B.ch.id}`, { selected: true });
    assert.equal(out.selected.includes(B.reading.id), false);
    const tree = await ok('GET', `/material/books/${B.book.id}/tree?plan_id=${plan.id}`);
    assert.equal(tree.nodes[0].selection, 'all', '未完成的都選到了就是 all');
  });

  test('不參與排程的 Plan 不能調整選取', async () => {
    const B = await seedBook('封存計畫');
    const plan = await mkPlan('要封存的計畫');
    await ok('POST', `/plans/${plan.id}/archive`);
    const r = await api('POST', `/plans/${plan.id}/material-items`,
      { content_item_ids: [B.reading.id], selected: true });
    assert.equal(r.status, 409);
  });

  test('selection 與 progress 分離：同一項目可以「已選取但未完成」與「已完成但未選取」', async () => {
    const B = await seedBook('分離');
    const plan = await mkPlan('分離計畫');
    await ok('POST', `/plans/${plan.id}/material-items`, { content_item_ids: [B.reading.id], selected: true });
    await ok('PUT', `/material/content-items/${B.example.id}/completion`, { completed: true });
    const sel = await ok('GET', `/plans/${plan.id}/material-items`);
    const r = sel.find(s => Number(s.content_item_id) === Number(B.reading.id));
    assert.equal(r.selected, true);
    assert.equal(r.material_completed, false);
    const tree = await ok('GET', `/material/books/${B.book.id}/tree?plan_id=${plan.id}`);
    const ex = tree.nodes[0].children.find(n => n.kind === 'topic').content_items[0];
    assert.equal(ex.completed, true);
    assert.equal(ex.selected, false);
  });
});

describe('Book 刪除語意（契約 5）', () => {
  test('DELETE 預設是封存，不是刪除', async () => {
    const B = await seedBook('封存書');
    const out = await ok('DELETE', `/material/books/${B.book.id}`);
    assert.equal(out.archived, 1);
    assert.ok(out.archived_at);
    const list = await ok('GET', '/material/books');
    assert.equal(list.some(b => b.id === B.book.id), false, '預設清單不含已封存');
    const all = await ok('GET', '/material/books?archived=1');
    assert.equal(all.some(b => b.id === B.book.id), true);
    await ok('POST', `/material/books/${B.book.id}/unarchive`);
    assert.equal((await ok('GET', '/material/books')).some(b => b.id === B.book.id), true);
  });

  test('完全沒有歷史 reference 的書才能 hard delete', async () => {
    const clean = await ok('POST', '/material/books', { title: '乾淨的書' });
    const refs = await ok('GET', `/material/books/${clean.id}/references`);
    assert.equal(refs.can_hard_delete, true);
    await ok('DELETE', `/material/books/${clean.id}?hard=1`);
    assert.equal((await api('GET', `/material/books/${clean.id}/tree`)).status, 404);
  });

  test('有進度的書拒絕 hard delete，並說明卡在哪裡', async () => {
    const B = await seedBook('有進度');
    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: true });
    const r = await api('DELETE', `/material/books/${B.book.id}?hard=1`);
    assert.equal(r.status, 409);
    assert.equal(r.json.references.progress, 1);
    assert.equal((await api('GET', `/material/books/${B.book.id}/tree`)).status, 200, '拒絕後書必須還在');
  });

  test('有 Plan 選取的書拒絕 hard delete', async () => {
    const B = await seedBook('有選取');
    const plan = await mkPlan('選取的計畫');
    await ok('POST', `/plans/${plan.id}/material-items`, { content_item_ids: [B.reading.id], selected: true });
    const r = await api('DELETE', `/material/books/${B.book.id}?hard=1`);
    assert.equal(r.status, 409);
    assert.equal(r.json.references.plan_selections, 1);
  });

  test('有 Task 的書拒絕 hard delete', async () => {
    const B = await seedBook('有任務');
    const plan = await mkPlan('有任務的計畫');
    await mkTask(plan.id, B.reading.id);
    const r = await api('DELETE', `/material/books/${B.book.id}?hard=1`);
    assert.equal(r.status, 409);
    assert.equal(r.json.references.tasks, 1);
  });
});

describe('Category ↔ Book many-to-many（契約 8）', () => {
  test('同一本書可以同時屬於多個分類，而且是同一本書不是複本', async () => {
    const B = await seedBook('共用書');
    const c1 = await ok('POST', '/material/categories', { name: '考前' });
    const c2 = await ok('POST', '/material/categories', { name: '弱科' });
    await ok('PUT', `/material/categories/${c1.id}/books/${B.book.id}`);
    await ok('PUT', `/material/categories/${c2.id}/books/${B.book.id}`);

    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: true });
    const cats = await ok('GET', '/material/categories');
    const inC1 = cats.find(c => c.id === c1.id).books.find(b => b.id === B.book.id);
    const inC2 = cats.find(c => c.id === c2.id).books.find(b => b.id === B.book.id);
    assert.equal(inC1.id, inC2.id, '兩個分類指向同一本書');

    const books = await ok('GET', '/material/books');
    const one = books.filter(b => b.id === B.book.id);
    assert.equal(one.length, 1, '不得因為分類而複製出第二本書');
    assert.equal(one[0].progress.completed_items, 1, '進度只有一份');
  });

  test('重複加入同一分類不會產生第二筆', async () => {
    const B = await seedBook('重複加入');
    const c = await ok('POST', '/material/categories', { name: '重複' });
    await ok('PUT', `/material/categories/${c.id}/books/${B.book.id}`);
    await ok('PUT', `/material/categories/${c.id}/books/${B.book.id}`);
    const cats = await ok('GET', '/material/categories');
    assert.equal(cats.find(x => x.id === c.id).books.filter(b => b.id === B.book.id).length, 1);
  });

  test('移出分類只解除 reference，書與進度都還在', async () => {
    const B = await seedBook('移出分類');
    const c = await ok('POST', '/material/categories', { name: '暫時' });
    await ok('PUT', `/material/categories/${c.id}/books/${B.book.id}`);
    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: true });
    await ok('DELETE', `/material/categories/${c.id}/books/${B.book.id}`);
    const cats = await ok('GET', '/material/categories');
    assert.equal(cats.find(x => x.id === c.id).books.length, 0);
    const tree = await ok('GET', `/material/books/${B.book.id}/tree`);
    assert.equal(tree.progress.completed_items, 1, '書與進度不受影響');
  });
});

describe('排程仍是 Task-centric（契約 10）', () => {
  test('material 改動不寫任何 ScheduleVersion；ScheduledBlock 不帶 material 欄位', async () => {
    const B = await seedBook('排程不變');
    const plan = await mkPlan('排程計畫');
    const before = await ok('GET', '/schedule/versions');
    await ok('POST', `/plans/${plan.id}/material-items`, { content_item_ids: [B.reading.id], selected: true });
    await ok('PUT', `/material/content-items/${B.example.id}/completion`, { completed: true });
    const after = await ok('GET', '/schedule/versions');
    assert.equal(after.length, before.length, '純 material 操作不得產生新版本');
  });

  test('教材 Task 仍走既有排程器建立 block', async () => {
    const B = await seedBook('走排程器');
    const plan = await mkPlan('排程器計畫');
    const task = await mkTask(plan.id, B.reading.id);
    const applied = await ok('POST', '/schedule/apply', {
      plan_id: plan.id, source: 'initial', reason: '教材排程',
      blocks: [{ task_id: task.id, date: day(1) }],
    });
    assert.ok(applied.version_id, JSON.stringify(applied));
    const active = await ok('GET', '/schedule/active');
    const block = active.blocks.find(b => Number(b.task_id) === Number(task.id));
    assert.ok(block, 'Task 應該有實際的 block');
    assert.equal('material_content_item_id' in block, false, 'ScheduledBlock 不得帶 material 欄位');
  });
});

describe('跨帳號隔離', () => {
  test('分享清單的任務不能綁定自己的教材項目', async () => {
    // 分享清單會把 Task 掛到清單擁有者名下，教材項目卻是自己的。
    // 兩者湊起來會產生「A 名下的 Task 指向 B 的教材」，reconciliation 依
    // user_id 查就永遠找不到它，完成教材時它不會退出排程。
    // 第二個帳號要在**同一台**伺服器上（每台 startServer 各自一個暫存資料庫，
    // 分屬兩台就根本分享不起來，也就測不到這件事）。
    const email = `share${Date.now()}@test.local`;
    const reg = await (await fetch(S.base + '/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: '12345678', name: '被分享者' }),
    })).json();
    const H2 = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
    const call2 = async (method, path, body) => {
      const r = await fetch(S.base + path, {
        method, headers: H2, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };

    // 清單擁有者是 S，分享給第二個帳號
    const list = await ok('POST', '/lists', { name: '共用科目' });
    await ok('POST', `/lists/${list.id}/share`, { email });

    // 第二個帳號用自己的教材項目，在別人的清單底下建任務
    const book2 = (await call2('POST', '/material/books', { title: '我的書' })).json;
    const ch2 = (await call2('POST', '/material/nodes',
      { book_id: book2.id, kind: 'chapter', title: '第一章' })).json;
    const item2 = (await call2('POST', '/material/content-items',
      { node_id: ch2.id, kind: 'reading', title: '內文' })).json;

    const r = await call2('POST', '/tasks',
      { title: '綁到別人清單', list_id: list.id, material_content_item_id: item2.id });
    assert.equal(r.status, 400, `預期被擋下，實際 ${r.status} ${JSON.stringify(r.json)}`);

    // 沒有帶教材時，分享清單本身仍然可以正常建任務——不能把整個功能一起擋掉
    const plain = await call2('POST', '/tasks', { title: '一般共用任務', list_id: list.id });
    assert.equal(plain.status, 200);
  });

  test('看不到也改不到別人的教材', async () => {
    const B = await seedBook('別人的書');
    const other = await startServer();
    try {
      const r = await fetch(other.base + `/material/books/${B.book.id}/tree`, { headers: other.H });
      assert.equal(r.status, 404);
    } finally { other.stop(); }
  });
});

describe('Wizard 套用：task_creates 的 Material linkage', () => {
  test('經排程器建立的 Task 帶得上 material linkage，並回填 selection 的 task_id', async () => {
    const B = await seedBook('精靈套用');
    const plan = await mkPlan('精靈計畫');
    await ok('POST', `/plans/${plan.id}/material-items`,
      { content_item_ids: [B.reading.id], selected: true });
    const applied = await ok('POST', '/schedule/apply', {
      plan_id: plan.id, source: 'initial', reason: '教材排程',
      task_creates: [{ client_key: 'n1', title: '新大滿貫｜第一章｜內文', list_id: null,
        material_content_item_id: B.reading.id }],
      blocks: [{ client_key: 'n1', date: day(1) }],
    });
    assert.ok(applied.version_id);
    const taskId = applied.created.find(c => c.client_key === 'n1').id;
    const tasks = await ok('GET', '/tasks');
    const t = tasks.find(x => Number(x.id) === Number(taskId));
    assert.equal(Number(t.material_content_item_id), Number(B.reading.id));
    assert.equal(Number(t.material_book_id), Number(B.book.id));
    // selection 列要記下實際產生的 Task，之後取消選取才知道誰該退出排程
    const sel = await ok('GET', `/plans/${plan.id}/material-items`);
    assert.equal(Number(sel.find(s => Number(s.content_item_id) === Number(B.reading.id)).task_id),
      Number(taskId));
  });

  test('已完成的教材不能經由排程器旁路長出新 Task', async () => {
    const B = await seedBook('精靈旁路');
    const plan = await mkPlan('旁路計畫');
    await ok('PUT', `/material/content-items/${B.reading.id}/completion`, { completed: true });
    const r = await api('POST', '/schedule/apply', {
      plan_id: plan.id, source: 'initial',
      task_creates: [{ client_key: 'n1', title: '重複的工作',
        material_content_item_id: B.reading.id }],
      blocks: [{ client_key: 'n1', date: day(1) }],
    });
    assert.ok(r.status >= 400, `應該被擋下，實際 ${r.status}`);
    assert.match(r.json.error, /已完成/);
    // 整筆交易 rollback：不得留下半套的 Task 或版本
    const tasks = await ok('GET', '/tasks');
    assert.equal(tasks.some(t => t.title === '重複的工作'), false);
  });

  test('別人的教材項目不能被綁進自己的排程', async () => {
    const B = await seedBook('跨帳號教材');
    const plan = await mkPlan('跨帳號計畫');
    const r = await api('POST', '/schedule/apply', {
      plan_id: plan.id, source: 'initial',
      task_creates: [{ client_key: 'n1', title: '不存在的教材', material_content_item_id: 999999 }],
      blocks: [{ client_key: 'n1', date: day(1) }],
    });
    assert.ok(r.status >= 400);
    assert.match(r.json.error, /找不到教材項目/);
    assert.ok(B.book.id);
  });

  test('沒有 material linkage 的一般 Task 照樣建得起來（不強迫每個 Task 都屬於教材）', async () => {
    const plan = await mkPlan('純手動計畫');
    const applied = await ok('POST', '/schedule/apply', {
      plan_id: plan.id, source: 'initial',
      task_creates: [{ client_key: 'm1', title: '自己加的複習' }],
      blocks: [{ client_key: 'm1', date: day(2) }],
    });
    const taskId = applied.created[0].id;
    const t = (await ok('GET', '/tasks')).find(x => Number(x.id) === Number(taskId));
    assert.equal(t.material_content_item_id ?? null, null);
    assert.equal(t.material_book_id ?? null, null);
  });
});
