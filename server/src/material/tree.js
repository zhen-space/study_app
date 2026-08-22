// Material domain 的純規則。這個檔案不查 DB。
//
// 這裡是「教材長什麼樣子、完成度怎麼算、選取狀態怎麼呈現」的唯一答案。
// service 與 route 都只呼叫這裡，不各自再寫一份聚合邏輯——兩邊各寫一份，
// 遲早會分岔成「清單顯示 80%、詳細頁顯示 75%」。

export const NODE_KINDS = ['chapter', 'section', 'topic'];

// 允許的父子關係。書底下只能是章；Section / Topic 是同層，兩者都直接掛在章底下。
// Section / Topic 底下不再有 material node 子層；它們只承載 ContentItem。
const ALLOWED_PARENT = {
  chapter: [null],
  section: ['chapter'],
  topic: ['chapter'],
};

// 「範例」與「例題」是課本上兩種不同的東西：範例是講解過的示範，
// 例題是要自己動手做的題目。學生會想「這章只讀課本內容」或「只做例題」，
// 所以它們必須是各自獨立的 ContentItem，不能合成一種。
export const ITEM_KINDS = ['reading', 'example', 'example_problem', 'unit_exercise', 'past_exam'];

// 範例／例題掛在節或主題底下；單元練習／歷屆試題直接屬於章。
//
// 這條規則存在的唯一理由，是不要為了「讓題目有個 parent」而生出假的節。
// 假節會污染每一個 derived 數字：章的完成率、tri-state、教材樹的層數，
// 全部都會多算一層根本不存在的東西。
const ALLOWED_ITEM_PARENT = {
  reading: ['chapter', 'section', 'topic'],
  example: ['section', 'topic'],
  example_problem: ['section', 'topic'],
  unit_exercise: ['chapter'],
  past_exam: ['chapter'],
};

// 學生看到的字。這是唯一一份對照表，前後端都以它為準。
export const ITEM_KIND_LABEL = {
  reading: '課本內容',
  example: '範例',
  example_problem: '例題',
  unit_exercise: '單元練習',
  past_exam: '歷屆試題',
};

// 只能掛在 Section / Topic 底下的類型（章底下不會有）
const SECTION_LEVEL_KINDS = ['example', 'example_problem'];

// 回傳錯誤訊息字串；合法回 null。
export function nodePlacementProblem(kind, parentKind) {
  if (!NODE_KINDS.includes(kind)) return '教材層級不正確';
  const allowed = ALLOWED_PARENT[kind];
  if (!allowed.includes(parentKind ?? null)) {
    if (kind === 'chapter') return '「章」只能直接放在書底下';
    if (kind === 'section') return '「節」只能放在章底下';
    return '「主題」只能放在章底下';
  }
  return null;
}

export function itemPlacementProblem(kind, parentKind) {
  if (!ITEM_KINDS.includes(kind)) return '教材項目類型不正確';
  if (parentKind == null) return '教材項目必須掛在章、節或主題底下';
  if (!ALLOWED_ITEM_PARENT[kind].includes(parentKind)) {
    if (SECTION_LEVEL_KINDS.includes(kind)) return `${ITEM_KIND_LABEL[kind]}只能放在節或主題底下`;
    return `${ITEM_KIND_LABEL[kind]}直接屬於章，不要為它建立節`;
  }
  return null;
}

// 把扁平的 node / item 列組成樹，並在每一層算出 derived 數字。
//
// 完成度**只**從 ContentItem 來（契約 1）。節點自己沒有完成欄位，
// 這裡也刻意不提供任何寫回節點的路徑。
//
// selection 的 tri-state（契約 6）：
//   'all'  → 底下每一個「尚未完成」的項目都被選取
//   'none' → 一個都沒選
//   'some' → 部分選取
// 已完成的項目不參與 selection 計算：completed 不是用普通 checkbox 表達的狀態，
// 把它算進去會讓整章永遠停在 'some'。
export function buildTree(nodes, items, { completed = new Set(), selected = new Set() } = {}) {
  const byParent = new Map();
  for (const n of nodes) {
    const key = n.parent_id == null ? 'root' : String(n.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  const itemsByNode = new Map();
  for (const it of items) {
    const key = String(it.node_id);
    if (!itemsByNode.has(key)) itemsByNode.set(key, []);
    itemsByNode.get(key).push(it);
  }
  const order = (a, b) => (a.order_index - b.order_index) || (a.id - b.id);

  const walk = node => {
    const children = (byParent.get(String(node.id)) || []).sort(order).map(walk);
    const own = (itemsByNode.get(String(node.id)) || []).sort(order).map(it => ({
      id: it.id,
      node_id: it.node_id,
      kind: it.kind,
      title: it.title,
      estimated_minutes: it.estimated_minutes ?? null,
      order_index: it.order_index,
      completed: completed.has(it.id),
      selected: selected.has(it.id),
    }));
    const all = [...own, ...children.flatMap(c => c.__all)];
    const done = all.filter(x => x.completed);
    const open = all.filter(x => !x.completed);
    const chosen = open.filter(x => x.selected);
    return {
      id: node.id,
      book_id: node.book_id,
      parent_id: node.parent_id ?? null,
      kind: node.kind,
      title: node.title,
      order_index: node.order_index,
      children,
      content_items: own,
      progress: {
        total_items: all.length,
        completed_items: done.length,
        percent: all.length ? Math.round(done.length / all.length * 100) : 0,
      },
      // 全部都完成時 selection 沒有意義，回 'none' 而不是 'all'——
      // 'all' 會讓 UI 畫出一個「已全選」的勾，但其實沒有東西可以排。
      selection: !open.length ? 'none'
        : chosen.length === open.length ? 'all'
          : chosen.length ? 'some' : 'none',
      __all: all,
    };
  };

  const roots = (byParent.get('root') || []).sort(order).map(walk);
  const strip = n => { const { __all, ...rest } = n; return { ...rest, children: n.children.map(strip) }; };
  const flat = roots.flatMap(r => r.__all);
  const doneAll = flat.filter(x => x.completed);
  const openAll = flat.filter(x => !x.completed);
  const chosenAll = openAll.filter(x => x.selected);
  return {
    nodes: roots.map(strip),
    progress: {
      total_items: flat.length,
      completed_items: doneAll.length,
      percent: flat.length ? Math.round(doneAll.length / flat.length * 100) : 0,
    },
    selection: !openAll.length ? 'none'
      : chosenAll.length === openAll.length ? 'all'
        : chosenAll.length ? 'some' : 'none',
  };
}

// 一個 node 底下（含子孫）的所有 ContentItem id。tri-state 批次選取用：
// 使用者點的是節點，實際寫入的永遠是底下的 ContentItem（契約 6）。
export function descendantItemIds(nodeId, nodes, items) {
  const childrenOf = new Map();
  for (const n of nodes) {
    const key = n.parent_id == null ? 'root' : String(n.parent_id);
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(n);
  }
  const ids = new Set();
  const walk = id => {
    ids.add(Number(id));
    for (const c of childrenOf.get(String(id)) || []) walk(c.id);
  };
  walk(nodeId);
  return items.filter(it => ids.has(Number(it.node_id))).map(it => it.id);
}
