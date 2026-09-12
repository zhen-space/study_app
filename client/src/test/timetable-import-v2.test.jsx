// 課表匯入 v2 的新前端保證：
//   ・Review UX：原圖、低信心標示、補漏、改星期/科目/時間、刪除、雙重確認 gate
//   ・WizardView 的「AI 匯入課表」改走 /import/timetable，不再走 /import/parse
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
vi.mock('../tt/vocabImport', () => ({
  fileToPayload: async f => ({ filename: f.name, mime: f.type, data: 'ZmFrZQ==' }),
  filesToPayload: async () => [],
}));
const { api } = await import('../api');
const TimetableImporter = (await import('../tt/TimetableImporter')).default;
const WizardView = (await import('../tt/WizardView')).default;

const calls = () => api.mock.calls;
const pathsCalled = () => calls().map(([p]) => p);

// 兩堂課、星期一整欄漏掉、需要確認
const PREVIEW = {
  mode: 'preview_only', can_persist: true, requires_mapping_confirmation: true, uncertain: true,
  mapping_confidence: 0.4, warnings: ['missing_weekday_header', 'leading_missing_column'],
  missing_columns: [1], missing_weekdays: [1],
  items: [
    { day_of_week: 2, title: '英文', start_time: '08:10', end_time: '09:00', uncertain: true },
    { day_of_week: 3, title: '數學', start_time: '09:10', end_time: '10:00', uncertain: true },
  ],
};

const PAYLOAD = { filename: 't.png', mime: 'image/png', data: 'ZmFrZQ==' };

function mountImporter(preview = PREVIEW, onImported = vi.fn()) {
  api.mockImplementation(async (path, opts) => {
    if (path === '/import/timetable') return preview;
    if (path === '/import/timetable/confirm') return { imported: opts.body.items.length };
    return [];
  });
  render(<TimetableImporter payload={PAYLOAD} imageUrl="data:image/png;base64,ZmFrZQ==" onClose={() => {}} onImported={onImported} />);
  return onImported;
}

const rowCount = () => document.querySelectorAll('.imp-row').length;

describe('課表匯入 v2 Review UX', () => {
  beforeEach(() => { api.mockReset(); });

  it('顯示原始上傳圖片', async () => {
    mountImporter();
    expect(await screen.findByAltText('上傳的課表原圖')).toBeTruthy();
  });

  it('低信心 / 缺欄有明確視覺提示，且不講模型術語', async () => {
    mountImporter();
    expect(await screen.findByText(/看不到「星期一、星期二…」的標題/)).toBeTruthy();
    expect(screen.getByText(/整欄漏掉/)).toBeTruthy();               // 星期一那欄可能空的
    expect(screen.getAllByLabelText('低信心').length).toBe(2);        // 每一筆都標低信心
    expect(screen.queryByText(/confidence|positional|leading_missing/i)).toBeNull();
  });

  it('可以新增漏掉的課', async () => {
    mountImporter();
    await screen.findByText(/課表辨識結果/);
    expect(rowCount()).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增漏掉的課' }));
    expect(rowCount()).toBe(3);
  });

  it('可以刪除一筆', async () => {
    mountImporter();
    await screen.findByText(/課表辨識結果/);
    fireEvent.click(screen.getByRole('button', { name: '刪除第 1 堂' }));
    expect(rowCount()).toBe(1);
  });

  it('可以改星期 / 科目 / 起訖時間，且送出的是改過的值', async () => {
    const onImported = mountImporter();
    await screen.findByText(/課表辨識結果/);
    // 改第一堂：星期二→星期五、英文→體育、08:10→10:00 / 09:00→11:00
    fireEvent.change(screen.getByLabelText('第 1 堂星期'), { target: { value: '5' } });
    const titleInputs = document.querySelectorAll('.imp-title');
    fireEvent.change(titleInputs[0], { target: { value: '體育' } });
    const timeInputs = document.querySelectorAll('.imp-time');
    fireEvent.change(timeInputs[0], { target: { value: '10:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '11:00' } });
    // 通過雙重 gate
    fireEvent.click(screen.getByLabelText(/我確認上面的星期是對的/));
    fireEvent.click(screen.getByRole('button', { name: '確認匯入' }));
    await waitFor(() => expect(pathsCalled()).toContain('/import/timetable/confirm'));
    const [, opts] = calls().find(([p]) => p === '/import/timetable/confirm');
    expect(opts.body.items[0]).toMatchObject({ day_of_week: 5, title: '體育', start_time: '10:00', end_time: '11:00' });
    expect(opts.body.mapping_confirmed).toBe(true);
    expect(onImported).toHaveBeenCalledWith(2);
  });

  it('雙重 gate：沒勾確認不能匯入，勾了才能', async () => {
    mountImporter();
    const btn = await screen.findByRole('button', { name: '確認匯入' });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(pathsCalled()).not.toContain('/import/timetable/confirm');
    fireEvent.click(screen.getByLabelText(/我確認上面的星期是對的/));
    expect(screen.getByRole('button', { name: '確認匯入' }).disabled).toBe(false);
  });

  it('高信心時不需要額外確認', async () => {
    mountImporter({ ...PREVIEW, requires_mapping_confirmation: false, uncertain: false, warnings: [], missing_weekdays: [], items: [{ day_of_week: 1, title: '國文', start_time: '08:10', end_time: '09:00' }] });
    const btn = await screen.findByRole('button', { name: '確認匯入' });
    expect(btn.disabled).toBe(false);
    expect(screen.queryByLabelText(/我確認上面的星期是對的/)).toBeNull();
  });
});

describe('WizardView timetable import 走 v2 pipeline', () => {
  beforeEach(() => { api.mockReset(); });

  it('「AI 匯入課表」呼叫 /import/timetable，不呼叫 /import/parse', async () => {
    api.mockImplementation(async (path) => {
      if (path === '/settings') return { sleep_start: '23:00', sleep_end: '07:00', meal_windows: [] };
      if (path === '/import/timetable') return { ...PREVIEW };
      return [];
    });
    // initialSection='time' → 直接停在步驟 2「怎麼安排」，可用時間區塊才會渲染
    render(<WizardView lists={[]} tasks={[]} reload={async () => {}} initialSection="time" />);
    const label = await screen.findByText(/AI 匯入課表/);
    const input = label.closest('label').querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [new File(['x'], 'tt.png', { type: 'image/png' })] } });
    await waitFor(() => expect(pathsCalled()).toContain('/import/timetable'));
    expect(pathsCalled()).not.toContain('/import/parse');
  });
});
