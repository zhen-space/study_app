// 已結束計畫的資訊架構：任務退出所有執行面，但 Plan Detail 仍看得到、且唯讀。
//
// 這一組守的是 production smoke review 找到的洞：計畫「結束」後，它底下的未完成
// 任務仍然帶著 plan_id 與 due_date，若投影面不看 plan_status，就會繼續出現在
// Today／未來 7 天／願望清單／一般進行中任務／Study 候選／Calendar 上。
import { describe, it, expect } from 'vitest';
import { matchView, onActivePlan, today, addDays } from '../tt/helpers';
import { pickStudyTasks } from '../tt/StudyView';
import { dueNotifications } from '../tt/notify';

// 同一個計畫底下、狀態不同的兩個任務：一個在進行中計畫，一個在已結束計畫。
//
// td 必須是「測試執行當天」，不能寫死：matchView 的 'today' 視圖比對的是它內部
// 現算的 today()，而不是這裡傳進去的參數。寫死某一天的話，只有那一天測試會過，
// 隔天 default-branch CI 就會失敗。改用既有的 today() 讓 fixture 相對於執行日產生。
const td = today();
const active = { id: 1, plan_id: 5, plan_status: 'active', title: '力學', due_date: td, completed: 0, deleted: 0, list_id: 1, tags: [], subtasks: [] };
const ended = { id: 2, plan_id: 9, plan_status: 'ended', title: '電磁', due_date: td, completed: 0, deleted: 0, list_id: 1, tags: [], subtasks: [] };
const loose = { id: 3, plan_id: null, plan_status: null, title: '買參考書', due_date: td, completed: 0, deleted: 0, list_id: null, tags: [], subtasks: [] };
const paused = { id: 4, plan_id: 7, plan_status: 'paused', title: '暫停中的任務', due_date: td, completed: 0, deleted: 0, list_id: 1, tags: [], subtasks: [] };

describe('onActivePlan 判準', () => {
  it('進行中計畫與一般待辦算，結束／暫停等不算', () => {
    expect(onActivePlan(active)).toBe(true);
    expect(onActivePlan(loose)).toBe(true);
    expect(onActivePlan({ ...active, plan_status: 'draft' })).toBe(true);
    expect(onActivePlan(ended)).toBe(false);
    expect(onActivePlan(paused)).toBe(false);
    expect(onActivePlan({ ...active, plan_status: 'completed' })).toBe(false);
    expect(onActivePlan({ ...active, plan_status: 'archived' })).toBe(false);
    expect(onActivePlan({ ...active, plan_status: 'deleted' })).toBe(false);
  });
});

describe('matchView：已結束任務退出每一個執行視圖', () => {
  const all = [active, ended, loose, paused];
  for (const type of ['today', 'week', 'all', 'tasks', 'inbox', 'list', 'search']) {
    it(`${type} 視圖不含已結束／暫停計畫的任務`, () => {
      const view = type === 'list' ? { type, id: 1 }
        : type === 'search' ? { type, q: '' } : { type };
      const shown = all.filter(t => matchView(t, view, { filters: [] }));
      expect(shown.some(t => t.id === ended.id), `${type} 不該含已結束任務`).toBe(false);
      expect(shown.some(t => t.id === paused.id), `${type} 不該含暫停任務`).toBe(false);
    });
  }

  it('today / all 仍含進行中計畫與一般待辦', () => {
    const shownToday = [active, ended, loose].filter(t => matchView(t, { type: 'today' }, { filters: [] }));
    expect(shownToday.map(t => t.id).sort()).toEqual([1, 3]);
    const shownAll = [active, ended, loose].filter(t => matchView(t, { type: 'all' }, { filters: [] }));
    expect(shownAll.map(t => t.id).sort()).toEqual([1, 3]);
  });

  it('completed 是歷史視圖，不套用執行面過濾', () => {
    const doneEnded = { ...ended, completed: 1 };
    expect(matchView(doneEnded, { type: 'completed' }, { filters: [] })).toBe(true);
  });

  it('垃圾桶只看 deleted，與計畫狀態無關', () => {
    const trashed = { ...ended, deleted: 1 };
    expect(matchView(trashed, { type: 'trash' }, { filters: [] })).toBe(true);
  });
});

describe('Study 開始候選', () => {
  it('不含已結束／暫停計畫的任務', () => {
    const picked = pickStudyTasks([active, ended, loose, paused], td, Infinity);
    expect(picked.map(t => t.id).sort()).toEqual([1, 3]);
  });
});

describe('提醒', () => {
  it('已結束計畫的任務不再提醒（到期與逾期都不算）', () => {
    // 逾期＝執行日的兩天前，同樣不寫死日期
    const overdueEnded = { ...ended, due_date: addDays(td, -2) };
    const overdueActive = { ...active, due_date: addDays(td, -2) };
    const out = dueNotifications({
      tasks: [overdueEnded, overdueActive], today: td, now: new Date(`${td}T09:00:00`),
    });
    const overdue = out.find(n => n.kind === 'overdue');
    // 只有進行中那一筆逾期會被算進提醒數字
    expect(overdue?.body).toMatch(/1 項/);
  });
});
