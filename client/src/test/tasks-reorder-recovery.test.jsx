import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

const mk = (id, over = {}) => ({
  id, title: `任務 ${id}`, completed: false, deleted: false, plan_id: null,
  task_kind: 'task', due_date: null, due_time: null, list_id: null,
  priority: 0, tags: [], subtasks: [], notes: '', order_index: id, ...over,
});
const tasks = () => [mk(1), mk(2), mk(3)];
const row = title => screen.getByText(title).closest('.trow');
const reorderCalls = () => api.mock.calls.filter(([path]) => path === '/tasks/reorder');

// 把 from 拖到 to 上面放開
function drag(from, to) {
  fireEvent.dragStart(row(from));
  fireEvent.dragOver(row(to));
  fireEvent.drop(row(to));
}

function mount(reload = vi.fn().mockResolvedValue(undefined)) {
  render(<Tasks view={{ type: 'tasks' }} tasks={tasks()} lists={[]} filters={[]}
    reload={reload} title="任務" />);
  return reload;
}

describe('拖曳排序的寫入／刷新邊界', () => {
  beforeEach(() => {
    localStorage.clear();
    api.mockReset();
  });

  it('寫入成功後等待刷新，送出的是放開位置對應的新順序', async () => {
    api.mockResolvedValue({ ok: true });
    const reload = mount();

    drag('任務 3', '任務 1');

    await waitFor(() => expect(reload).toHaveBeenCalledWith('tasks'));
    expect(reorderCalls()).toEqual([['/tasks/reorder', { method: 'POST', body: { ids: [3, 1, 2] } }]]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('排序寫入失敗時明確顯示錯誤、不刷新，之後仍可再拖一次', async () => {
    api.mockRejectedValueOnce(new Error('網路連線中斷'));
    const reload = mount();

    drag('任務 3', '任務 1');

    expect(await screen.findByRole('alert')).toHaveTextContent('網路連線中斷');
    expect(reload).not.toHaveBeenCalled();

    // 失敗後鎖要放開，使用者重拖才會真的再送一次
    api.mockResolvedValue({ ok: true });
    drag('任務 3', '任務 1');
    await waitFor(() => expect(reorderCalls()).toHaveLength(2));
    await waitFor(() => expect(reload).toHaveBeenCalledWith('tasks'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('排序已寫入但刷新失敗時，不誤報成排序失敗，並可只重試刷新', async () => {
    api.mockResolvedValue({ ok: true });
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error('刷新失敗'))
      .mockResolvedValue(undefined);
    mount(reload);

    drag('任務 3', '任務 1');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('排序已儲存，但畫面暫時無法重新載入。');
    expect(reorderCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(reload).toHaveBeenCalledTimes(2);
    // 重試只重新載入，不重送排序
    expect(reorderCalls()).toHaveLength(1);
  });

  it('上一次排序尚未寫入並刷新前，不會用舊畫面順序再送一批覆蓋', async () => {
    let resolveWrite;
    api.mockImplementation(path => path === '/tasks/reorder'
      ? new Promise(resolve => { resolveWrite = resolve; })
      : Promise.resolve({}));
    let resolveReload;
    const reload = vi.fn(() => new Promise(resolve => { resolveReload = resolve; }));
    mount(reload);

    drag('任務 3', '任務 1');
    await waitFor(() => expect(reorderCalls()).toHaveLength(1));

    // 寫入進行中：畫面仍是舊順序 1,2,3，再拖一次不能送出
    drag('任務 2', '任務 1');
    expect(reorderCalls()).toHaveLength(1);

    resolveWrite({ ok: true });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    // 寫入完成但刷新還沒回來：畫面仍是舊順序，依然要擋
    drag('任務 2', '任務 1');
    expect(reorderCalls()).toHaveLength(1);

    // 刷新結束後鎖放開
    await act(async () => { resolveReload(); });
    api.mockResolvedValue({ ok: true });
    reload.mockResolvedValue(undefined);
    drag('任務 2', '任務 1');
    await waitFor(() => expect(reorderCalls()).toHaveLength(2));
    expect(reorderCalls()[1][1].body.ids).toEqual([2, 1, 3]);
  });
});
