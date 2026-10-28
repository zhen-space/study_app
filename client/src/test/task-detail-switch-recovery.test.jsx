import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

// 桌面版明細是側欄，清單列仍可點。A 的儲存還沒寫入（去抖動中或已失敗）時直接點 B，
// 不能讓 B 的編輯把 A 的草稿從待存區擠掉——那會無聲遺失 A 的修改。
const taskA = { ...fx.tasks[0], id: 601, list_id: null, title: '數學作業', notes: '', tags: [], plan_id: null, completed: false, deleted: false };
const taskB = { ...fx.tasks[0], id: 602, list_id: null, title: '英文作業', notes: '', tags: [], plan_id: null, completed: false, deleted: false };
const patches = id => api.mock.calls.filter(([path, options]) => path === `/tasks/${id}` && options?.method === 'PATCH');

describe('任務明細切換到另一筆任務時保留未寫入的草稿', () => {
  beforeEach(() => {
    localStorage.clear();
    api.mockReset();
  });

  it('A 儲存失敗時點 B：留在 A、保留草稿，不切換也不送 B', async () => {
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/601' && options.method === 'PATCH') return Promise.reject(new Error('網路中斷'));
      return Promise.resolve([]);
    });
    render(<Tasks view={{ type: 'tasks' }} tasks={[taskA, taskB]} lists={fx.lists} filters={[]}
      reload={vi.fn().mockResolvedValue(undefined)} title="任務" />);
    fireEvent.click(screen.getByText('數學作業'));
    fireEvent.change(screen.getByPlaceholderText('備註...'), { target: { value: '第三章重點' } });
    expect(await screen.findByText(/網路中斷/)).toBeInTheDocument();
    expect(patches(601)).toHaveLength(1);

    fireEvent.click(screen.getByText('英文作業'));
    await waitFor(() => expect(patches(601)).toHaveLength(2));
    expect(patches(601)[1][1].body.notes).toBe('第三章重點');
    // 仍停在 A，草稿與錯誤都看得到
    expect(screen.getByPlaceholderText('備註...')).toHaveValue('第三章重點');
    expect(screen.getByDisplayValue('數學作業')).toBeInTheDocument();
    expect(screen.getByText(/網路中斷/)).toBeInTheDocument();
    expect(patches(602)).toHaveLength(0);
  });

  it('A 先失敗、重試成功後才切換到 B，B 的編輯不會覆蓋掉 A', async () => {
    let failA = true;
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/601' && options.method === 'PATCH') {
        if (failA) { failA = false; return Promise.reject(new Error('網路中斷')); }
        return Promise.resolve({});
      }
      return Promise.resolve([]);
    });
    render(<Tasks view={{ type: 'tasks' }} tasks={[taskA, taskB]} lists={fx.lists} filters={[]}
      reload={vi.fn().mockResolvedValue(undefined)} title="任務" />);
    fireEvent.click(screen.getByText('數學作業'));
    fireEvent.change(screen.getByPlaceholderText('備註...'), { target: { value: '第三章重點' } });
    expect(await screen.findByText(/網路中斷/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('英文作業'));
    expect(await screen.findByDisplayValue('英文作業')).toBeInTheDocument();
    expect(screen.queryByText(/網路中斷/)).toBeNull();
    expect(patches(601)).toHaveLength(2);
    expect(patches(601)[1][1].body.notes).toBe('第三章重點');

    fireEvent.change(screen.getByPlaceholderText('備註...'), { target: { value: '單字 20 個' } });
    fireEvent.click(screen.getByTitle('完成編輯'));
    await waitFor(() => expect(screen.queryByTitle('完成編輯')).toBeNull());
    expect(patches(602)).toHaveLength(1);
    expect(patches(602)[0][1].body.notes).toBe('單字 20 個');
    expect(patches(601)).toHaveLength(2);
  });

  it('A 還在去抖動時點 B：先把 A 寫入再切換', async () => {
    api.mockImplementation(() => Promise.resolve([]));
    render(<Tasks view={{ type: 'tasks' }} tasks={[taskA, taskB]} lists={fx.lists} filters={[]}
      reload={vi.fn().mockResolvedValue(undefined)} title="任務" />);
    fireEvent.click(screen.getByText('數學作業'));
    fireEvent.change(screen.getByPlaceholderText('備註...'), { target: { value: '第三章重點' } });
    fireEvent.click(screen.getByText('英文作業'));
    expect(await screen.findByDisplayValue('英文作業')).toBeInTheDocument();
    expect(patches(601)).toHaveLength(1);
    expect(patches(601)[0][1].body.notes).toBe('第三章重點');

    fireEvent.change(screen.getByPlaceholderText('備註...'), { target: { value: '單字 20 個' } });
    fireEvent.click(screen.getByTitle('完成編輯'));
    await waitFor(() => expect(patches(602)).toHaveLength(1));
    expect(patches(601)).toHaveLength(1);
  });
});
