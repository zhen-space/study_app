// v1 release closeout：實機 audit 抓到的三個問題，各補一支會真的紅的測試。
//
//   1. 讀書頁列出的是「最遠的未來」而不是「該做的」——GET /tasks 由新到舊，
//      直接 slice 就剛好切掉今天與逾期的那幾項。
//   2. 一筆任務都沒有時，中央主要動作是一條死路（標題說「選一個任務」，底下空的）。
//   3. 「照科目分堆」看不出哪一科欠最多——分堆的用途正是這個。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { today, addDays } from '../tt/helpers';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const StudyView = (await import('../tt/StudyView'));
const TasksMod = await import('../tt/Tasks');
const Tasks = TasksMod.default;
const { overdueCount } = TasksMod;

const TD = today();
const setApi = (over = {}) => {
  api.mockImplementation(raw => {
    const path = raw.startsWith('/plans?') ? '/plans' : raw;
    if (path in over) return Promise.resolve(over[path]);
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    if (path.startsWith('/tasks/')) return Promise.resolve({});
    return Promise.resolve([]);
  });
};
let errors;
beforeEach(() => {
  // 排序方式會記在 localStorage：不清掉的話，前一個 case 選的「照科目分堆」
  // 會變成下一個 case 的起始狀態，測試互相污染。
  try { localStorage.clear(); } catch { /* jsdom 以外的環境 */ }
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
  setApi();
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const draw = async ui => { await act(async () => { render(ui); }); };

/* ---------------- 1 + 2：讀書頁 ---------------- */

// 後端就是這個順序（id 由大到小），測試不能自己先排好——
// 先排好的話，元件即使完全不排序也會通過。
const many = [
  { id: 40, title: '下週的內容', due_date: addDays(TD, 6), due_time: '08:00', completed: 0, deleted: 0 },
  { id: 39, title: '後天的內容', due_date: addDays(TD, 2), due_time: '08:00', completed: 0, deleted: 0 },
  { id: 38, title: '明天的內容', due_date: addDays(TD, 1), due_time: '08:00', completed: 0, deleted: 0 },
  { id: 37, title: '今天的內容', due_date: TD, due_time: '09:00', completed: 0, deleted: 0 },
  { id: 36, title: '今天更早的內容', due_date: TD, due_time: '07:00', completed: 0, deleted: 0 },
  { id: 35, title: '欠著沒讀的內容', due_date: addDays(TD, -2), due_time: null, completed: 0, deleted: 0 },
];

describe('讀書頁：列出的是該做的，不是排在最後面的', () => {
  it('pickStudyTasks 逾期在最前，其次照日期時間由近到遠', () => {
    const got = StudyView.pickStudyTasks(many, TD).map(t => t.title);
    expect(got).toEqual([
      '欠著沒讀的內容', '今天更早的內容', '今天的內容',
      '明天的內容', '後天的內容', '下週的內容',
    ]);
  });

  it('超過上限時被切掉的是最遠的，不是最近的', () => {
    const got = StudyView.pickStudyTasks(many, TD, 2).map(t => t.title);
    expect(got).toEqual(['欠著沒讀的內容', '今天更早的內容']);
    expect(got).not.toContain('下週的內容');
  });

  it('已完成與已刪除的不出現', () => {
    const got = StudyView.pickStudyTasks([
      ...many,
      { id: 50, title: '做完了', due_date: TD, completed: 1, deleted: 0 },
      { id: 51, title: '刪掉了', due_date: TD, completed: 0, deleted: 1 },
    ], TD).map(t => t.title);
    expect(got).not.toContain('做完了');
    expect(got).not.toContain('刪掉了');
  });

  it('畫面上第一個「開始」按的就是最該做的那一項', async () => {
    await draw(<StudyView.default tasks={many} />);
    const rows = screen.getAllByText(/內容$/);
    expect(rows[0].textContent).toBe('欠著沒讀的內容');
    // 逾期要看得出來是逾期
    expect(screen.getByText(/^逾期/)).toBeTruthy();
    expect(errors).toEqual([]);
  });

  it('一筆任務都沒有時給得出下一步，不是空白的一張卡', async () => {
    const goPlans = vi.fn();
    await draw(<StudyView.default tasks={[]} goPlans={goPlans} />);
    expect(screen.getByText('還沒有可以讀的任務')).toBeTruthy();
    // 舊版在沒有任務時仍然說「選一個尚未完成的任務」，底下卻什麼都沒有
    expect(screen.queryByText(/選一個尚未完成的任務/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '建立讀書計畫' }));
    expect(goPlans).toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});

/* ---------------- 3：照科目分堆的逾期統計 ---------------- */

describe('任務頁：照科目分堆看得出各科逾期幾項', () => {
  const subjTasks = [
    { id: 60, list_id: 1, title: '物理 逾期一', due_date: addDays(TD, -3), due_time: null, priority: 0, completed: 0, tags: [], subtasks: [], order_index: 0, deleted: 0 },
    { id: 61, list_id: 1, title: '物理 逾期二', due_date: addDays(TD, -1), due_time: null, priority: 0, completed: 0, tags: [], subtasks: [], order_index: 1, deleted: 0 },
    { id: 62, list_id: 1, title: '物理 明天', due_date: addDays(TD, 1), due_time: null, priority: 0, completed: 0, tags: [], subtasks: [], order_index: 2, deleted: 0 },
    { id: 63, list_id: 2, title: '地科 明天', due_date: addDays(TD, 1), due_time: null, priority: 0, completed: 0, tags: [], subtasks: [], order_index: 3, deleted: 0 },
  ];

  it('overdueCount 只算未完成、未刪除、日期已過的', () => {
    expect(overdueCount(subjTasks, TD)).toBe(2);
    expect(overdueCount([
      { due_date: addDays(TD, -1), completed: 1, deleted: 0 },   // 做完了就不算欠
      { due_date: addDays(TD, -1), completed: 0, deleted: 1 },   // 刪掉了也不算
      { due_date: TD, completed: 0, deleted: 0 },                // 今天還沒到期
      { due_date: null, completed: 0, deleted: 0 },              // 沒日期不會逾期
    ], TD)).toBe(0);
  });

  it('每一科的標頭寫出項數，欠的那一科寫出逾期幾項', async () => {
    await draw(
      <Tasks view={{ type: 'tasks' }} tasks={subjTasks} lists={fx.lists}
        filters={[]} habits={[]} reload={() => {}} title="所有任務" />);
    // 切到「照科目分堆」
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'subjectGroup' } });

    const phys = screen.getByText('物理', { selector: '.glabel' }).closest('.glabel');
    expect(within(phys).getByText('3 項')).toBeTruthy();
    expect(within(phys).getByText('逾期 2')).toBeTruthy();

    const earth = screen.getByText('地科', { selector: '.glabel' }).closest('.glabel');
    expect(within(earth).getByText('1 項')).toBeTruthy();
    // 沒有逾期的科目不該掛一個「逾期 0」在那裡
    expect(within(earth).queryByText(/逾期/)).toBeNull();
    expect(errors).toEqual([]);
  });

  // 手機上收起標籤靠的是這個 class；class 名字改掉、CSS 就默默失效，
  // 長標題會再度被擠成六行而沒有任何東西會紅。
  it('任務列的標籤帶著 chip--tag，手機版面才收得起來', async () => {
    await draw(
      <Tasks view={{ type: 'tasks' }} tasks={[{ ...subjTasks[0], tags: ['讀書計劃'] }]}
        lists={fx.lists} filters={[]} habits={[]} reload={() => {}} title="所有任務" />);
    const tag = screen.getByText('#讀書計劃');
    expect(tag.className).toContain('chip--tag');
    expect(errors).toEqual([]);
  });

  it('不是分堆模式時不硬塞這排數字（日期分組已經有自己的意義）', async () => {
    await draw(
      <Tasks view={{ type: 'tasks' }} tasks={subjTasks} lists={fx.lists}
        filters={[]} habits={[]} reload={() => {}} title="所有任務" />);
    const overdue = screen.getByText('已逾期').closest('.glabel');
    expect(within(overdue).queryByText(/^\d+ 項$/)).toBeNull();
    expect(errors).toEqual([]);
  });
});

/* ---------------- 補登 ---------------- */

describe('讀書：補登', () => {
  const some = [
    { id: 70, title: '數學 1-1', due_date: TD, due_time: '09:00', completed: 0, deleted: 0 },
    { id: 71, title: '物理 2-1', due_date: addDays(TD, 1), due_time: null, completed: 0, deleted: 0 },
  ];

  it('正在讀書時補登入口仍然在——補登記的是已經讀完的事', async () => {
    setApi({ '/study-sessions': [{ id: 1, status: 'running', task_id: 70, started_at: new Date().toISOString(), task_title: '數學 1-1' }] });
    await draw(<StudyView.default tasks={some} />);
    expect(await screen.findByText('正在讀書：數學 1-1')).toBeTruthy();
    expect(screen.getByRole('button', { name: /補登/ })).toBeTruthy();
    expect(errors).toEqual([]);
  });

  it('一項任務都沒有時不給補登入口（沒東西可補）', async () => {
    await draw(<StudyView.default tasks={[]} />);
    expect(screen.queryByRole('button', { name: /補登/ })).toBeNull();
  });

  it('送出的是 backfill 端點，帶著日期、開始時間與分鐘數', async () => {
    await draw(<StudyView.default tasks={some} />);
    fireEvent.click(screen.getByRole('button', { name: /補登/ }));
    fireEvent.change(await screen.findByLabelText('讀了幾分鐘'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: addDays(TD, -1) } });
    fireEvent.click(screen.getByRole('button', { name: '補登' }));
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/study-sessions/backfill', expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ task_id: 70, date: addDays(TD, -1), minutes: 45 }),
      }));
    });
    expect(errors).toEqual([]);
  });

  it('日期選不到未來（補的是已經發生的事）', async () => {
    await draw(<StudyView.default tasks={some} />);
    fireEvent.click(screen.getByRole('button', { name: /補登/ }));
    expect((await screen.findByLabelText('日期')).getAttribute('max')).toBe(TD);
  });

  it('後端擋下來時把原因說出來，不是安靜地關掉', async () => {
    api.mockImplementation(path => {
      if (path === '/study-sessions/backfill') return Promise.reject(new Error('不能補登還沒發生的時間'));
      if (path in fx.responses) return Promise.resolve(fx.responses[path]);
      return Promise.resolve([]);
    });
    await draw(<StudyView.default tasks={some} />);
    fireEvent.click(screen.getByRole('button', { name: /補登/ }));
    fireEvent.click(await screen.findByRole('button', { name: '補登' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('不能補登還沒發生的時間');
  });
});

/* ---------------- 為什麼這樣排（AI Insights） ---------------- */

const ExplainSheet = (await import('../tt/ExplainSheet')).default;

describe('為什麼這樣排', () => {
  const facts = { total_blocks: 3, unplaced_count: 0 };
  const base = { active: true, facts, sentences: ['這份安排從 9/1 到 9/3，共 2 天、3 個時段。', '平均每天約 75 分鐘。'] };

  const withExplain = payload => {
    api.mockImplementation(path => {
      if (path === '/schedule/explain') return Promise.resolve(payload);
      if (path in fx.responses) return Promise.resolve(fx.responses[path]);
      return Promise.resolve([]);
    });
  };

  it('沒有 AI 金鑰時仍然看得到確定性的說明，而且講清楚為什麼沒有 AI', async () => {
    withExplain({ ...base, narrative: null, ai: { available: false, reason: 'no_api_key' } });
    await draw(<ExplainSheet onClose={() => {}} />);
    expect(await screen.findByText(/共 2 天、3 個時段/)).toBeTruthy();
    expect(screen.getByText(/AI 補充說明目前沒有開啟/)).toBeTruthy();
    expect(errors).toEqual([]);
  });

  it('有 AI 說明時補在確定性內容後面，不是取代它', async () => {
    withExplain({ ...base, narrative: 'AI 寫的一段話', ai: { available: true, reason: '' } });
    await draw(<ExplainSheet onClose={() => {}} />);
    expect(await screen.findByText('AI 寫的一段話')).toBeTruthy();
    expect(screen.getByText(/共 2 天、3 個時段/)).toBeTruthy();   // 確定性的仍在
  });

  it('AI 出錯時只是少一段話，確定性說明照樣顯示，並給重試', async () => {
    withExplain({ ...base, narrative: null, ai: { available: false, reason: 'error' } });
    await draw(<ExplainSheet onClose={() => {}} />);
    expect(await screen.findByText(/共 2 天、3 個時段/)).toBeTruthy();
    expect(screen.getByText(/AI 這次沒有回應/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '再試一次' })).toBeTruthy();
  });

  it('整支端點失敗時說得出來，並給重試——不是一片空白', async () => {
    api.mockImplementation(path => {
      if (path === '/schedule/explain') return Promise.reject(new Error('伺服器沒有回應'));
      if (path in fx.responses) return Promise.resolve(fx.responses[path]);
      return Promise.resolve([]);
    });
    await draw(<ExplainSheet onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('伺服器沒有回應');
    expect(screen.getByRole('button', { name: '重試' })).toBeTruthy();
  });

  it('明講這裡不會改動安排（AI 不是排程真相）', async () => {
    withExplain({ ...base, narrative: null, ai: { available: false, reason: 'no_api_key' } });
    await draw(<ExplainSheet onClose={() => {}} />);
    expect(await screen.findByText(/不會改動你的安排/)).toBeTruthy();
  });
});
