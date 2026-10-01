// Canonical draft 的葉節點一定要有一筆可學習內容：章沒有子節時，章本身就是
// reading；節／主題沒有更細內容時，該節／主題本身就是 reading。
// 有 children 的章只是容器，不可因為有標題就多算一筆。
const leafItems = (items, title, isLeaf) => {
  const list = Array.isArray(items) ? items : [];
  if (list.length || !isLeaf || !String(title || '').trim()) return list;
  return [{ kind: 'reading', title: String(title).trim() }];
};

export function canonicalizeLeafContent(input) {
  if (!input) return input;
  return {
    ...input,
    chapters: (input.chapters || []).map(chapter => {
      const children = (chapter.children || []).map(child => ({
        ...child,
        content_items: leafItems(child.content_items, child.title, true),
      }));
      return {
        ...chapter,
        children,
        content_items: leafItems(chapter.content_items, chapter.title, children.length === 0),
      };
    }),
  };
}

export function materialContentCount(input) {
  const draft = canonicalizeLeafContent(input);
  return (draft?.chapters || []).reduce((total, chapter) => total
    + chapter.content_items.length
    + chapter.children.reduce((sum, child) => sum + child.content_items.length, 0), 0);
}
