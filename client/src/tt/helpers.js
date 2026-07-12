export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
export const PRI = { 0: ['無', ''], 1: ['低', 'p1'], 2: ['中', 'p2'], 3: ['高', 'p3'] };

export function matchView(t, view, ctx) {
  const td = today();
  if (view.type === 'trash') return !!t.deleted;
  if (t.deleted) return false;                     // 垃圾桶以外的視圖都不顯示已刪除
  switch (view.type) {
    case 'search': {
      const q = (view.q || '').trim();
      if (!q) return false;
      return !t.completed && ((t.title || '').includes(q) || (t.notes || '').includes(q) || t.tags.some(x => x.includes(q)));
    }
    case 'inbox': return !t.list_id && !t.completed;
    case 'today': return t.due_date === td && !t.completed;
    case 'week': return t.due_date && t.due_date >= td && t.due_date <= addDays(td, 6) && !t.completed;
    case 'all': return !t.completed;
    case 'completed': return !!t.completed;
    case 'list': return t.list_id === view.id && !t.completed;
    case 'tag': return t.tags.includes(view.tag) && !t.completed;
    case 'filter': {
      const r = ctx.filters.find(f => f.id === view.id)?.rule || {};
      if (t.completed) return false;
      if (r.list_id && t.list_id !== r.list_id) return false;
      if (r.priority != null && t.priority !== r.priority) return false;
      if (r.tag && !t.tags.includes(r.tag)) return false;
      if (r.due === 'today' && t.due_date !== td) return false;
      if (r.due === 'week' && !(t.due_date && t.due_date >= td && t.due_date <= addDays(td, 6))) return false;
      if (r.due === 'overdue' && !(t.due_date && t.due_date < td)) return false;
      return true;
    }
    default: return false;
  }
}

export function groupTasks(tasks, viewType) {
  const td = today();
  if (viewType === 'completed') return [['已完成', tasks]];
  if (viewType === 'trash') return [['垃圾桶', tasks]];
  if (viewType === 'search') return [['搜尋結果', tasks]];
  const overdue = tasks.filter(t => t.due_date && t.due_date < td);
  const todays = tasks.filter(t => t.due_date === td);
  const later = tasks.filter(t => t.due_date && t.due_date > td);
  const nodate = tasks.filter(t => !t.due_date);
  return [
    ['已逾期', overdue], ['今天', todays], ['之後', later], ['無日期', nodate],
  ].filter(([, l]) => l.length);
}
