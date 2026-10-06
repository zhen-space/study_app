// 段考建立三步精靈（ExamCreateWizard）：不中斷流程、確認前不建 Plan、確認才 atomic 建立；
// 中文 IME 組字保持焦點；375px 手機操作。end-to-end 走「手動範圍」路徑（不需教材書櫃）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { act } from 'react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const ExamCreateWizard = (await import('../tt/ExamCreateWizard')).default;

const LISTS = [{ id: 1, name: '數學' }, { id: 2, name: '物理' }];
let calls;
const setApi = () => {
  calls = [];
  api.mockImplementation((path, opts) => {
    calls.push([path, opts]);
    if (path === '/exam-plans' && opts?.method === 'POST') return Promise.resolve({ plan: { id: 99 } });
    if (path === '/exam-plans/preview') return Promise.resolve({ preview_token: 'signed', blocks: [], scope: [
      { kind: 'manual', subject_list_id: 1, title: '講義第三章', estimated_minutes: null },
    ] });
    return Promise.resolve({});
  });
};
const posted = p => calls.filter(([path, o]) => path === p && (o?.method === 'POST'));
beforeEach(() => { localStorage.clear(); vi.spyOn(console, 'error').mockImplementation(() => {}); setApi(); });
afterEach(() => { vi.restoreAllMocks(); cleanup(); });
const click = el => act(async () => { el.click(); });

describe('ExamCreateWizard', () => {
  it('三步走完（手動範圍）→ 確認才 POST /exam-plans；建立前不建任何 Plan', async () => {
    const onDone = vi.fn();
    render(<ExamCreateWizard lists={LISTS} onDone={onDone} onCancel={() => {}} />);
    // Step 1：名稱 + 結束日 + 加入科目
    fireEvent.change(screen.getByLabelText('段考名稱'), { target: { value: '第二次段考' } });
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-02' } });
    fireEvent.change(screen.getByLabelText('加入科目'), { target: { value: '1' } });
    await waitFor(() => expect(screen.getByText('數學')).toBeTruthy());
    // 開精靈到這裡：完全沒有建立任何 Plan
    expect(posted('/plans').length).toBe(0);
    expect(posted('/exam-plans').length).toBe(0);
    await click(screen.getByText('下一步：加入各科範圍'));

    // Step 2：手動範圍（老師指定、教材庫沒有）
    await waitFor(() => expect(screen.getByText('選教材／勾課章')).toBeTruthy());
    await click(screen.getByText('＋ 老師指定、教材庫沒有的範圍'));
    fireEvent.change(screen.getByLabelText('老師指定範圍'), { target: { value: '講義第三章' } });
    await click(screen.getByText('加入'));
    await waitFor(() => expect(screen.getByText(/講義第三章/)).toBeTruthy());
    await click(screen.getByText('下一步：選擇怎麼安排'));

    // Step 3：預設 progress → 確認建立（atomic）
    await waitFor(() => expect(screen.getByText('希望怎麼安排？')).toBeTruthy());
    await click(screen.getByText('確認，建立段考計畫'));
    await waitFor(() => expect(posted('/exam-plans').length).toBe(1));
    const body = posted('/exam-plans')[0][1].body;
    expect(body.name).toBe('第二次段考');
    expect(body.end_date).toBe('2099-10-02');
    expect(body.level).toBe('progress');
    expect(body.subjects[0].subject_list_id).toBe(1);
    expect(body.manual_scope[0].label).toBe('講義第三章');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(99));
  });

  it('中文 IME：段考名稱在組字期間保持焦點', async () => {
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    const input = screen.getByLabelText('段考名稱');
    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'ㄉ' } });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '第' } });
    fireEvent.compositionEnd(input);
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(input);
  });

  it('P0-1：daily 排不下時，確認鍵停用並提供補救（回上一步／改用只分段）', async () => {
    api.mockImplementation((path, opts) => {
      calls.push([path, opts]);
      if (path === '/exam-plans/preview') return opts.body.level === 'progress'
        ? Promise.resolve({ preview_token: 'progress-signed', blocks: [], scope: [
          { kind: 'manual', subject_list_id: 1, title: '講義第三章', estimated_minutes: 60 },
        ] })
        : Promise.reject(new Error('有內容排不進去，請調整日期或範圍'));
      if (path === '/exam-plans' && opts?.method === 'POST') return Promise.resolve({ plan: { id: 99 } });
      return Promise.resolve({});
    });
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('段考名稱'), { target: { value: '第二次段考' } });
    fireEvent.change(screen.getByLabelText('開始日期'), { target: { value: '2099-09-20' } });
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-02' } });
    fireEvent.change(screen.getByLabelText('加入科目'), { target: { value: '1' } });
    await waitFor(() => expect(screen.getByText('數學')).toBeTruthy());
    await click(screen.getByText('下一步：加入各科範圍'));
    // 手動範圍（帶預估時間，才不會被「缺估時」擋住，測的是「排不下」這條）
    await click(screen.getByText('＋ 老師指定、教材庫沒有的範圍'));
    fireEvent.change(screen.getByLabelText('老師指定範圍'), { target: { value: '講義第三章' } });
    fireEvent.change(screen.getByLabelText('預估分鐘'), { target: { value: '60' } });
    await click(screen.getByText('加入'));
    await click(screen.getByText('下一步：選擇怎麼安排'));
    // 選「每天」→ 觸發預覽（回傳 unplaced）
    await waitFor(() => expect(screen.getByText('希望怎麼安排？')).toBeTruthy());
    await click(screen.getAllByRole('radio')[1]);
    await waitFor(() => expect(screen.getByText('還不能建立每天安排')).toBeTruthy());
    const previewBody = posted('/exam-plans/preview').at(-1)[1].body;
    expect(previewBody.start_date).toBe('2099-09-20');
    const confirmBtn = screen.getByText('確認，建立段考計畫').closest('button');
    expect(confirmBtn.disabled).toBe(true);
    // 按下也不會 POST
    await click(confirmBtn);
    expect(posted('/exam-plans').length).toBe(0);
    // 補救：改用「只分段」→ 變回可建立
    await click(screen.getByText(/改用/));
    await waitFor(() => expect(screen.getByText('確認，建立段考計畫').closest('button').disabled).toBe(false));
  });

  it('返回/取消：取消不建立 Plan', async () => {
    const onCancel = vi.fn();
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={onCancel} />);
    await click(screen.getByText(/取消/));
    expect(onCancel).toHaveBeenCalled();
    expect(posted('/exam-plans').length).toBe(0);
    expect(posted('/plans').length).toBe(0);
  });

  it('375px 多考科：逐科都要有範圍，明列缺少科目且不能進預覽', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('段考名稱'), { target: { value: '第二次段考' } });
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-02' } });
    fireEvent.change(screen.getByLabelText('加入科目'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('加入科目'), { target: { value: '2' } });
    await click(screen.getByText('下一步：加入各科範圍'));
    await click(screen.getAllByText('＋ 老師指定、教材庫沒有的範圍')[0]);
    fireEvent.change(screen.getByLabelText('老師指定範圍'), { target: { value: '數學第一章' } });
    await click(screen.getByText('加入'));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByText('尚未加入範圍：物理')).toBeTruthy();
    expect(screen.getByText('請替物理加入至少一項考試範圍。')).toBeTruthy();
    expect(screen.getByText('下一步：選擇怎麼安排').closest('button').disabled).toBe(true);
    expect(posted('/exam-plans/preview')).toHaveLength(0);
  });
});
