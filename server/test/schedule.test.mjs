// 排程演算法回歸測試
//   執行：cd server && npm test
//
// 每個 describe 對應一條使用者定下的規則；改演算法後這些必須全過。
// 測試會自己開一台伺服器（隨機埠 + 暫存 SQLite），不會動到開發／正式資料庫。
//
// 這些測試確實抓得到退步——把演算法故意改壞，對應的測試就會紅：
//   把「最後補位」改成不先看截止日          → 截止日／一科塞爆…      失敗
//   壓軸保留天數改用全域天數算              → 模考獨佔／保留天數…     失敗
//   拿掉「從標題推斷 onePerDay」            → 純題目／前端沒帶旗標…   失敗
//   讓純題目可以跟範例同日                  → 純題目／不與範例同日…   失敗
// 以上四項都是這個專案實際發生過的 bug。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, day, sec, pure, finalItem, book,
  isPure, isFinal, datesOf, perDay, countOn,
} from './helpers.mjs';

let S;
before(async () => { S = await startServer(); });
after(() => S?.stop());

/* ================= 1. 截止日是硬規則 ================= */
describe('截止日', () => {
  test('項目不會排到自己的截止日之後', async () => {
    const items = [
      ...book(1, '化學', 6, 4, ['單元練習'], { end: day(9) }),
      ...book(2, '生物', 6, 4, ['單元練習'], { end: day(29) }),
    ];
    const { blocks } = await S.plan(items, { endDate: day(29) });
    const endOf = Object.fromEntries(items.map(i => [i.title, i.end]));
    const over = blocks.filter(b => b.date > endOf[b.title]);
    assert.equal(over.length, 0,
      `有 ${over.length} 項超出截止日，例如 ${over[0]?.date} ${over[0]?.title}`);
  });

  test('只有一科延長時，其他科不會被排進延長的那幾天', async () => {
    // 實際踩過的 bug：補位時挑「最空的日子」，結果別科被丟到只有物理能用的尾端
    const items = [
      ...book(6, '物理', 8, 4, ['歷屆試題'], { end: day(35) }),
      ...book(2, '生物', 8, 4, ['歷屆試題'], { end: day(20) }),
      ...book(1, '化學', 6, 4, ['單元練習'], { end: day(20) }),
    ];
    const { blocks } = await S.plan(items, { endDate: day(35) });
    const late = blocks.filter(b => b.date > day(20) && b.subject_id !== 6);
    assert.equal(late.length, 0,
      `生物/化學被排到 ${day(20)} 之後：${late.slice(0, 3).map(b => b.date + ' ' + b.title).join('、')}`);
  });

  test('範圍極短也不會超出（寧可同一天多排）', async () => {
    const items = book(1, '化學', 8, 4, ['單元練習'], { end: day(2) });
    const { blocks } = await S.plan(items, { endDate: day(2) });
    assert.equal(blocks.filter(b => b.date > day(2)).length, 0);
  });

  test('一科塞爆到必須走最後補位，仍不得超出自己的截止日', async () => {
    // 這一組會逼到「完全放寬」的補位邏輯。那段若不先在項目自己的範圍內找，
    // 就會把排不下的項目丟到別科才用得到的後段日子（本季真實 bug）。
    const items = [
      ...book(1, '化學', 20, 4, ['單元練習'], { end: day(2) }),
      ...[1, 2, 3].map(n => finalItem(1, `化學第${n}次模考`, { end: day(2) })),
      ...book(6, '物理', 6, 3, [], { end: day(35) }),
    ];
    const { blocks } = await S.plan(items, { endDate: day(35) });
    const endOf = Object.fromEntries(items.map(i => [i.title, i.end]));
    const over = blocks.filter(b => b.date > endOf[b.title]);
    assert.equal(over.length, 0,
      `有 ${over.length} 項超出截止日，例如 ${over[0]?.date} ${over[0]?.title}`);
  });
});

/* ================= 2. 模考獨佔 ================= */
describe('模考獨佔', () => {
  const check = blocks => {
    const bad = [];
    for (const b of blocks.filter(x => isFinal(x.title))) {
      const same = blocks.filter(x => x !== b && x.date === b.date && x.subject_id === b.subject_id);
      if (same.length) bad.push(`${b.date} ${b.title} ← 同日同科還有 ${same.map(x => x.title).join('、')}`);
    }
    return bad;
  };

  test('模考當天，該科只有這一場', async () => {
    const items = [
      ...book(2, '生物', 8, 4, ['歷屆試題']),
      finalItem(2, '第1次模考'), finalItem(2, '第2次模考'), finalItem(2, '第3次模考'),
    ];
    const { blocks } = await S.plan(items);
    assert.deepEqual(check(blocks), []);
  });

  test('早點完成（pace=front）也一樣', async () => {
    const items = [
      ...book(2, '生物', 8, 4, ['歷屆試題']),
      finalItem(2, '第1次模考'), finalItem(2, '第2次模考'),
    ];
    const { blocks } = await S.plan(items, { pace: 'front' });
    assert.deepEqual(check(blocks), []);
  });

  test('多科各有壓軸也不互相干擾', async () => {
    const items = [
      ...book(1, '化學', 5, 4, ['單元練習']), finalItem(1, '化學第1次模考'),
      ...book(2, '生物', 5, 4, ['歷屆試題']), finalItem(2, '生物第1次模考'),
      ...book(4, '地科', 5, 3, ['歷屆試題']), finalItem(4, '地科第1次模考'),
    ];
    const { blocks } = await S.plan(items);
    assert.deepEqual(check(blocks), []);
  });

  test('模考排在該科所有一般項目之後，且場次順序遞增', async () => {
    const items = [
      ...book(2, '生物', 6, 4, ['歷屆試題']),
      finalItem(2, '第1次模考'), finalItem(2, '第2次模考'), finalItem(2, '第3次模考'),
    ];
    const { blocks } = await S.plan(items);
    const fin = blocks.filter(b => isFinal(b.title)).sort((a, b) => a.title.localeCompare(b.title));
    const normalMax = blocks.filter(b => !isFinal(b.title) && b.subject_id === 2)
      .reduce((m, b) => b.date > m ? b.date : m, '');
    assert.ok(fin.every(f => f.date > normalMax), `模考應晚於一般項目最後一天 ${normalMax}`);
    assert.deepEqual(fin.map(f => f.date), [...fin.map(f => f.date)].sort(),
      '第1次→第2次→第3次的日期必須遞增');
  });

  test('保留天數要用該科自己的可排日算', async () => {
    // 短窗科目（生物只到 day4）配長窗科目（物理到 day35）時，
    // 若保留天數用「全部日子」算，保留區會落在生物範圍外＝等於沒保留，
    // 模考就會被硬塞回去跟其他項目同日（本季真實 bug）。
    const items = [
      ...book(2, '生物', 3, 2, [], { end: day(4) }),
      ...[1, 2, 3, 4, 5, 6].map(n => finalItem(2, `第${n}次模考`, { end: day(4) })),
      ...book(6, '物理', 8, 3, [], { end: day(35) }),
    ];
    const { blocks } = await S.plan(items, { endDate: day(35) });
    assert.deepEqual(check(blocks), []);
  });

  test('天數很緊（6 天 5 場模考）也要守住', async () => {
    const items = [
      ...book(2, '生物', 2, 2, [], { end: day(5) }),
      ...[1, 2, 3, 4, 5].map(n => finalItem(2, `第${n}次模考`, { end: day(5) })),
    ];
    const { blocks } = await S.plan(items, { endDate: day(5) });
    assert.deepEqual(check(blocks), []);
  });
});

/* ================= 3. 純題目規則 ================= */
describe('純題目（單元練習／歷屆試題）', () => {
  // 規則：同日同科最多 2 份，且那天不可混「範例+例題」
  const check = blocks => {
    const bad = [];
    for (const b of blocks.filter(x => isPure(x.title))) {
      const same = blocks.filter(x => x !== b && x.date === b.date && x.subject_id === b.subject_id);
      const mixed = same.filter(x => !isPure(x.title));
      if (mixed.length) bad.push(`${b.date} ${b.title} ← 混到 ${mixed.map(x => x.title).join('、')}`);
      else if (same.length + 1 > 2) bad.push(`${b.date} ${b.title} ← 同日 ${same.length + 1} 份`);
    }
    return bad;
  };

  test('不與範例+例題同日、一天最多兩份', async () => {
    const { blocks } = await S.plan(book(4, '地科', 10, 4, ['單元練習', '歷屆試題']));
    assert.deepEqual(check(blocks), []);
  });

  test('天數寬裕時維持一天一份', async () => {
    const items = book(4, '地科', 8, 2, ['歷屆試題'], { end: day(59) });
    const { blocks } = await S.plan(items, { endDate: day(59) });
    const pureBlocks = blocks.filter(b => isPure(b.title));
    const days = new Set(pureBlocks.map(b => b.date));
    assert.equal(days.size, pureBlocks.length, '天數夠的時候應該一天一份');
  });

  test('前端沒帶 onePerDay 旗標時，伺服器要從標題認出來', async () => {
    // 精靈的「純題目」那條路徑曾經漏掉旗標，導致歷屆試題跟範例混在一起
    const items = [];
    for (let c = 1; c <= 8; c++) {
      for (let i = 1; i <= 3; i++) items.push(sec(6, `物理｜單元${c}｜節${i}｜範例+例題`));
      items.push(sec(6, `物理｜單元${c}｜歷屆試題`));   // 故意不加 onePerDay
    }
    const { blocks } = await S.plan(items);
    assert.deepEqual(check(blocks), []);
  });

  test('範圍真的不夠時會退讓，但一定要跳出提醒', async () => {
    // 40 份純題目塞 25 天，一天兩份也放不下 → 允許再擠，
    // 但必須在 check.tight 明講「這科幾份、需要幾天」，不能默默排壞
    const items = book(4, '地科', 20, 2, ['單元練習', '歷屆試題'], { end: day(24) });
    const { blocks, check: chk } = await S.plan(items, { endDate: day(24) });
    assert.equal(blocks.length, items.length, '退讓也不能弄丟項目');
    const t = chk.tight.find(x => x.subject_id === 4);
    assert.ok(t, '天數不夠卻沒有提醒');
    assert.ok(t.oneCount > t.haveDays, 'tight 應說明份數多於可用天數');
  });

  test('多科同時排也守得住', async () => {
    const items = [
      ...book(1, '化學', 8, 4, ['單元練習']),
      ...book(2, '生物', 8, 4, ['歷屆試題']),
      ...book(4, '地科', 8, 3, ['單元練習', '歷屆試題']),
      ...book(6, '物理', 6, 4, ['歷屆試題']),
    ];
    const { blocks } = await S.plan(items, { endDate: day(44) });
    assert.deepEqual(check(blocks), []);
  });
});

/* ================= 4. 任務不遺失 ================= */
describe('任務不遺失', () => {
  const same = (items, blocks) => {
    assert.equal(blocks.length, items.length, `送 ${items.length} 項、排出 ${blocks.length} 項`);
    const a = items.map(i => i.title).sort();
    const b = blocks.map(x => x.title).sort();
    assert.deepEqual(b, a, '排出來的項目必須跟送進去的一模一樣（不重複、不遺漏）');
  };

  test('一般情況全部排入', async () => {
    const items = [
      ...book(1, '化學', 8, 4, ['單元練習']),
      ...book(2, '生物', 8, 4, ['歷屆試題']),
      finalItem(2, '第1次模考'),
    ];
    const { blocks } = await S.plan(items, { endDate: day(44) });
    same(items, blocks);
  });

  test('範圍極短（7 天塞 90 項）也不能弄丟', async () => {
    const items = book(6, '物理', 18, 4, ['歷屆試題'], { end: day(6) });
    const { blocks } = await S.plan(items, { endDate: day(6) });
    same(items, blocks);
  });

  test('只有一天也不能弄丟', async () => {
    const items = book(1, '化學', 5, 3, ['單元練習'], { start: day(0), end: day(0) });
    const { blocks } = await S.plan(items, { startDate: day(0), endDate: day(0) });
    same(items, blocks);
  });

  test('早點完成（pace=front）也不能弄丟', async () => {
    const items = [...book(1, '化學', 8, 4, ['單元練習']), ...book(2, '生物', 6, 4, ['歷屆試題'])];
    const { blocks } = await S.plan(items, { pace: 'front', endDate: day(44) });
    same(items, blocks);
  });
});

/* ================= 5. 總量正確 ================= */
describe('總量', () => {
  test('每日總量平均（寬裕時最多差 2 項）', async () => {
    const items = [
      ...book(1, '化學', 10, 4, ['單元練習']),
      ...book(2, '生物', 10, 4, ['歷屆試題']),
      ...book(4, '地科', 8, 3, ['歷屆試題']),
    ];
    const { blocks } = await S.plan(items, { endDate: day(59) });
    const p = perDay(blocks);
    assert.ok(Math.max(...p) - Math.min(...p) <= 2,
      `每日量落差過大：${p.join(',')}`);
  });

  test('公式：該科可用天數 −（純題目佔用天數）＝ 節可用天數', async () => {
    const items = book(4, '地科', 12, 3, ['單元練習', '歷屆試題']);
    const { blocks, check } = await S.plan(items, { endDate: day(44) });
    const mine = blocks.filter(b => b.subject_id === 4);
    const pureDays = new Set(mine.filter(b => isPure(b.title)).map(b => b.date));
    const secDays = new Set(mine.filter(b => !isPure(b.title)).map(b => b.date));
    const total = datesOf(blocks).length;
    assert.equal(secDays.size, total - pureDays.size,
      `${total} 天 − 純題目 ${pureDays.size} 天 應該等於節的 ${secDays.size} 天`);
    const s = check.subjects.find(x => x.subject_id === 4);
    assert.equal(s.sec + s.one, mine.length, 'check.subjects 的統計要跟實際 blocks 一致');
  });

  test('同一科的節平均分配（每天差距 ≤1）', async () => {
    const items = book(2, '生物', 10, 4, ['歷屆試題']);
    const { blocks } = await S.plan(items, { endDate: day(44) });
    const secOnly = blocks.filter(b => !isPure(b.title));
    const counts = [...new Set(secOnly.map(b => b.date))].map(d => countOn(secOnly, d, 2));
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `節每日量：${counts.join(',')}`);
  });

  test('沒有空的日子夾在中間（排程期間每天都有東西）', async () => {
    const items = [...book(1, '化學', 10, 4, ['單元練習']), ...book(2, '生物', 10, 4, ['歷屆試題'])];
    const { blocks } = await S.plan(items, { endDate: day(29) });
    const ds = datesOf(blocks);
    const span = (new Date(ds[ds.length - 1]) - new Date(ds[0])) / 864e5 + 1;
    assert.equal(ds.length, span, `${span} 天的期間裡只用了 ${ds.length} 天，中間有空日`);
  });
});

/* ============ 6. 其他已定案的規則（一併鎖住，避免改壞） ============ */
describe('順序', () => {
  test('照課本順序：日期越後、課號越大', async () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      sec(1, `第${String(i + 1).padStart(2, '0')}課`));
    const { blocks } = await S.plan(items, { endDate: day(29) });
    const seq = [...blocks].sort((a, b) => a.date.localeCompare(b.date)).map(b => b.title);
    assert.deepEqual(seq, [...seq].sort(), '課本順序被打亂了');
  });

  test('階段順序：該科的範例全部做完，才開始純題目', async () => {
    const items = book(2, '生物', 8, 3, ['歷屆試題']);
    const { blocks } = await S.plan(items, { endDate: day(44) });
    const lastSec = blocks.filter(b => !isPure(b.title)).reduce((m, b) => b.date > m ? b.date : m, '');
    const firstPure = blocks.filter(b => isPure(b.title)).reduce((m, b) => !m || b.date < m ? b.date : m, '');
    assert.ok(lastSec <= firstPure, `最後的節 ${lastSec} 應不晚於第一份純題目 ${firstPure}`);
  });

  test('多本書時照書本順序排（第一本排完才進第二本）', async () => {
    const items = [
      ...book(6, '物理｜第一本', 6, 3, ['歷屆試題']),
      ...book(6, '物理｜第二本', 6, 3, ['歷屆試題']),
    ];
    const { blocks } = await S.plan(items, { endDate: day(44) });
    const firstBookLast = blocks.filter(b => b.title.includes('第一本') && !isPure(b.title))
      .reduce((m, b) => b.date > m ? b.date : m, '');
    const secondBookFirst = blocks.filter(b => b.title.includes('第二本') && !isPure(b.title))
      .reduce((m, b) => !m || b.date < m ? b.date : m, '');
    assert.ok(firstBookLast <= secondBookFirst,
      `第一本應先排完（${firstBookLast}）再進第二本（${secondBookFirst}）`);
  });
});
