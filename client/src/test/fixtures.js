// 測試用的假資料：形狀比照後端實際回傳的欄位。
// 刻意包含幾種容易出事的資料：讀書計劃任務、已完成、逾期、
// 以及一筆「既有的重複任務」——v1 雖然把 recurring UI 藏起來了，
// 但資料還在，畫面不能因此炸掉。

// 日期一定要跟元件用同一支時間函式算。
// 之前這裡自己寫 `Date.now() + 8h`（台灣時區），但 helpers.today() 用的是
// 本機時間——CI 跑 UTC，於是每天 16:00–24:00 UTC 這段時間兩者差一天，
// 「今天的任務」「今天的行程」全部對不上，測試就會莫名其妙紅。
import { today as appToday, addDays } from '../tt/helpers';

const iso = n => addDays(appToday(), n);
export const TODAY = iso(0);

export const lists = [
  { id: 1, name: '物理', color: '#0086CC', icon: 'atom' },
  { id: 2, name: '地科', color: '#00896C', icon: 'mountain' },
];

export const tasks = [
  // 今天的讀書計劃任務（兩科、兩本書）
  { id: 11, list_id: 1, title: '物理｜新大滿貫｜單元2｜節1｜範例+例題', due_date: TODAY, due_time: null, priority: 0, completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null, order_index: 0, deleted: 0 },
  { id: 12, list_id: 1, title: '物理｜新大滿貫｜單元10｜節1｜範例+例題', due_date: TODAY, due_time: null, priority: 2, completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null, order_index: 1, deleted: 0 },
  { id: 13, list_id: 1, title: '物理｜週攻略｜單元11 量子現象｜歷屆試題', due_date: iso(2), due_time: null, priority: 0, completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null, order_index: 2, deleted: 0 },
  // 已完成的計劃任務（進度條、「已完成的不再重排」都靠它）
  { id: 14, list_id: 2, title: '地科｜新關鍵｜01 大氣｜範例+例題', due_date: iso(-3), due_time: null, priority: 0, completed: 1, tags: ['讀書計劃'], subtasks: [], recurring: null, order_index: 3, deleted: 0 },
  // 逾期未完成
  { id: 15, list_id: 2, title: '地科｜新關鍵｜02 海洋｜範例+例題', due_date: iso(-1), due_time: null, priority: 3, completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null, order_index: 4, deleted: 0 },
  // 一般任務（沒有｜、沒有標籤）
  { id: 16, list_id: null, title: '買參考書', due_date: TODAY, due_time: '18:30', priority: 1, completed: 0, tags: [], subtasks: [], recurring: null, order_index: 5, deleted: 0 },
  // 既有的重複任務：UI 藏起來了，資料還在，不能炸
  { id: 17, list_id: null, title: '每天背單字', due_date: TODAY, due_time: null, priority: 0, completed: 0, tags: [], subtasks: [], recurring: 'daily', miss_policy: 'keep', order_index: 6, deleted: 0 },
  // 自訂 JSON 規則的重複任務（repeatLabel 會 JSON.parse）
  { id: 18, list_id: null, title: '每週複習', due_date: TODAY, due_time: null, priority: 0, completed: 0, tags: [], subtasks: [], recurring: '{"every":2,"unit":"week","days":[1,3]}', miss_policy: 'keep', order_index: 7, deleted: 0 },
  // 垃圾桶裡的
  { id: 19, list_id: null, title: '已刪除的東西', due_date: null, due_time: null, priority: 0, completed: 0, tags: [], subtasks: [], recurring: null, order_index: 8, deleted: 1 },
];

// Phase 2A：正式 Plan（後端 plans 表）。id 12 底下掛了跨科目的任務——
// 用來確認「一個 Plan 可以跨科目」在畫面上真的成立。
export const plans = [
  { id: 12, user_id: 1, name: '第二次段考準備', description: '', goal_id: null, primary_list_id: 1,
    start_date: TODAY, target_date: iso(14), status: 'active', source: 'manual',
    created_at: '', updated_at: '', completed_at: null, archived_at: null,
    task_count: 3, completed_task_count: 0 },
];
// 空白計畫（剛建立、還沒有任何任務）
export const emptyPlan = {
  id: 30, user_id: 1, name: '新的計畫', description: '', goal_id: null, primary_list_id: null,
  start_date: null, target_date: null, status: 'active', source: 'manual',
  created_at: '', updated_at: '', completed_at: null, archived_at: null,
  task_count: 0, completed_task_count: 0,
};
export const archivedPlan = { ...emptyPlan, id: 31, name: '封存過的計畫', status: 'archived', archived_at: TODAY };
export const completedPlan = { ...emptyPlan, id: 32, name: '做完的計畫', status: 'completed', completed_at: TODAY };
// 掛在正式 Plan 底下的任務（帶 plan_id，不該被 legacy 推導撿走）
export const planTasks = [
  { id: 21, list_id: 1, plan_id: 12, title: '物理｜段考範圍｜力學複習', due_date: TODAY, due_time: null, priority: 0, completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null, deadline_date: iso(14), order_index: 20, deleted: 0 },
  { id: 22, list_id: 2, plan_id: 12, title: '地科｜段考範圍｜大氣複習', due_date: iso(1), due_time: null, priority: 0, completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null, deadline_date: iso(14), order_index: 21, deleted: 0 },
  // 在計畫裡但還沒排到日期＝尚未安排（due_date 為 null）
  { id: 23, list_id: 1, plan_id: 12, title: '物理｜段考範圍｜電磁複習', due_date: null, due_time: null, priority: 0, completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null, deadline_date: null, order_index: 22, deleted: 0 },
];

export const events = [
  { id: 1, title: '數學課', date: TODAY, start_time: '08:10', end_time: '09:00', recurring: null, location: '教室' },
  { id: 2, title: '社團', date: TODAY, start_time: '15:30', end_time: '17:00', recurring: 'weekly', location: '' },
];

export const habits = [
  { id: 1, name: '早睡', icon: '⭐', color: '#16a34a', days: [0, 1, 2, 3, 4, 5, 6], checkins: [], miss_policy: 'drop', category: '' },
];

export const pet = { pet: { name: '小福', level: 2, exp: 30, coins: 120, skin: 'default' }, coins: 120 };
export const settings = { sleep_start: '23:30', sleep_end: '07:00', meal_windows: [['12:00', '13:00']], custom_tags: ['複習'] };
export const pomo = [{ id: 1, task_title: '物理', date: TODAY, minutes: 25 }];
// 形狀比照 GET /tstats 實際回傳
export const tstats = {
  total: tasks.length,
  done: tasks.filter(t => t.completed).length,
  completedByDay: { [iso(-3)]: 1 },
  focusByDay: { [TODAY]: 25 },
  focusTotal: 25,
  year: { byMonth: Array(12).fill(0), focusByMonth: Array(12).fill(0), topLists: [] },
};

// 路徑 → 回傳值。沒列到的一律回空陣列，避免任何一支沒 mock 到就整個測試爆掉。
export const responses = {
  '/tasks': tasks,
  '/plans': [],
  '/lists': lists,
  '/filters': [],
  '/habits': habits,
  '/pet': pet,
  '/settings': settings,
  '/events': events,
  '/pomo': pomo,
  '/tstats': tstats,
  '/memos': [],
  '/memo-cats': [],
  '/trash': [],
  '/import/toc': [],
  '/plan-tasks': tasks.filter(t => !t.completed && t.tags.includes('讀書計劃')),
  '/plan-tasks?done=1': tasks.filter(t => t.completed && t.tags.includes('讀書計劃')),
};
