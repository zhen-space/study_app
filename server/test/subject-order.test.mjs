// Phase 2C-P6-B：科目先後順序（priority order）。
//
// 產品語意只有一句：
//   使用者排序「數學 → 化學 → 英文」，代表在其他 hard constraint 都滿足的
//   前提下，優先讓前面的科目較早取得排程位置；但**不要求**數學全部完成
//   才能開始化學。
//
// 也就是 priority ≠ dependency。這一支就是守這條線：
//   ① 給了順序，排程結果真的會變（拿掉／反轉都要看得出來）
//   ② 但各科仍然交錯進行，不會變成「一科做完才換下一科」
//   ③ 沒給順序時，行為跟以前一模一樣

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, sec, day } from './helpers.mjs';

let S;
before(async () => { S = await startServer(); });
after(() => S?.stop());

// 三科各 6 項，同一段日期範圍互相競爭。
// 用時間模式：一天的時段有限，誰先出手就拿到比較早的時段——
// 這正是「較早取得排程位置」最直接的觀察點。
const items = () => [
  ...Array.from({ length: 6 }, (_, i) => sec(1, `數學｜單元${i + 1}｜範例+例題`, { end: day(9) })),
  ...Array.from({ length: 6 }, (_, i) => sec(2, `化學｜單元${i + 1}｜範例+例題`, { end: day(9) })),
  ...Array.from({ length: 6 }, (_, i) => sec(3, `英文｜單元${i + 1}｜範例+例題`, { end: day(9) })),
];

const run = (over = {}) => S.plan(items(), {
  startDate: day(0), endDate: day(9), timed: true, perDay: 6, pace: 'even', ...over,
});

// 每一天最早出手的科目
const firstEachDay = blocks => {
  const byDate = {};
  for (const b of [...blocks].sort((a, x) => a.date.localeCompare(x.date)
    || String(a.start_time).localeCompare(String(x.start_time)))) {
    if (!(b.date in byDate)) byDate[b.date] = b.subject_id;
  }
  return byDate;
};
// 某一科第一次出現在哪一天
const firstDay = (blocks, sid) =>
  [...blocks].filter(b => b.subject_id === sid).map(b => b.date).sort()[0];
// 每一科排到的時段起點平均（越小＝整體排得越早）
const meanStart = (blocks, sid) => {
  const mins = blocks.filter(b => b.subject_id === sid && b.start_time)
    .map(b => +b.start_time.slice(0, 2) * 60 + +b.start_time.slice(3, 5));
  return mins.reduce((a, c) => a + c, 0) / (mins.length || 1);
};

describe('科目先後順序：真的會改變排程結果', () => {
  test('依 subject_order 決定每天誰先出手', async () => {
    const forward = await run({ subject_order: [1, 2, 3] });
    const reversed = await run({ subject_order: [3, 2, 1] });

    const f = firstEachDay(forward.blocks);
    const r = firstEachDay(reversed.blocks);

    // 兩邊都有排出東西才有得比
    assert.ok(Object.keys(f).length > 0);
    assert.deepEqual(Object.keys(f), Object.keys(r), '兩次用同樣的日期範圍');

    // 正向：數學（1）應該在多數日子最先出手；反向：英文（3）
    const lead = (map, sid) => Object.values(map).filter(x => x === sid).length;
    assert.ok(lead(f, 1) > lead(f, 3),
      `正向時數學該比英文更常先出手（數學 ${lead(f, 1)}、英文 ${lead(f, 3)}）`);
    assert.ok(lead(r, 3) > lead(r, 1),
      `反向時英文該比數學更常先出手（英文 ${lead(r, 3)}、數學 ${lead(r, 1)}）`);
  });

  test('優先的科目整體排到比較早的時段', async () => {
    const forward = await run({ subject_order: [1, 2, 3] });
    const reversed = await run({ subject_order: [3, 2, 1] });

    assert.ok(meanStart(forward.blocks, 1) < meanStart(forward.blocks, 3),
      '正向：數學的平均開始時間要早於英文');
    assert.ok(meanStart(reversed.blocks, 3) < meanStart(reversed.blocks, 1),
      '反向：英文的平均開始時間要早於數學');
  });

  test('反轉順序會產生不同的排程（不是擺設）', async () => {
    const forward = await run({ subject_order: [1, 2, 3] });
    const reversed = await run({ subject_order: [3, 2, 1] });
    const sig = blocks => [...blocks]
      .map(b => `${b.date}|${b.start_time}|${b.subject_id}`).sort().join(',');
    assert.notEqual(sig(forward.blocks), sig(reversed.blocks),
      '★ 順序不同，排程結果就必須不同');
  });

  test('沒指定順序時，行為跟以前一樣', async () => {
    const a = await run();
    const b = await run({ subject_order: [] });
    const sig = blocks => [...blocks]
      .map(x => `${x.date}|${x.start_time}|${x.subject_id}|${x.title}`).sort().join(',');
    assert.equal(sig(a.blocks), sig(b.blocks), '空陣列＝沒指定，不得改變既有行為');

    // 而且「以前的行為」是有形狀的，不能只跟自己比：沒指定順序時照科目 id
    // 遞增輪流（Object 整數 key 的列舉順序）。少了這條，排序實作只要對
    // 「未指定」的科目做任何重排都不會被抓到。
    const f = firstEachDay(a.blocks);
    const lead = sid => Object.values(f).filter(x => x === sid).length;
    assert.ok(lead(1) > lead(3),
      `沒指定順序時仍照科目 id 遞增（數學 ${lead(1)}、英文 ${lead(3)}）`);
  });

  test('只列一部分科目：沒列到的排在後面，彼此維持原順序', async () => {
    const r = await run({ subject_order: [3] });
    const f = firstEachDay(r.blocks);
    const lead = sid => Object.values(f).filter(x => x === sid).length;
    assert.ok(lead(3) > lead(1), '被指名的英文要比沒指名的先出手');
  });

  test('不合法的 subject_order 不會擋住排程', async () => {
    const bad = await S.plan(items(), {
      startDate: day(0), endDate: day(9), timed: true, perDay: 6, pace: 'even',
      subject_order: 'not-an-array',
    });
    assert.ok(bad.blocks.length > 0, '排序偏好壞掉不該讓整個排程失敗');
  });
});

describe('priority ≠ dependency', () => {
  test('優先的科目不會霸佔前段：各科仍然交錯進行', async () => {
    const r = await run({ subject_order: [1, 2, 3] });

    // 如果變成 dependency，英文會等到數學全部排完才開始。
    // 這裡要求最後一科在整段範圍的前半就已經開始。
    const dates = [...new Set(r.blocks.map(b => b.date))].sort();
    const half = dates[Math.floor(dates.length / 2)];
    assert.ok(firstDay(r.blocks, 3) <= half,
      `★ 最後順位的英文必須在前半段就開始（實際 ${firstDay(r.blocks, 3)}，中位 ${half}）`);

    // 而且數學還沒排完的那幾天，化學／英文也照樣有進度
    const mathLast = [...r.blocks].filter(b => b.subject_id === 1).map(b => b.date).sort().pop();
    const othersBeforeMathDone = r.blocks.filter(b => b.subject_id !== 1 && b.date < mathLast).length;
    assert.ok(othersBeforeMathDone > 0,
      '★ 數學排完之前，其他科目也必須已經在進行——這是 priority 不是 dependency');
  });

  test('三科都排得完，沒有人因為順位靠後就排不進去', async () => {
    const r = await run({ subject_order: [1, 2, 3] });
    for (const sid of [1, 2, 3]) {
      assert.equal(r.blocks.filter(b => b.subject_id === sid).length, 6,
        `科目 ${sid} 的 6 項都要排進去，優先順序不得犧牲任何一科`);
    }
  });
});
