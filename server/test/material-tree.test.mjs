// Material domain 的純規則：樹形限制、derived 完成度、tri-state 選取。
// 這一支不開伺服器也不碰 DB——規則錯了要在這裡就爆，不是等到 API 測試。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree, descendantItemIds, nodePlacementProblem, itemPlacementProblem,
} from '../src/material/tree.js';

const node = (id, kind, parent_id, order_index = 0) =>
  ({ id, book_id: 1, parent_id, kind, title: `n${id}`, order_index });
const item = (id, node_id, kind = 'reading', order_index = 0) =>
  ({ id, book_id: 1, node_id, kind, title: `i${id}`, estimated_minutes: null, order_index });

describe('樹形限制（契約 7）', () => {
  test('章只能在書底下，節只能在章底下，主題只能在節底下', () => {
    assert.equal(nodePlacementProblem('chapter', null), null);
    assert.equal(nodePlacementProblem('section', 'chapter'), null);
    assert.equal(nodePlacementProblem('topic', 'section'), null);
    assert.match(nodePlacementProblem('chapter', 'chapter'), /只能直接放在書底下/);
    assert.match(nodePlacementProblem('section', null), /只能放在章底下/);
    assert.match(nodePlacementProblem('topic', 'chapter'), /只能放在節底下/);
    assert.match(nodePlacementProblem('unit', null), /層級不正確/);
  });

  test('範例／例題掛在節或主題底下', () => {
    assert.equal(itemPlacementProblem('example', 'section'), null);
    assert.equal(itemPlacementProblem('example', 'topic'), null);
    assert.match(itemPlacementProblem('example', 'chapter'), /只能放在節或主題底下/);
  });

  test('單元練習／歷屆試題直接屬於章，不得為它建假的節', () => {
    assert.equal(itemPlacementProblem('unit_exercise', 'chapter'), null);
    assert.equal(itemPlacementProblem('past_exam', 'chapter'), null);
    assert.match(itemPlacementProblem('unit_exercise', 'section'), /直接屬於章，不要為它建立節/);
    assert.match(itemPlacementProblem('past_exam', 'topic'), /直接屬於章，不要為它建立節/);
  });

  test('教材項目一定要有掛的節點', () => {
    assert.match(itemPlacementProblem('reading', null), /必須掛在章、節或主題底下/);
  });
});

describe('derived 完成度（契約 1）', () => {
  // 章1 ├ 節1 ├ 主題1（item 1）
  //     │     └ item 2
  //     └ item 3（單元練習，直接掛章）
  const nodes = [node(1, 'chapter', null), node(2, 'section', 1), node(3, 'topic', 2)];
  const items = [item(10, 3), item(11, 2), item(12, 1, 'unit_exercise')];

  test('節點完成度由子孫 ContentItem 現算，節點自身沒有完成欄位', () => {
    const t = buildTree(nodes, items, { completed: new Set([10]) });
    const ch = t.nodes[0];
    assert.equal(ch.progress.total_items, 3);
    assert.equal(ch.progress.completed_items, 1);
    assert.equal(ch.progress.percent, 33);
    assert.equal('completed' in ch, false, '節點不得帶有自己的 completed 欄位');
    const sec = ch.children[0];
    assert.equal(sec.progress.total_items, 2);
    assert.equal(sec.progress.completed_items, 1);
    const topic = sec.children[0];
    assert.equal(topic.progress.percent, 100);
  });

  test('直接掛在章底下的項目也計入該章進度', () => {
    const t = buildTree(nodes, items, { completed: new Set([12]) });
    assert.equal(t.nodes[0].progress.completed_items, 1);
    assert.equal(t.nodes[0].children[0].progress.completed_items, 0);
  });

  test('整本書的進度是所有 ContentItem 的聚合', () => {
    const t = buildTree(nodes, items, { completed: new Set([10, 11, 12]) });
    assert.deepEqual(t.progress, { total_items: 3, completed_items: 3, percent: 100 });
  });

  test('沒有任何項目時不會除以零', () => {
    const t = buildTree([node(1, 'chapter', null)], []);
    assert.deepEqual(t.progress, { total_items: 0, completed_items: 0, percent: 0 });
    assert.equal(t.nodes[0].progress.percent, 0);
  });
});

describe('tri-state 選取（契約 6）', () => {
  const nodes = [node(1, 'chapter', null), node(2, 'section', 1)];
  const items = [item(10, 2), item(11, 2), item(12, 1, 'past_exam')];

  test('全部未完成項目都選 → all', () => {
    const t = buildTree(nodes, items, { selected: new Set([10, 11, 12]) });
    assert.equal(t.nodes[0].selection, 'all');
  });

  test('部分選 → some', () => {
    const t = buildTree(nodes, items, { selected: new Set([10]) });
    assert.equal(t.nodes[0].selection, 'some');
    assert.equal(t.nodes[0].children[0].selection, 'some');
  });

  test('都沒選 → none', () => {
    assert.equal(buildTree(nodes, items).nodes[0].selection, 'none');
  });

  test('已完成的項目不參與 selection：其餘全選仍算 all', () => {
    // 12 已完成且沒被選；若把已完成算進分母，這裡會錯誤地變成 some
    const t = buildTree(nodes, items, { completed: new Set([12]), selected: new Set([10, 11]) });
    assert.equal(t.nodes[0].selection, 'all');
  });

  test('整章都完成時 selection 是 none，不是 all', () => {
    const t = buildTree(nodes, items, { completed: new Set([10, 11, 12]) });
    assert.equal(t.nodes[0].selection, 'none');
    assert.equal(t.nodes[0].progress.percent, 100);
  });

  test('殘留的「已完成卻仍被選取」不得算進 selection', () => {
    // 可達狀態：先在這個 Plan 選了某項目，之後在別處（或 Material 層）完成它。
    // selection 列還在，但它已經不是待排程工作，不能讓整章看起來像全選。
    const t = buildTree(nodes, items, { completed: new Set([10]), selected: new Set([10]) });
    assert.equal(t.nodes[0].children[0].selection, 'none');
    assert.equal(t.nodes[0].selection, 'none');
  });

  test('已完成且被選取，其餘部分選取 → 仍以未完成項目判定', () => {
    const t = buildTree(nodes, items, { completed: new Set([10]), selected: new Set([10, 11]) });
    assert.equal(t.nodes[0].children[0].selection, 'all', '節底下唯一未完成的 11 被選了');
    assert.equal(t.nodes[0].selection, 'some', '章底下的 12 還沒選');
  });

  test('completed 與 selected 是兩組獨立欄位（契約 9）', () => {
    const t = buildTree(nodes, items, { completed: new Set([10]), selected: new Set([11]) });
    const its = t.nodes[0].children[0].content_items;
    assert.deepEqual(its.map(i => [i.id, i.completed, i.selected]), [[10, true, false], [11, false, true]]);
  });
});

describe('descendantItemIds（節點批次選取的作用範圍）', () => {
  const nodes = [node(1, 'chapter', null), node(2, 'section', 1), node(3, 'topic', 2), node(4, 'section', 1)];
  const items = [item(10, 3), item(11, 2), item(12, 1), item(13, 4)];

  test('涵蓋整棵子樹', () => {
    assert.deepEqual(descendantItemIds(1, nodes, items).sort((a, b) => a - b), [10, 11, 12, 13]);
  });
  test('只取指定子樹，不會外溢到兄弟節點', () => {
    assert.deepEqual(descendantItemIds(2, nodes, items).sort((a, b) => a - b), [10, 11]);
    assert.deepEqual(descendantItemIds(4, nodes, items), [13]);
  });
});

describe('排序穩定', () => {
  test('order_index 相同時以 id 決定，輸入順序不影響輸出', () => {
    const nodes = [node(2, 'chapter', null, 0), node(1, 'chapter', null, 0)];
    const t = buildTree(nodes, []);
    assert.deepEqual(t.nodes.map(n => n.id), [1, 2]);
  });
});
