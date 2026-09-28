// 目錄自然排序：中英數序數解析、自然比較、可靠性 fail-closed。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chineseToInt, extractOrdinal, naturalCompare, ordinalsReliable, canOrderReliably }
  from '../src/material/natural-order.js';

describe('chineseToInt', () => {
  test('NO1 個位／十位／阿拉伯', () => {
    assert.equal(chineseToInt('一'), 1);
    assert.equal(chineseToInt('九'), 9);
    assert.equal(chineseToInt('十'), 10);
    assert.equal(chineseToInt('十一'), 11);
    assert.equal(chineseToInt('二十'), 20);
    assert.equal(chineseToInt('二十一'), 21);
    assert.equal(chineseToInt('10'), 10);
    assert.equal(chineseToInt('亂'), null);
  });
});

describe('extractOrdinal', () => {
  test('NO2 第N課／章／單元N／ChN／阿拉伯／中文開頭', () => {
    assert.equal(extractOrdinal('第一課 力學'), 1);
    assert.equal(extractOrdinal('第二課'), 2);
    assert.equal(extractOrdinal('第十課'), 10);
    assert.equal(extractOrdinal('第一章'), 1);
    assert.equal(extractOrdinal('單元一'), 1);
    assert.equal(extractOrdinal('單元二'), 2);
    assert.equal(extractOrdinal('Ch1'), 1);
    assert.equal(extractOrdinal('Ch10 Kinematics'), 10);
    assert.equal(extractOrdinal('Chapter 3'), 3);
    assert.equal(extractOrdinal('1 力學'), 1);
    assert.equal(extractOrdinal('10、電磁'), 10);
    assert.equal(extractOrdinal('一、緒論'), 1);
    assert.equal(extractOrdinal('總複習'), null);
  });
});

describe('naturalCompare / reliability', () => {
  test('NO3 自然排序不會 1、10、2', () => {
    const arr = ['第10課', '第2課', '第1課'];
    assert.deepEqual([...arr].sort(naturalCompare), ['第1課', '第2課', '第10課']);
  });
  test('NO4 全部可解析且不重複 → reliable', () => {
    assert.equal(ordinalsReliable(['第一課', '第二課', '第十課']), true);
  });
  test('NO5 有抽不出序數 → 不可靠（fail-closed）', () => {
    assert.equal(ordinalsReliable(['第一課', '總複習']), false);
    assert.equal(canOrderReliably(['第一課', '第二課'], ['總複習']), false);
  });
  test('NO6 序數重複 → 不可靠', () => {
    assert.equal(ordinalsReliable(['第一課', '第一課']), false);
    assert.equal(canOrderReliably(['第一課', '第二課'], ['第二課補充']), false); // 新項序數 2 與既有 2 撞
  });
  test('NO7 新章節序數與既有不撞、皆可解析 → 可靠', () => {
    assert.equal(canOrderReliably(['第一課', '第二課'], ['第三課']), true);
  });
});
