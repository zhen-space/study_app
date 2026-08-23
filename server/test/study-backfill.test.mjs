// 補登：真的讀了，只是當下沒開計時器，事後補記。
//
// 合約：
//   ① 補登是正式 StudySession——分鐘數要進 actual_minutes 與 /tstats 的
//      今日／科目／總計，跟即時計時完全一樣。
//   ② 補登不是 live session：不建立 running / paused，也不佔用
//      「同時只能有一個進行中」那條 invariant。
//   ③ 補登不碰 Material completion、不碰 Plan selection、不碰 ScheduledBlock。
//   ④ 時區：使用者填的是台灣時間，統計要算在台灣的那一天。
//   ⑤ 補的是已經發生的事，未來時間補不出來。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day } from './helpers.mjs';

const post = async (base, H, path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const get = async (base, H, path) => (await fetch(base + path, { headers: H })).json();

// 建一個科目 + 一個掛在該科目底下的任務
async function seed(base, H) {
  const list = (await post(base, H, '/lists', { name: '數學', color: '#111111' })).body;
  const task = (await post(base, H, '/tasks', { title: '複習三角函數', list_id: list.id })).body;
  return { listId: list.id, taskId: task.id };
}

// 用「昨天」而不是「今天某個時刻」：測試可能在一天中的任何時間跑，
// 挑今天 14:00 會在早上跑測試時變成未來時間，被未來守衛擋下來。
test('補登的分鐘數算進 actual_minutes、當天讀書時間與科目分項', async () => {
  const { base, H, stop } = await startServer();
  try {
    const { taskId } = await seed(base, H);
    const r = await post(base, H, '/study-sessions/backfill',
      { task_id: taskId, date: day(-1), start_time: '14:00', minutes: 90 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.actual_minutes, 90);
    assert.equal(r.body.status, 'completed');
    assert.equal(r.body.source, 'backfill');

    const stats = await get(base, H, '/tstats');
    assert.equal(stats.actualTotal, 90, '總實際讀書時間要含補登');
    assert.equal(stats.actualByDay[day(-1)], 90, '要算在補登指定的那一天');
    assert.equal(stats.bySubject['數學'], 90, '科目分項要含補登');
  } finally { stop(); }
});

test('補登不建立 live session，也不佔用「同時只能有一個進行中」', async () => {
  const { base, H, stop } = await startServer();
  try {
    const { taskId } = await seed(base, H);

    // 先開一個真的 live session
    const live = await post(base, H, '/study-sessions', { task_id: taskId, source: 'manual' });
    assert.equal(live.status, 201);

    // live 還開著時仍然補得了登——補登講的是「已經讀完」，不是「正在讀」
    const back = await post(base, H, '/study-sessions/backfill',
      { task_id: taskId, date: day(-1), start_time: '20:00', minutes: 45 });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.equal(back.body.running_since, null, '補登不能留下 running_since');

    // 而且 live session 仍然只有那一個
    const rows = await get(base, H, '/study-sessions');
    const alive = rows.filter(s => s.status === 'running' || s.status === 'paused');
    assert.equal(alive.length, 1);
    assert.equal(alive[0].id, live.body.id);

    // 補登之後，第二個 live session 仍然要被擋下來
    const second = await post(base, H, '/study-sessions', { task_id: taskId, source: 'manual' });
    assert.equal(second.status, 409);
  } finally { stop(); }
});

test('台灣時間凌晨補登要算在台灣的那一天，不會掉到前一天', async () => {
  const { base, H, stop } = await startServer();
  try {
    const { taskId } = await seed(base, H);
    // 00:30（台灣）＝前一天 16:30 UTC。照 UTC 切日期就會算成前一天。
    const r = await post(base, H, '/study-sessions/backfill',
      { task_id: taskId, date: day(-1), start_time: '00:30', minutes: 30 });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const stats = await get(base, H, '/tstats');
    assert.equal(stats.actualByDay[day(-1)], 30, '應該算在使用者填的那一天');
    assert.equal(stats.actualByDay[day(-2)], undefined, '不該掉到前一天');
  } finally { stop(); }
});

test('補登不會把教材標成完成，也不動計畫選取', async () => {
  const { base, H, stop } = await startServer();
  try {
    // 建一本教材：一章一節一項內容
    const book = (await post(base, H, '/material/books', { title: '數學課本' })).body;
    const chapter = (await post(base, H, '/material/nodes',
      { book_id: book.id, kind: 'chapter', title: '第一章' })).body;
    const section = (await post(base, H, '/material/nodes',
      { book_id: book.id, parent_id: chapter.id, kind: 'section', title: '1-1' })).body;
    const item = (await post(base, H, '/material/content-items',
      { node_id: section.id, kind: 'reading', title: '課本內容' })).body;

    const task = (await post(base, H, '/tasks',
      { title: '讀 1-1', material_content_item_id: item.id, material_book_id: book.id })).body;

    const before = await get(base, H, `/material/books/${book.id}/tree`);
    const r = await post(base, H, '/study-sessions/backfill',
      { task_id: task.id, date: day(-1), start_time: '09:00', minutes: 60 });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const after = await get(base, H, `/material/books/${book.id}/tree`);
    assert.deepEqual(
      after.nodes[0].children[0].content_items.map(i => i.completed),
      before.nodes[0].children[0].content_items.map(i => i.completed),
      '補登時間不代表教材做完了，completed 必須原封不動');
    assert.equal(after.progress.completed_items, before.progress.completed_items);
  } finally { stop(); }
});

test('擋掉補不出來的東西：未來時間、壞格式、非正整數分鐘', async () => {
  const { base, H, stop } = await startServer();
  try {
    const { taskId } = await seed(base, H);
    const bad = async (body, why) => {
      const r = await post(base, H, '/study-sessions/backfill', { task_id: taskId, ...body });
      assert.equal(r.status, 400, `${why} 應該被擋下來`);
      assert.ok(r.body.error, '要說得出為什麼');
    };
    await bad({ date: day(3), start_time: '09:00', minutes: 30 }, '未來的日期');
    await bad({ date: '8/23', start_time: '09:00', minutes: 30 }, '日期格式不對');
    await bad({ date: day(0), start_time: '25:00', minutes: 30 }, '時間格式不對');
    await bad({ date: day(0), start_time: '09:00', minutes: 0 }, '零分鐘');
    await bad({ date: day(0), start_time: '09:00', minutes: -5 }, '負分鐘');
    await bad({ date: day(0), start_time: '09:00', minutes: 1.5 }, '非整數分鐘');
    await bad({ date: day(0), start_time: '09:00', minutes: 24 * 60 + 1 }, '超過 24 小時');

    const r = await post(base, H, '/study-sessions/backfill',
      { task_id: 999999, date: day(0), start_time: '09:00', minutes: 30 });
    assert.equal(r.status, 400, '別人的／不存在的任務補不了');
  } finally { stop(); }
});

test('補登不會被誤認成 live session：source 只能由這支端點寫成 backfill', async () => {
  const { base, H, stop } = await startServer();
  try {
    const { taskId } = await seed(base, H);
    // 一般 POST 帶 source: 'backfill' 會被打回 'manual'，不能藉此偽造補登紀錄
    const r = await post(base, H, '/study-sessions', { task_id: taskId, source: 'backfill' });
    assert.equal(r.status, 201);
    assert.equal(r.body.source, 'manual');
    assert.equal(r.body.status, 'running');
  } finally { stop(); }
});
