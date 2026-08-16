import { useMemo } from 'react';
import { today } from './helpers';

// 計畫（Plan）目前是從既有 tasks 推導出來的，後端沒有獨立的 Plan 資料表。
// 讀書計劃＝排程精靈產生的一批任務：tags 含「讀書計劃」或標題含全形「｜」，
// list_id 就是科目。Phase 1 不重做資料模型，也沒有新增任何 API。

export const isPlanTask = t =>
  !t.deleted && ((Array.isArray(t.tags) && t.tags.includes('讀書計劃')) || (t.title || '').includes('｜'));

// 標題形如「物理｜新大滿貫｜單元3｜節2｜範例+例題」→ 書名取第 2 段
export const bookOf = title => {
  const seg = String(title || '').split('｜');
  return seg.length >= 2 ? seg[1].trim() : '其他';
};
// 顯示用：把「科目｜書名｜」前綴拿掉，列表裡不用一直重複
export const shortTitle = title => {
  const seg = String(title || '').split('｜');
  return seg.length > 2 ? seg.slice(2).join('｜') : title;
};
export const md = d => (d ? `${+d.slice(5, 7)}/${+d.slice(8)}` : '');
export const byLesson = new Intl.Collator('zh-Hant', { numeric: true }).compare;

// 一個科目 = 一個計畫（Phase 1 的暫定粒度）
export function usePlans(tasks, lists) {
  return useMemo(() => {
    const plan = new Map();
    for (const t of tasks.filter(isPlanTask)) {
      const k = String(t.list_id ?? '');
      if (!plan.has(k)) plan.set(k, []);
      plan.get(k).push(t);
    }
    const ord = {};
    lists.forEach((l, i) => { ord[String(l.id)] = i; });
    return [...plan.entries()]
      .sort((a, b) => (ord[a[0]] ?? 99) - (ord[b[0]] ?? 99))
      .map(([k, items]) => {
        const list = lists.find(x => String(x.id) === k);
        const done = items.filter(t => t.completed).length;
        const dates = items.map(t => t.due_date).filter(Boolean).sort();
        return {
          key: k,
          listId: list?.id ?? null,
          name: list?.name || '未分科目',
          color: list?.color || 'var(--muted)',
          icon: list?.icon || 'book',
          items, done, total: items.length,
          overdue: items.filter(t => !t.completed && t.due_date && t.due_date < today()).length,
          start: dates[0] || '', end: dates[dates.length - 1] || '',
          books: [...new Set(items.map(t => bookOf(t.title)))],
        };
      });
  }, [tasks, lists]);
}
