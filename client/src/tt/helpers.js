// 一律用「本地時區」的日期字串——toISOString 是 UTC，台灣(+8)凌晨會差一天、整週偏移
export const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => localISO(new Date());
export const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return localISO(d); };
export const PRI = { 0: ['無', ''], 1: ['低', 'p1'], 2: ['中', 'p2'], 3: ['高', 'p3'] };

// 任務是否應該出現在「執行面」上。
//
// plan_id 為 NULL 的一般待辦沒有計畫，永遠算。掛在計畫底下的任務，只有在計畫仍
// 進行中（draft／active）時才算——ended／paused／completed／archived／deleted 計畫
// 的任務仍存在、仍屬於原計畫（Plan Detail 看得到），但要退出 Today／未來 7 天／
// 願望清單／一般進行中任務／Study 開始候選／Calendar 待辦等所有執行面。
//
// 這是「這個任務現在還要不要做」的單一判準，故意獨立成一個函式，讓每一個投影面
// 都走同一條規則，不會有人漏掉一處。
export const onActivePlan = t => t.plan_id == null || t.plan_status === 'draft' || t.plan_status === 'active';

export function matchView(t, view, ctx) {
  const td = today();
  if (view.type === 'trash') return !!t.deleted;
  if (t.deleted) return false;                     // 垃圾桶以外的視圖都不顯示已刪除
  // 已結束／暫停等非進行中計畫的任務退出所有執行視圖（completed 是歷史，不在此列）
  if (view.type !== 'completed' && !onActivePlan(t)) return false;
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
    case 'tasks': return !t.completed;      // 主導航「任務」＝所有未完成
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

const WDH = '日一二三四五六';
export function groupTasks(tasks, viewType) {
  const td = today();
  if (viewType === 'completed') return [['已完成', tasks]];
  if (viewType === 'trash') return [['垃圾桶', tasks]];
  if (viewType === 'search') return [['搜尋結果', tasks]];
  const overdue = tasks.filter(t => t.due_date && t.due_date < td);
  const todays = tasks.filter(t => t.due_date === td);
  const later = tasks.filter(t => t.due_date && t.due_date > td);
  const nodate = tasks.filter(t => !t.due_date);
  // 之後：一天一組，寫出日期
  const byDate = {};
  later.forEach(t => { (byDate[t.due_date] = byDate[t.due_date] || []).push(t); });
  const laterGroups = Object.keys(byDate).sort().map(d =>
    [`${+d.slice(5, 7)}/${+d.slice(8)}（週${WDH[new Date(d + 'T00:00:00').getDay()]}）`, byDate[d]]);
  return [
    ['已逾期', overdue], ['今天', todays], ...laterGroups, ['無日期', nodate],
  ].filter(([, l]) => l.length);
}
// 預設排序：依時間；同一天依課序（order_index，再依建立先後）
export function defaultSort(a, b) {
  return (a.due_date || '9999').localeCompare(b.due_date || '9999')
    || (a.due_time || '99').localeCompare(b.due_time || '99')
    || (a.order_index - b.order_index)
    || (a.id - b.id);
}
