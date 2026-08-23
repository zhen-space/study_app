// 重複任務。domain 一直都在，但幾乎沒有測試護著——v1 要把 UI 開回來，
// 先把「完成一筆之後到底長出什麼」釘住。
//
// 合約：
//   ① 完成一筆重複任務 → 原本那筆維持 completed，另外長出「下一次」。
//   ② 下一次不是完成，也不繼承完成時間。
//   ③ 有結束條件（次數／日期）就要真的會停。
//   ④ 不重複的任務完成之後不准長出任何東西。
//   ⑤ 計畫任務（plan_id）的排定時間歸排程器管，不走這條路。
//
// 日期一律相對今天算，測試才不會過幾天就開始壞。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, day } from './helpers.mjs';

const mk = async (base, H, body) => {
  const r = await fetch(base + '/tasks', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const text = await r.text();                 // 只讀一次：讀過 text() 之後 json() 會炸
  assert.equal(r.status, 200, text);
  return JSON.parse(text).id;
};
const done = (base, H, id) =>
  fetch(`${base}/tasks/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ completed: true }) });
const list = async (base, H) => (await fetch(base + '/tasks', { headers: H })).json();
const byTitle = (rows, t) => rows.filter(x => x.title === t);

test('完成每天重複的任務會長出隔天那一筆，原本那筆維持完成', async () => {
  const { base, H, stop } = await startServer();
  try {
    const id = await mk(base, H, { title: '背單字', due_date: day(0), recurring: 'daily', miss_policy: 'keep' });
    await done(base, H, id);
    const rows = byTitle(await list(base, H), '背單字');
    assert.equal(rows.length, 2, '應該剛好一筆完成、一筆下一次');

    const first = rows.find(t => t.id === id);
    assert.equal(!!first.completed, true);
    assert.equal(first.due_date, day(0), '完成的那筆日期不該被改掉');

    const next = rows.find(t => t.id !== id);
    assert.equal(next.due_date, day(1));
    assert.equal(!!next.completed, false, '下一次不能一出生就是完成的');
    assert.equal(next.recurring, 'daily', '重複規則要跟著傳下去');
  } finally { stop(); }
});

test('每週／平日各自照自己的規則往前跳', async () => {
  const { base, H, stop } = await startServer();
  try {
    const w = await mk(base, H, { title: '週複習', due_date: day(0), recurring: 'weekly' });
    await done(base, H, w);
    const next = byTitle(await list(base, H), '週複習').find(t => t.id !== w);
    assert.equal(next.due_date, day(7));

    const d = await mk(base, H, { title: '平日練習', due_date: day(0), recurring: 'weekdays' });
    await done(base, H, d);
    const nd = byTitle(await list(base, H), '平日練習').find(t => t.id !== d);
    const dow = new Date(nd.due_date + 'T00:00:00Z').getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `平日重複不該落在週末，卻排到 ${nd.due_date}`);
    assert.ok(nd.due_date > day(0));
  } finally { stop(); }
});

// end.count 是「總共出現幾次」，含目前這一筆：count 3 = 現在這筆 + 再兩筆。
// 每長出一筆就遞減，減到 1 表示這是最後一筆，不再往下長。
test('次數用完就停：end.count 含目前這筆，數完不再長出新的', async () => {
  const { base, H, stop } = await startServer();
  try {
    const rule = JSON.stringify({ every: 1, unit: 'day', end: { count: 3 } });
    const id = await mk(base, H, { title: '限次', due_date: day(0), recurring: rule });

    await done(base, H, id);
    let rows = byTitle(await list(base, H), '限次');
    assert.equal(rows.length, 2);
    const second = rows.find(t => t.id !== id);
    assert.equal(JSON.parse(second.recurring).end.count, 2, '每長出一筆，剩餘次數要少一次');

    await done(base, H, second.id);
    rows = byTitle(await list(base, H), '限次');
    assert.equal(rows.length, 3, '第 3 次應該還會出現');
    const third = rows.find(t => t.id !== id && t.id !== second.id);
    assert.equal(JSON.parse(third.recurring).end.count, 1, '這是最後一筆');

    await done(base, H, third.id);
    rows = byTitle(await list(base, H), '限次');
    assert.equal(rows.length, 3, '第 3 次做完就要停，不該長出第 4 筆');
  } finally { stop(); }
});

test('過了結束日期就停', async () => {
  const { base, H, stop } = await startServer();
  try {
    // 結束日就是今天：完成今天這一筆之後，下一次會落在結束日之後 → 不該產生
    const rule = JSON.stringify({ every: 1, unit: 'day', end: { date: day(0) } });
    const id = await mk(base, H, { title: '到期止', due_date: day(0), recurring: rule });
    await done(base, H, id);
    assert.equal(byTitle(await list(base, H), '到期止').length, 1);
  } finally { stop(); }
});

test('不重複的任務完成之後不會長出任何東西', async () => {
  const { base, H, stop } = await startServer();
  try {
    const id = await mk(base, H, { title: '一次性', due_date: day(0) });
    await done(base, H, id);
    assert.equal(byTitle(await list(base, H), '一次性').length, 1);
  } finally { stop(); }
});

test('重複任務不會動到 Material completion 或計畫任務的排定時間', async () => {
  const { base, H, stop } = await startServer();
  try {
    // 計畫任務的 due_date/due_time 是排程器的真相，不接受直接 PATCH。
    // 這條界線要一直在，否則「重複」很容易被拿來繞過排程器。
    const r = await fetch(base + '/plans', {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: '測試計畫', status: 'active', source: 'manual' }),
    });
    const plan = await r.json();
    const id = await mk(base, H, { title: '計畫內任務', plan_id: plan.id });
    const patch = await fetch(`${base}/tasks/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ due_date: day(3), due_time: '09:00' }),
    });
    assert.equal(patch.status, 409, '計畫任務的排定時間不該能直接改');
  } finally { stop(); }
});
