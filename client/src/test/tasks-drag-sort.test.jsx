// 任務清單（375px）：已逾期標示、長按拖曳改日期、依日期／依科目分區切換。
import { act } from 'react';
import { fireEvent, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fx from './fixtures';
import { today, addDays } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

const TD = today();
const D = n => addDays(TD, n);
const base = { priority: 0, completed: 0, deleted: 0, tags: [], subtasks: [], recurring: null, due_time: null };
const mk = (id, title, extra = {}) => ({ ...base, id, title, list_id: 1, order_index: id, due_date: null, ...extra });

const sample = () => [
  mk(1, '一般已過期', { due_date: D(-1) }),
  mk(2, '計畫過去安排', { plan_id: 7, plan_status: 'active', last_scheduled_date: D(-2), list_id: 2 }),
  mk(3, '作業截止已過', { task_kind: 'school_assignment', deadline_date: D(-1) }),
  mk(4, '沒有日期'),
  mk(5, '計畫今天安排', { plan_id: 7, plan_status: 'active', last_scheduled_date: TD }),
  mk(6, '今天要做', { due_date: TD }),
  mk(7, '後天要做', { due_date: D(2), list_id: 2 }),
];

const writes = () => api.mock.calls.filter(([, o]) => o?.method && o.method !== 'GET');
const section = label => screen.getByRole('button', { name: `收合${label}` }).closest('.tgroup');
const row = title => screen.getByText(title).closest('.trow');
const wait = ms => act(() => new Promise(r => setTimeout(r, ms)));

function mount(tasks = sample(), reload = vi.fn().mockResolvedValue(undefined), view = { type: 'tasks' }) {
  const utils = render(<Tasks view={view} tasks={tasks} lists={fx.lists} filters={[]} habits={[]}
    reload={reload} title="任務" />);
  return { ...utils, reload };
}

// 長按 → 拖到 dropDate 分區（'' 為無日期）→ 放開。事件都打在原本那一列，會冒泡到 document。
async function longPressDrag(title, dropDate, { release = true } = {}) {
  const el = row(title);
  fireEvent.touchStart(el, { touches: [{ clientX: 40, clientY: 40 }] });
  await wait(500);
  document.elementFromPoint = () => document.querySelector(`[data-drop-date="${dropDate}"]`);
  fireEvent.touchMove(el, { touches: [{ clientX: 40, clientY: 400 }] });
  if (release) fireEvent.touchEnd(el, { touches: [] });
  return el;
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  api.mockReset();
  api.mockResolvedValue([]);
});
afterEach(() => { cleanup(); delete document.elementFromPoint; });

describe('已逾期標示', () => {
  it('只把早於今天的未完成任務放進「已逾期」並逐列標示；無日期、今天都不誤標', () => {
    mount();
    const overdue = section('已逾期');
    for (const t of ['一般已過期', '計畫過去安排', '作業截止已過']) {
      const r = within(overdue).getByText(t).closest('.trow');
      expect(within(r).getByText('已逾期')).toBeInTheDocument();
    }
    expect(within(row('計畫過去安排')).getByText(/^原定 /)).toBeInTheDocument();
    expect(within(row('作業截止已過')).getByText(/^截止 /)).toBeInTheDocument();
    const nodate = section('無日期');
    expect(within(nodate).getByText('沒有日期')).toBeInTheDocument();
    expect(within(nodate).getByText('計畫今天安排')).toBeInTheDocument();
    expect(within(nodate).queryByText('計畫過去安排')).toBeNull();
    for (const t of ['沒有日期', '計畫今天安排', '今天要做', '後天要做']) expect(within(row(t)).queryByText('已逾期')).toBeNull();
  });

  it('「逾期」篩選包含排程歷史已過的計畫任務，「未排程」不再收它', () => {
    mount();
    expect(screen.getByRole('tab', { name: /^逾期/ })).toHaveTextContent('3');
    expect(screen.getByRole('tab', { name: /^未排程/ })).toHaveTextContent('2');
    fireEvent.click(screen.getByRole('tab', { name: /^未排程/ }));
    expect(screen.queryByText('計畫過去安排')).toBeNull();
    expect(screen.getByText('沒有日期')).toBeInTheDocument();
  });
});

describe('依日期／依科目分區', () => {
  it('切換後依科目分區、逾期仍清楚，偏好重新開啟後保留', () => {
    const { unmount } = mount();
    const seg = screen.getByRole('tablist', { name: '分區方式' });
    expect(within(seg).getByRole('tab', { name: '依日期' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(seg).getByRole('tab', { name: '依科目' }));
    expect(localStorage.getItem('taskSort')).toBe('subjectGroup');
    expect(screen.queryByRole('button', { name: '收合已逾期' })).toBeNull();
    const physics = section('物理');
    expect(within(physics).getByText('一般已過期')).toBeInTheDocument();
    expect(within(row('一般已過期')).getByText('已逾期')).toBeInTheDocument();
    expect(within(section('地科')).getByText('計畫過去安排')).toBeInTheDocument();
    unmount();
    mount();
    expect(screen.getByRole('tab', { name: '依科目' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: '依日期' }));
    expect(localStorage.getItem('taskSort')).toBe('default');
    expect(section('已逾期')).toBeInTheDocument();
  });

  it('排序穩定：API 回應順序不同，分區與列順序相同', () => {
    const order = () => [...document.querySelectorAll('.tgroup')].map(g => [
      g.querySelector('.glabel').textContent, [...g.querySelectorAll('.trow .title')].map(x => x.textContent)]);
    for (const mode of ['default', 'subjectGroup']) {
      localStorage.setItem('taskSort', mode);
      const { unmount } = mount(sample());
      const a = order(); unmount();
      mount(sample().reverse());
      expect(order()).toEqual(a);
      cleanup();
    }
  });
});

describe('375px 長按拖曳改日期', () => {
  it('拖到「今天」立即移動，只送一次 PATCH（只含日期欄位），不建立新任務', async () => {
    let finish;
    api.mockImplementation((path, o = {}) => {
      if (path === '/tasks/4' && o.method === 'PATCH') return new Promise(r => { finish = () => r({}); });
      return Promise.resolve([]);
    });
    const { reload } = mount();
    await longPressDrag('沒有日期', TD);
    // 寫入完成前就已在「今天」分區。
    expect(within(section('今天')).getByText('沒有日期')).toBeInTheDocument();
    expect(writes()).toEqual([['/tasks/4', { method: 'PATCH', body: { due_date: TD, due_time: null } }]]);
    await act(async () => { finish(); });
    await waitFor(() => expect(reload).toHaveBeenCalledWith('tasks'));
    expect(writes()).toHaveLength(1);
    expect(api.mock.calls.some(([path, o]) => path === '/tasks' && o?.method === 'POST')).toBe(false);
    // 拖曳後補的 click 不會打開明細。
    fireEvent.click(row('沒有日期'));
    expect(document.querySelector('.detail')).toBeNull();
  });

  it('拖曳中「明天」「無日期」即使空的也能放；保留原時間', async () => {
    api.mockResolvedValue({});
    mount([mk(9, '有時間的任務', { due_date: TD, due_time: '19:00' })]);
    await longPressDrag('有時間的任務', D(1));
    expect(writes()[0][1].body).toEqual({ due_date: D(1), due_time: '19:00' });
  });

  it('伺服器拒絕時回到原位並提示，不重送', async () => {
    api.mockImplementation((path, o = {}) => {
      if (path === '/tasks/4' && o.method === 'PATCH') return Promise.reject(Object.assign(new Error('日期格式不正確'), { status: 400 }));
      return Promise.resolve([]);
    });
    mount();
    await longPressDrag('沒有日期', TD);
    expect(await screen.findByText('日期格式不正確')).toBeInTheDocument();
    expect(within(section('無日期')).getByText('沒有日期')).toBeInTheDocument();
    expect(within(section('今天')).queryByText('沒有日期')).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('回應遺失：讀回已寫入就視為成功；讀回未寫入就回到原位', async () => {
    for (const committed of [true, false]) {
      api.mockReset();
      api.mockImplementation((path, o = {}) => {
        if (path === '/tasks/4' && o.method === 'PATCH') return Promise.reject(new Error('連線中斷'));
        if (path === '/tasks') return Promise.resolve([{ ...mk(4, '沒有日期'), due_date: committed ? TD : null }]);
        return Promise.resolve([]);
      });
      const { reload } = mount();
      await longPressDrag('沒有日期', TD);
      if (committed) {
        await waitFor(() => expect(reload).toHaveBeenCalledWith('tasks'));
        expect(within(section('今天')).getByText('沒有日期')).toBeInTheDocument();
        expect(screen.queryByText('連線中斷')).toBeNull();
      } else {
        expect(await screen.findByText('連線中斷')).toBeInTheDocument();
        expect(within(section('無日期')).getByText('沒有日期')).toBeInTheDocument();
      }
      expect(writes()).toHaveLength(1);
      cleanup();
    }
  });

  it('結果無法確認：回到原位、鎖住該列，不能再次拖曳重送', async () => {
    api.mockImplementation((path, o = {}) => {
      if (path === '/tasks/4' && o.method === 'PATCH') return Promise.reject(new Error('連線中斷'));
      if (path === '/tasks') return Promise.reject(new Error('讀回失敗'));
      return Promise.resolve([]);
    });
    mount();
    await longPressDrag('沒有日期', TD);
    expect((await screen.findAllByText('無法確認日期是否已更新，請重新載入；確認前請勿再次移動。')).length).toBeGreaterThan(0);
    expect(within(section('無日期')).getByText('沒有日期')).toBeInTheDocument();
    await longPressDrag('沒有日期', D(1));
    expect(screen.queryByText('拖到要移動的日期分區後放開')).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('寫入中舊資料晚到不會把它拉回原位', async () => {
    let finish;
    api.mockImplementation((path, o = {}) => {
      if (path === '/tasks/4' && o.method === 'PATCH') return new Promise(r => { finish = () => r({}); });
      return Promise.resolve([]);
    });
    const reload = vi.fn().mockResolvedValue(undefined);
    const { rerender } = mount(sample(), reload);
    await longPressDrag('沒有日期', TD);
    rerender(<Tasks view={{ type: 'tasks' }} tasks={sample()} lists={fx.lists} filters={[]} habits={[]} reload={reload} title="任務" />);
    expect(within(section('今天')).getByText('沒有日期')).toBeInTheDocument();
    // 拖曳寫入未完成前，同一列不能再拖第二次。
    await longPressDrag('沒有日期', D(1));
    expect(writes()).toHaveLength(1);
    await act(async () => { finish(); });
  });

  it('計畫任務、學校作業、明細開著的任務、依科目分區時都不能拖曳', async () => {
    mount();
    for (const t of ['計畫過去安排', '作業截止已過']) {
      await longPressDrag(t, TD);
      expect(screen.queryByText('拖到要移動的日期分區後放開')).toBeNull();
    }
    fireEvent.click(row('沒有日期'));
    expect(document.querySelector('.detail')).not.toBeNull();
    await longPressDrag('沒有日期', TD);
    expect(writes()).toHaveLength(0);
    cleanup();
    localStorage.setItem('taskSort', 'subjectGroup');
    mount();
    await longPressDrag('沒有日期', TD);
    expect(screen.queryByText('拖到要移動的日期分區後放開')).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('與捲動、左滑、點擊勾選不衝突', async () => {
    mount();
    // 先移動手指（捲動）：不啟動拖曳。
    const r = row('沒有日期');
    fireEvent.touchStart(r, { touches: [{ clientX: 40, clientY: 40 }] });
    fireEvent.touchMove(r, { touches: [{ clientX: 40, clientY: 80 }] });
    await wait(500);
    expect(screen.queryByText('拖到要移動的日期分區後放開')).toBeNull();
    fireEvent.touchEnd(r, { touches: [] });
    // 左滑：出現刪除提示，不啟動拖曳。
    fireEvent.touchStart(r, { touches: [{ clientX: 300, clientY: 40 }] });
    fireEvent.touchMove(r, { touches: [{ clientX: 240, clientY: 41 }] });
    expect(screen.getByText(/再滑一點/)).toBeInTheDocument();
    await wait(500);
    expect(screen.queryByText('拖到要移動的日期分區後放開')).toBeNull();
    fireEvent.touchEnd(r, { touches: [] });
    // 在勾選框上長按不啟動拖曳，點擊勾選照常。
    const box = screen.getByRole('checkbox', { name: '完成「沒有日期」' });
    fireEvent.touchStart(box, { touches: [{ clientX: 10, clientY: 40 }] });
    await wait(500);
    expect(screen.queryByText('拖到要移動的日期分區後放開')).toBeNull();
    fireEvent.touchEnd(box, { touches: [] });
    expect(writes()).toHaveLength(0);
  });

  it('放在「已逾期」、原分區或分區外都不寫入', async () => {
    mount();
    for (const target of ['__none__', '']) {
      const el = row('沒有日期');
      fireEvent.touchStart(el, { touches: [{ clientX: 40, clientY: 40 }] });
      await wait(500);
      expect(screen.getByText('拖到要移動的日期分區後放開')).toBeInTheDocument();
      expect(section('已逾期').hasAttribute('data-drop-date')).toBe(false);
      document.elementFromPoint = () => (target === '__none__' ? section('已逾期') : document.querySelector('[data-drop-date=""]'));
      fireEvent.touchMove(el, { touches: [{ clientX: 40, clientY: 400 }] });
      fireEvent.touchEnd(el, { touches: [] });
    }
    expect(writes()).toHaveLength(0);
  });

  it('Quick Find 篩選中仍可拖曳，搜尋字串保留', async () => {
    api.mockResolvedValue({});
    mount();
    const find = screen.getByLabelText('搜尋目前任務');
    fireEvent.change(find, { target: { value: '沒有' } });
    await longPressDrag('沒有日期', TD);
    expect(writes()).toHaveLength(1);
    expect(find).toHaveValue('沒有');
  });
});
