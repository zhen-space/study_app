// 學校作業前端：純函式（逾期／分組／期限顯示／提醒 contract）＋ 串接（表單、
// 生命週期、Calendar 投影）。守的是「學生端可用」而且「不破壞既有契約」：
//   ・deadline 與 due 分離、不建 ScheduledBlock
//   ・前端不自建 previous_friday 演算法，只把 contract 原樣送回
//   ・逾期現算、Today 三分組允許重疊
//   ・生命週期沿用既有 Task API（PATCH /tasks/:id）
//   ・Plan lifecycle 投影不 regression、標準任務 UI 不 regression
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  isOverdue, groupSchoolAssignments, formatDeadline, deadlineLabelText,
  reminderSelectionToFields, reminderFieldsToSelection, effectiveDeadlineTime,
} from '../tt/schoolAssignment';
import { matchView, onActivePlan, today } from '../tt/helpers';
import { pickStudyTasks } from '../tt/StudyView';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const SchoolAssignmentForm = (await import('../tt/SchoolAssignmentForm')).default;
const { SARow, SchoolAssignmentToday } = await import('../tt/SchoolAssignmentView');
const CalendarView = (await import('../tt/CalendarView')).default;

const sa = (o = {}) => ({
  id: 1, task_kind: 'school_assignment', school_assignment_type: 'homework',
  title: '作業', list_id: 1, deadline_date: '2026-09-10', deadline_time: null,
  completed: 0, cancelled: 0, deleted: 0, tags: [], subtasks: [], ...o,
});
const NOW = { date: '2026-09-10', time: '14:00' };

/* ==================== 純函式：逾期 ==================== */
describe('逾期現算', () => {
  it('已過期限日 → 逾期', () => {
    expect(isOverdue(sa({ deadline_date: '2026-09-09' }), NOW)).toBe(true);
  });
  it('未到期限日 → 不逾期', () => {
    expect(isOverdue(sa({ deadline_date: '2026-09-11' }), NOW)).toBe(false);
  });
  it('deadline_time = null 當天要到 23:59 才算逾期，下午兩點不算', () => {
    expect(effectiveDeadlineTime(sa({ deadline_time: null }))).toBe('23:59');
    expect(isOverdue(sa({ deadline_date: '2026-09-10', deadline_time: null }), NOW)).toBe(false);
  });
  it('當天有指定時間，過了時間才逾期；剛好到點不算', () => {
    expect(isOverdue(sa({ deadline_time: '12:00' }), NOW)).toBe(true);
    expect(isOverdue(sa({ deadline_time: '14:00' }), NOW)).toBe(false); // 剛好到點不算遲交
    expect(isOverdue(sa({ deadline_time: '15:00' }), NOW)).toBe(false);
  });
  it('completed / cancelled / deleted 一律不算逾期', () => {
    const base = { deadline_date: '2026-09-01' };
    expect(isOverdue(sa({ ...base, completed: 1 }), NOW)).toBe(false);
    expect(isOverdue(sa({ ...base, cancelled: 1 }), NOW)).toBe(false);
    expect(isOverdue(sa({ ...base, deleted: 1 }), NOW)).toBe(false);
  });
});

/* ==================== 純函式：Today 三分組 ==================== */
describe('Today 三分組', () => {
  const today = sa({ id: 1, deadline_date: '2026-09-10', deadline_time: '23:00' });
  const soon = sa({ id: 2, deadline_date: '2026-09-14' });
  const far = sa({ id: 3, deadline_date: '2026-09-30' });
  const late = sa({ id: 4, deadline_date: '2026-09-05' });
  const overlap = sa({ id: 5, deadline_date: '2026-09-10', deadline_time: '12:00' }); // 今天中午、現在下午
  const g = groupSchoolAssignments([today, soon, far, late, overlap], NOW);

  it('今天要交 = deadline_date 為今天', () => {
    expect(g.due_today.map(t => t.id)).toContain(1);
  });
  it('即將到期 = today < deadline <= today+7', () => {
    expect(g.upcoming.map(t => t.id)).toEqual([2]); // 09-14 在 7 天內；09-30 不在
    expect(g.upcoming.map(t => t.id)).not.toContain(3);
  });
  it('已逾期 = isOverdue', () => {
    expect(g.overdue.map(t => t.id).sort()).toEqual([4, 5]);
  });
  it('今天已逾期的仍同時出現在「今天要交」（分組允許重疊）', () => {
    expect(g.due_today.map(t => t.id)).toContain(5); // 中午 12:00 那筆
    expect(g.overdue.map(t => t.id)).toContain(5);   // 同時逾期
  });
  it('completed 不進任何 pending 分組', () => {
    const g2 = groupSchoolAssignments([sa({ id: 9, deadline_date: '2026-09-10', completed: 1 })], NOW);
    expect(g2.due_today).toHaveLength(0);
    expect(g2.overdue).toHaveLength(0);
  });
});

/* ==================== 純函式：顯示 ==================== */
describe('期限顯示', () => {
  it('考試講「考試時間」，其餘講「繳交期限」', () => {
    expect(deadlineLabelText(sa({ school_assignment_type: 'exam' }))).toBe('考試時間');
    expect(deadlineLabelText(sa({ school_assignment_type: 'homework' }))).toBe('繳交期限');
  });
  it('deadline_time 為 null 時只顯示日期，不顯示假的 23:59', () => {
    const s = formatDeadline(sa({ deadline_date: '2026-09-10', deadline_time: null }));
    expect(s).not.toContain('23:59');
    expect(s).toContain('9/10');
  });
  it('有時間才顯示時間', () => {
    expect(formatDeadline(sa({ deadline_date: '2026-09-10', deadline_time: '18:30' }))).toContain('18:30');
  });
});

/* ==================== 純函式：提醒 contract（不自建 previous_friday） ==================== */
describe('提醒選項對應 backend 欄位', () => {
  it('前一個週五：只送 reminder_kind，日期由 backend 算', () => {
    const f = reminderSelectionToFields('previous_friday');
    expect(f.reminder_kind).toBe('previous_friday');
    expect(f.reminder_days_before).toBeNull();
    expect(f.reminder_custom_date).toBeNull();
  });
  it('前 N 天：帶 reminder_days_before，只收 1/2/3/7', () => {
    expect(reminderSelectionToFields('days_before:3').reminder_days_before).toBe(3);
    expect(reminderSelectionToFields('days_before:5').reminder_days_before).toBeNull();
  });
  it('自訂：帶日期', () => {
    expect(reminderSelectionToFields('custom', { customDate: '2026-09-01' }).reminder_custom_date).toBe('2026-09-01');
  });
  it('回填：欄位 → 選單值', () => {
    expect(reminderFieldsToSelection({ reminder_kind: 'days_before', reminder_days_before: 7 })).toBe('days_before:7');
    expect(reminderFieldsToSelection({ reminder_kind: 'previous_friday' })).toBe('previous_friday');
    expect(reminderFieldsToSelection({ reminder_kind: null })).toBe('none');
  });
});

/* ==================== Plan lifecycle / 標準任務 不 regression ==================== */
describe('Plan lifecycle 投影不 regression', () => {
  it('掛在已結束計畫的學校作業不進 Study 候選', () => {
    const ended = sa({ id: 1, plan_id: 5, plan_status: 'ended', due_date: '2026-09-10' });
    const active = sa({ id: 2, plan_id: 6, plan_status: 'active', due_date: '2026-09-10' });
    const picked = pickStudyTasks([ended, active], '2026-09-10', Infinity);
    expect(picked.map(t => t.id)).not.toContain(1);
    expect(onActivePlan(ended)).toBe(false);
  });
  it('standalone 學校作業（plan_id=NULL）是正常任務，onActivePlan 為真', () => {
    expect(onActivePlan(sa({ plan_id: null, plan_status: null }))).toBe(true);
  });
});
describe('標準任務 UI 不 regression', () => {
  it('一般任務仍照 matchView 運作，未受學校作業影響', () => {
    const std = { id: 1, plan_id: null, title: 'x', due_date: '2026-09-10', completed: 0, deleted: 0, list_id: 1, tags: [], subtasks: [] };
    expect(matchView(std, { type: 'all' }, { filters: [] })).toBe(true);
  });
});

/* ==================== 串接：表單 ==================== */
describe('新增／編輯表單', () => {
  const lists = [{ id: 1, name: '數學' }, { id: 2, name: '英文' }];
  beforeEach(() => { api.mockReset(); api.mockResolvedValue({}); });

  async function fillMinimum() {
    fireEvent.change(screen.getByPlaceholderText(/第 3 章習題/), { target: { value: '第 1 章' } });
    fireEvent.change(screen.getByLabelText(/繳交期限日期/), { target: { value: '2026-09-20' } });
  }

  it('四種類型都能建立，且送出 task_kind=school_assignment', async () => {
    for (const [label, type] of [['作業', 'homework'], ['報告', 'report'], ['考試', 'exam'], ['其他', 'other']]) {
      api.mockReset(); api.mockResolvedValue({});
      const { unmount } = render(<SchoolAssignmentForm lists={lists} onClose={() => {}} onSaved={() => {}} />);
      await fillMinimum();
      // 類型是 SegmentedControl 按鈕；考試會把日期 label 改成「考試時間日期」，先點類型再填日期
      fireEvent.click(screen.getByRole('tab', { name: label }));
      const dateLabel = type === 'exam' ? /考試時間日期/ : /繳交期限日期/;
      fireEvent.change(screen.getByLabelText(dateLabel), { target: { value: '2026-09-20' } });
      fireEvent.click(screen.getByRole('button', { name: '新增作業' }));
      await waitFor(() => expect(api).toHaveBeenCalled());
      const [, opts] = api.mock.calls.find(c => c[0] === '/tasks');
      expect(opts.method).toBe('POST');
      expect(opts.body.task_kind).toBe('school_assignment');
      expect(opts.body.school_assignment_type).toBe(type);
      unmount();
    }
  });

  it('期限走 deadline_date，絕不送 due_date / due_time', async () => {
    render(<SchoolAssignmentForm lists={lists} onClose={() => {}} onSaved={() => {}} />);
    await fillMinimum();
    fireEvent.click(screen.getByRole('button', { name: '新增作業' }));
    await waitFor(() => expect(api).toHaveBeenCalled());
    const [, opts] = api.mock.calls.find(c => c[0] === '/tasks');
    expect(opts.body.deadline_date).toBe('2026-09-20');
    expect(opts.body).not.toHaveProperty('due_date');
    expect(opts.body).not.toHaveProperty('due_time');
  });

  it('「前一個週五」把 contract 原樣送出（前端不自算日期）', async () => {
    render(<SchoolAssignmentForm lists={lists} onClose={() => {}} onSaved={() => {}} />);
    await fillMinimum();
    fireEvent.change(screen.getByLabelText('提醒'), { target: { value: 'previous_friday' } });
    fireEvent.click(screen.getByRole('button', { name: '新增作業' }));
    await waitFor(() => expect(api).toHaveBeenCalled());
    const [, opts] = api.mock.calls.find(c => c[0] === '/tasks');
    expect(opts.body.reminder_kind).toBe('previous_friday');
    expect(opts.body.reminder_days_before).toBeNull();
    // 前端沒有替 backend 算出提醒日期
    expect(opts.body).not.toHaveProperty('reminder_resolved_date');
  });

  it('編輯走 PATCH /tasks/:id', async () => {
    render(<SchoolAssignmentForm lists={lists} task={sa({ id: 42, list_id: 1, deadline_date: '2026-09-20' })} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByDisplayValue('作業'), { target: { value: '作業（改）' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/42', expect.objectContaining({ method: 'PATCH' })));
  });

  it('缺名稱／缺日期會擋下、不打 API', async () => {
    render(<SchoolAssignmentForm lists={lists} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '新增作業' }));
    expect(api).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

/* ==================== 串接：生命週期（沿用 Task API） ==================== */
describe('生命週期沿用既有 Task API', () => {
  const reload = vi.fn();
  beforeEach(() => { api.mockReset(); api.mockResolvedValue({}); reload.mockReset(); });

  it('完成 → PATCH completed:true', async () => {
    render(<SARow t={sa({ id: 7 })} list={{ id: 1, name: '數學' }} now={NOW} onEdit={() => {}} reload={reload} />);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/7', { method: 'PATCH', body: { completed: true } }));
  });
  it('取消 → PATCH cancelled:true', async () => {
    render(<SARow t={sa({ id: 8 })} list={{ id: 1, name: '數學' }} now={NOW} onEdit={() => {}} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '取消作業' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/8', { method: 'PATCH', body: { cancelled: true } }));
  });
  it('刪除（確認後）→ PATCH deleted:true', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    render(<SARow t={sa({ id: 9 })} list={{ id: 1, name: '數學' }} now={NOW} onEdit={() => {}} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '刪除' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/9', { method: 'PATCH', body: { deleted: true } }));
  });
  it('已完成的可重新開啟 → PATCH completed:false, cancelled:false', async () => {
    render(<SARow t={sa({ id: 10, completed: 1 })} list={{ id: 1, name: '數學' }} now={NOW} onEdit={() => {}} reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重新開啟' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/tasks/10', { method: 'PATCH', body: { completed: false, cancelled: false } }));
  });
});

/* ==================== 串接：Calendar 投影（顯示 deadline，不建 block） ==================== */
describe('Calendar 顯示學校作業繳交期限', () => {
  beforeEach(() => { api.mockReset(); api.mockResolvedValue([]); });

  it('日視圖顯示繳交期限標記，且不建立 ScheduledBlock（不打任何 POST）', async () => {
    const td = today();
    const saTask = sa({ id: 21, title: '物理報告', school_assignment_type: 'report', deadline_date: td, deadline_time: null });
    render(<CalendarView tasks={[saTask]} reload={vi.fn()} lists={[{ id: 1, name: '物理' }]} />);
    // 切到日視圖（anchor 預設是今天）
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'day' } });
    const chip = await screen.findByTitle(/繳交期限：物理報告/);
    expect(chip).toHaveClass('cal-deadline');           // 是期限標記，不是一般任務 chip（cal-task）
    expect(chip).not.toHaveClass('cal-task');
    // 學校作業本身沒有 due_date：deadline 不會變成排程時間軸上的 block
    expect(saTask).not.toHaveProperty('due_date');
    // 純顯示：render 過程不會 POST 出任何 block / task
    const posts = api.mock.calls.filter(c => c[1]?.method === 'POST');
    expect(posts).toHaveLength(0);
  });
});

/* ==================== 執行面：非進行中計畫的作業退出 Today ==================== */
describe('Today 只收進行中計畫（含 standalone）的作業', () => {
  beforeEach(() => { api.mockReset(); api.mockResolvedValue({}); });

  it('掛在 ended 計畫的逾期作業不出現在 Today；standalone 逾期作業出現', () => {
    const past = '2020-01-01'; // 永遠逾期，與執行日無關
    const standalone = sa({ id: 1, title: '單機作業', plan_id: null, plan_status: null, deadline_date: past });
    const onEnded = sa({ id: 2, title: '結束計畫作業', plan_id: 9, plan_status: 'ended', deadline_date: past });
    const onPaused = sa({ id: 3, title: '暫停計畫作業', plan_id: 8, plan_status: 'paused', deadline_date: past });
    render(<SchoolAssignmentToday tasks={[standalone, onEnded, onPaused]} lists={[{ id: 1, name: '數學' }]} reload={vi.fn()} />);
    expect(screen.getByText('單機作業')).toBeInTheDocument();
    expect(screen.queryByText('結束計畫作業')).not.toBeInTheDocument();
    expect(screen.queryByText('暫停計畫作業')).not.toBeInTheDocument();
  });
});
