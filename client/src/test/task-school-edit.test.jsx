import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn(() => Promise.resolve([])) }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;
const { Detail } = await import('../tt/Tasks');

const lists = [{ id: 1, name: '數學', color: '#3b82f6' }, { id: 2, name: '英文', color: '#22c55e' }];
const assignment = (over = {}) => ({
  id: 31, task_kind: 'school_assignment', school_assignment_type: 'homework',
  title: '數學習作', notes: '', list_id: 1, priority: 0, tags: [], subtasks: [],
  recurring: null, miss_policy: null, due_date: null, due_time: null,
  deadline_date: '2026-10-10', deadline_time: '18:00', estimated_minutes: 40,
  plan_id: null, completed: 0, deleted: 0, cancelled: 0, order_index: 1, ...over,
});

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue([]);
});

describe('學校作業編輯', () => {
  it('375px 編輯真正的繳交期限與估時，不誤寫一般任務日期；Plan linkage 清楚但不直接改綁', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const onSave = vi.fn();
    render(<Detail task={assignment({ plan_id: 12 })} lists={lists} onSave={onSave} onDelete={() => {}} onClose={() => {}} />);

    expect(screen.getByText(/已加入讀書計畫/)).toBeTruthy();
    expect(screen.queryByText('重複')).toBeNull();
    fireEvent.change(screen.getByLabelText('繳交日期'), { target: { value: '2026-10-12' } });
    expect(onSave.mock.lastCall[0]).toMatchObject({ deadline_date: '2026-10-12', due_date: null });
    fireEvent.change(screen.getByLabelText('繳交時間'), { target: { value: '20:30' } });
    expect(onSave.mock.lastCall[0]).toMatchObject({ deadline_time: '20:30', due_time: null });
    fireEvent.change(screen.getByLabelText('預估時間（分鐘）'), { target: { value: '55' } });
    expect(onSave.mock.lastCall[0]).toMatchObject({ estimated_minutes: 55 });
  });

  it('中文輸入法組字時按 Enter 不會提前建立標籤', () => {
    const onSave = vi.fn();
    render(<Detail task={assignment()} lists={lists} onSave={onSave} onDelete={() => {}} onClose={() => {}} />);
    const input = screen.getByPlaceholderText('＋標籤');
    fireEvent.change(input, { target: { value: '複習' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSave).not.toHaveBeenCalled();
    expect(input.value).toBe('複習');
  });

  it('API 失敗留在編輯畫面並可重試，成功後才關閉；payload 保留 domain identity', async () => {
    const reload = vi.fn(() => Promise.resolve());
    api.mockImplementation(path => {
      if (path.includes('/attachments') || path === '/study-sessions') return Promise.resolve([]);
      return Promise.reject(new Error('網路暫時中斷'));
    });
    render(<Tasks view={{ type: 'tasks' }} tasks={[assignment()]} lists={lists} filters={[]} reload={reload} title="任務" />);
    fireEvent.click(screen.getByText('數學習作'));
    fireEvent.change(screen.getByLabelText('繳交日期'), { target: { value: '2026-10-15' } });
    fireEvent.click(screen.getByRole('button', { name: '✓ 完成' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('網路暫時中斷');
    expect(screen.getByLabelText('繳交日期')).toHaveValue('2026-10-15');
    expect(reload).not.toHaveBeenCalled();

    api.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: '✓ 完成' }));
    await waitFor(() => expect(screen.queryByLabelText('繳交日期')).toBeNull());
    const patch = api.mock.calls.filter(([, opts]) => opts?.method === 'PATCH').at(-1);
    expect(patch[1].body).toMatchObject({
      task_kind: 'school_assignment', school_assignment_type: 'homework',
      deadline_date: '2026-10-15', deadline_time: '18:00', estimated_minutes: 40,
    });
    expect(patch[1].body).not.toHaveProperty('due_date');
    expect(patch[1].body).not.toHaveProperty('due_time');
    expect(reload).toHaveBeenCalledWith('tasks');
  });

  it('連續編輯會依序儲存，較舊請求不能晚到覆蓋新期限', async () => {
    let releaseFirst;
    const first = new Promise(resolve => { releaseFirst = resolve; });
    let patchCount = 0;
    api.mockImplementation((path, opts) => {
      if (opts?.method === 'PATCH') return ++patchCount === 1 ? first : Promise.resolve({ ok: true });
      return Promise.resolve([]);
    });
    render(<Tasks view={{ type: 'tasks' }} tasks={[assignment()]} lists={lists} filters={[]} reload={() => {}} title="任務" />);
    fireEvent.click(screen.getByText('數學習作'));
    fireEvent.change(screen.getByLabelText('繳交日期'), { target: { value: '2026-10-11' } });
    await waitFor(() => expect(api.mock.calls.filter(([, o]) => o?.method === 'PATCH')).toHaveLength(1), { timeout: 1000 });
    fireEvent.change(screen.getByLabelText('繳交日期'), { target: { value: '2026-10-12' } });
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(api.mock.calls.filter(([, o]) => o?.method === 'PATCH')).toHaveLength(1);

    releaseFirst({ ok: true });
    await waitFor(() => expect(api.mock.calls.filter(([, o]) => o?.method === 'PATCH')).toHaveLength(2));
    const patches = api.mock.calls.filter(([, o]) => o?.method === 'PATCH');
    expect(patches.map(([, o]) => o.body.deadline_date)).toEqual(['2026-10-11', '2026-10-12']);
  });
});
