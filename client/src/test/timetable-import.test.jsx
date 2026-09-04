// 課表匯入 v2 的前端串接。
//
// 這一組要證明的是「真的接上了」，不是模組寫好了：
//   ・課表照片走的是 /import/timetable（結構層），不是會讓模型自己決定星期的舊路徑
//   ・低信心時，沒有明確確認就不能匯入
//   ・整週位移是一個動作改完，不是逐格改
//   ・有日期的行事曆仍走舊的 /import/parse，兩條路分流、沒有被誤刪
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
// 圖片縮圖用到 canvas 與 Image.onload，jsdom 裡不會完成。
// 這裡要驗的是「檔案選好之後走哪一條路」，不是圖片編碼。
vi.mock('../tt/vocabImport', () => ({
  fileToPayload: async f => ({ filename: f.name, mime: f.type, data: 'ZmFrZQ==' }),
  filesToPayloads: async () => [],
}));
const { api } = await import('../api');
const CalendarView = (await import('../tt/CalendarView')).default;

// 兩堂課，星期沒有標題所以是照欄序推的 → 需要確認
const PREVIEW = {
  mode: 'preview_only',
  can_persist: true,
  requires_mapping_confirmation: true,
  mapping_confidence: 0.5,
  warnings: ['missing_weekday_header'],
  weekday_mapping: { 1: 1, 2: 2 },
  items: [
    { day_of_week: 1, title: '數學', start_time: '08:10', end_time: '09:00' },
    { day_of_week: 2, title: '英文', start_time: '09:10', end_time: '10:00' },
  ],
};

const calls = () => api.mock.calls;
const pathsCalled = () => calls().map(([p]) => p);

function mockApi(preview = PREVIEW) {
  api.mockImplementation(async (path, opts) => {
    if (path === '/import/timetable') return preview;
    if (path === '/import/timetable/confirm') return { imported: opts.body.items.length };
    if (path === '/events') return [];
    if (path === '/settings') return { sleep_start: '23:00', sleep_end: '07:00', meal_windows: [] };
    return [];
  });
}

// 打開「新增」選單，選課表匯入，並丟一個假檔案進去
async function uploadTimetable(container) {
  fireEvent.click(screen.getByRole('button', { name: /新增|＋/ }));
  const label = await screen.findByText(/匯入課表照片/);
  const input = label.closest('label').querySelector('input[type="file"]');
  const file = new File(['x'], 'timetable.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('課表匯入 v2 串接', () => {
  beforeEach(() => { api.mockReset(); mockApi(); });

  it('課表照片走 /import/timetable，不走會讓模型決定星期的舊路徑', async () => {
    const { container } = render(<CalendarView tasks={[]} reload={async () => {}} />);
    await uploadTimetable(container);
    await waitFor(() => expect(pathsCalled()).toContain('/import/timetable'));
    expect(pathsCalled()).not.toContain('/import/parse');
  });

  it('低信心時顯示看得懂的說明，而不是模型術語', async () => {
    render(<CalendarView tasks={[]} reload={async () => {}} />);
    await uploadTimetable();
    expect(await screen.findByText(/看不到「星期一、星期二…」的標題/)).toBeTruthy();
    expect(screen.queryByText(/confidence|mapping|positional/i)).toBeNull();
  });

  it('沒有勾「星期是對的」就不能匯入', async () => {
    render(<CalendarView tasks={[]} reload={async () => {}} />);
    await uploadTimetable();
    const btn = await screen.findByRole('button', { name: '確認匯入' });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(pathsCalled()).not.toContain('/import/timetable/confirm');
  });

  it('勾了之後才能匯入，且送出 mapping_confirmed', async () => {
    render(<CalendarView tasks={[]} reload={async () => {}} />);
    await uploadTimetable();
    fireEvent.click(await screen.findByLabelText(/我確認上面的星期是對的/));
    const btn = await screen.findByRole('button', { name: '確認匯入' });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(pathsCalled()).toContain('/import/timetable/confirm'));
    const [, opts] = calls().find(([p]) => p === '/import/timetable/confirm');
    expect(opts.body.mapping_confirmed).toBe(true);
    expect(opts.body.requires_mapping_confirmation).toBe(true);
    expect(opts.body.items.length).toBe(2);
  });

  it('整週往前一天：一個動作改完全部，不用逐格改', async () => {
    render(<CalendarView tasks={[]} reload={async () => {}} />);
    await uploadTimetable();
    fireEvent.click(await screen.findByRole('button', { name: '整週往前一天' }));
    fireEvent.click(screen.getByLabelText(/我確認上面的星期是對的/));
    fireEvent.click(screen.getByRole('button', { name: '確認匯入' }));
    await waitFor(() => expect(pathsCalled()).toContain('/import/timetable/confirm'));
    const [, opts] = calls().find(([p]) => p === '/import/timetable/confirm');
    // 原本是週一、週二 → 整週往前一天變成週日、週一
    expect(opts.body.items.map(x => x.day_of_week)).toEqual([0, 1]);
  });

  it('結構讀不出來時不給匯入', async () => {
    mockApi({ ...PREVIEW, can_persist: false, errors: ['no_course_columns'] });
    render(<CalendarView tasks={[]} reload={async () => {}} />);
    await uploadTimetable();
    const btn = await screen.findByRole('button', { name: '確認匯入' });
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/讀不出可用的結構/)).toBeTruthy();
  });

  it('高信心時不需要額外確認就能匯入', async () => {
    mockApi({ ...PREVIEW, requires_mapping_confirmation: false, mapping_confidence: 0.98, warnings: [] });
    render(<CalendarView tasks={[]} reload={async () => {}} />);
    await uploadTimetable();
    const btn = await screen.findByRole('button', { name: '確認匯入' });
    expect(btn.disabled).toBe(false);
    expect(screen.queryByLabelText(/我確認上面的星期是對的/)).toBeNull();
  });

  it('有日期的行事曆仍走舊的 /import/parse——兩條路分流，沒有誤刪', async () => {
    api.mockImplementation(async path => {
      if (path === '/import/parse') return { events: [] };
      return [];
    });
    render(<CalendarView tasks={[]} reload={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /新增|＋/ }));
    const label = await screen.findByText(/匯入行事曆照片/);
    const input = label.closest('label').querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [new File(['x'], 'cal.png', { type: 'image/png' })] } });
    await waitFor(() => expect(pathsCalled()).toContain('/import/parse'));
    expect(pathsCalled()).not.toContain('/import/timetable');
  });
});
