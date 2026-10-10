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
    ], progress_segments: [{ subject_list_id: 1, subject_name: '數學', start_date: '2099-09-20', end_date: '2099-10-02',
      items: [{ title: '講義第三章', minutes: 30 }] }] });
    return Promise.resolve({});
  });
};
const posted = p => calls.filter(([path, o]) => path === p && (o?.method === 'POST'));
beforeEach(() => { localStorage.clear(); vi.spyOn(console, 'error').mockImplementation(() => {}); setApi(); });
afterEach(() => { vi.restoreAllMocks(); cleanup(); });
const click = el => act(async () => { el.click(); });

describe('ExamCreateWizard', () => {
  it('沒有任何科目時說明下一步並可前往既有科目設定，草稿不會被清除', async () => {
    const onManageSubjects = vi.fn();
    render(<ExamCreateWizard lists={[]} onDone={() => {}} onCancel={() => {}} onManageSubjects={onManageSubjects} />);

    expect(screen.getByText('還沒有可以加入的科目')).toBeTruthy();
    expect(screen.getByText(/這份段考草稿會保留/)).toBeTruthy();
    expect(screen.getByLabelText('加入科目')).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一步：加入各科範圍' })).toBeDisabled();
    await click(screen.getByRole('button', { name: '到設定新增科目' }));
    expect(onManageSubjects).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('examWizardDraft:v1')).not.toBeNull();
  });

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

  it('三種安排直接說明建立後會出現在哪裡，避免把只記錄範圍誤認成每日排程', async () => {
    localStorage.setItem('examWizardDraft:v1', JSON.stringify({
      step: 2, name: '第二次段考', start: '2099-09-20', end: '2099-10-02', level: 'progress',
      subjects: [{ listId: 1, examDate: '' }],
      scope: { 1: { items: {}, manual: [{ label: '講義第三章', est: 60 }] } },
    }));
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);

    expect(await screen.findByText('幫我切成幾段完成範圍')).toBeTruthy();
    expect(screen.getAllByText(/不建立每日待辦/).length).toBeGreaterThan(0);
    expect(screen.getByText(/出現在每日待辦，但不指定幾點/)).toBeTruthy();
    expect(screen.getByText(/排出起訖時間，顯示在行事曆/)).toBeTruthy();
    expect(screen.getByLabelText('建立結果摘要')).toHaveTextContent('切成連續的日期區間');
    expect(screen.getByText('9/20–10/2 · 數學')).toBeTruthy();

    await click(screen.getAllByRole('radio')[1]);
    expect(screen.getByLabelText('建立結果摘要')).toHaveTextContent('建立每天要完成的待辦');

    await click(screen.getAllByRole('radio')[2]);
    expect(screen.getByLabelText('建立結果摘要')).toHaveTextContent('建立有起訖時間的每日安排');
  });

  it('只記錄範圍的預覽失敗時，不會誤稱為「每天安排」失敗', async () => {
    localStorage.setItem('examWizardDraft:v1', JSON.stringify({
      step: 2, name: '第二次段考', start: '2099-09-20', end: '2099-10-02', level: 'progress',
      subjects: [{ listId: 1, examDate: '' }],
      scope: { 1: { items: {}, manual: [{ label: '講義第三章', est: null }] } },
    }));
    api.mockImplementation((path, opts) => {
      calls.push([path, opts]);
      if (path === '/exam-plans/preview') return Promise.reject(new Error('暫時無法取得最新範圍'));
      return Promise.resolve({});
    });

    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText('還不能建立段考計畫')).toBeTruthy();
    expect(screen.queryByText('還不能建立每天安排')).toBeNull();
    expect(screen.getByText(/預覽失敗：暫時無法取得最新範圍/)).toBeTruthy();
  });

  it('375px 快速連點確認只建立一次，progress 模式不會產生重複段考', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    localStorage.setItem('examWizardDraft:v1', JSON.stringify({
      step: 2, name: '第二次段考', start: '2099-09-20', end: '2099-10-02', level: 'progress',
      subjects: [{ listId: 1, examDate: '' }],
      scope: { 1: { items: {}, manual: [{ label: '講義第三章', est: null }] } },
    }));
    let finishCreate;
    api.mockImplementation((path, opts) => {
      calls.push([path, opts]);
      if (path === '/exam-plans/preview') return Promise.resolve({
        preview_token: 'signed', blocks: [],
        scope: [{ kind: 'manual', subject_list_id: 1, title: '講義第三章', estimated_minutes: null }],
      });
      if (path === '/exam-plans' && opts?.method === 'POST') return new Promise(resolve => { finishCreate = resolve; });
      return Promise.resolve({});
    });
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(<ExamCreateWizard lists={LISTS} onDone={onDone} onCancel={onCancel} />);
    const confirm = await screen.findByRole('button', { name: '確認，建立段考計畫' });
    await waitFor(() => expect(confirm).toBeEnabled());

    await act(async () => { confirm.click(); confirm.click(); });
    expect(posted('/exam-plans')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '正在建立段考計畫…' })).toBeDisabled();
    // atomic 建立尚未回來時，返回／關閉都必須同步鎖住；否則可重開同一份草稿再送一次。
    expect(screen.getByRole('button', { name: /上一步/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '稍後繼續' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '稍後繼續' }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(posted('/exam-plans')).toHaveLength(1);

    await act(async () => finishCreate({ plan: { id: 99 } }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('建立前預覽失效時自動取得最新預覽，但不會自行再次建立', async () => {
    localStorage.setItem('examWizardDraft:v1', JSON.stringify({
      step: 2, name: '第二次段考', start: '2099-09-20', end: '2099-10-02', level: 'progress',
      subjects: [{ listId: 1, examDate: '' }],
      scope: { 1: { items: {}, manual: [{ label: '講義第三章', est: null }] } },
    }));
    let previewNo = 0;
    api.mockImplementation((path, opts) => {
      calls.push([path, opts]);
      if (path === '/exam-plans/preview') return Promise.resolve({
        preview_token: `signed-${++previewNo}`, blocks: [],
        scope: [{ kind: 'manual', subject_list_id: 1, title: '講義第三章', estimated_minutes: null }],
      });
      if (path === '/exam-plans' && opts?.method === 'POST') {
        const stale = new Error('stale');
        stale.status = 409;
        stale.payload = { code: 'EXAM_PREVIEW_STALE' };
        return Promise.reject(stale);
      }
      return Promise.resolve({});
    });

    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    const confirm = await screen.findByRole('button', { name: '確認，建立段考計畫' });
    await waitFor(() => expect(confirm).toBeEnabled());
    await click(confirm);

    expect(await screen.findByRole('alert')).toHaveTextContent('已為你重新預覽');
    expect(posted('/exam-plans/preview')).toHaveLength(2);
    expect(posted('/exam-plans')).toHaveLength(1);
    expect(posted('/exam-plans/preview').at(-1)[1].body).toEqual(posted('/exam-plans/preview')[0][1].body);
    expect(screen.getByRole('button', { name: '確認，建立段考計畫' })).toBeEnabled();
  });

  it('375px：產生預覽時明說尚未建立，不能把預覽誤認成正在建立計畫', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    let finishPreview;
    api.mockImplementation((path, opts) => {
      calls.push([path, opts]);
      if (path === '/exam-plans/preview') return new Promise(resolve => { finishPreview = resolve; });
      if (path === '/exam-plans' && opts?.method === 'POST') return Promise.resolve({ plan: { id: 99 } });
      return Promise.resolve({});
    });
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('段考名稱'), { target: { value: '第二次段考' } });
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-02' } });
    fireEvent.change(screen.getByLabelText('加入科目'), { target: { value: '1' } });
    await click(screen.getByText('下一步：加入各科範圍'));
    await click(screen.getByText('＋ 老師指定、教材庫沒有的範圍'));
    fireEvent.change(screen.getByLabelText('老師指定範圍'), { target: { value: '講義第三章' } });
    await click(screen.getByText('加入'));
    await click(screen.getByText('下一步：選擇怎麼安排'));

    expect(await screen.findByRole('status')).toHaveTextContent('還沒有建立計畫');
    expect(screen.getByRole('button', { name: '正在產生預覽…' })).toBeDisabled();
    expect(posted('/exam-plans')).toHaveLength(0);

    await act(async () => finishPreview({ preview_token: 'signed', blocks: [], scope: [
      { kind: 'manual', subject_list_id: 1, title: '講義第三章', estimated_minutes: null },
    ] }));
    expect(await screen.findByRole('button', { name: '確認，建立段考計畫' })).toBeEnabled();
    expect(screen.queryByText('正在準備安排預覽…')).toBeNull();
  });

  it('375px 多科時，安排預覽逐項顯示科目與完整時段', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    localStorage.setItem('examWizardDraft:v1', JSON.stringify({
      step: 2, name: '第二次段考', start: '2099-09-20', end: '2099-10-02', level: 'timed',
      subjects: [{ listId: 1, examDate: '' }, { listId: 2, examDate: '' }],
      scope: {
        1: { items: {}, manual: [{ label: '數學講義', est: 60 }] },
        2: { items: {}, manual: [{ label: '物理講義', est: 45 }] },
      },
    }));
    api.mockImplementation((path, opts) => {
      calls.push([path, opts]);
      if (path === '/exam-plans/preview') return Promise.resolve({
        preview_token: 'signed',
        scope: [
          { kind: 'manual', subject_list_id: 1, title: '數學講義', estimated_minutes: 60 },
          { kind: 'manual', subject_list_id: 2, title: '物理講義', estimated_minutes: 45 },
        ],
        blocks: [
          { subject_id: 1, date: '2099-09-21', start_time: '19:00', end_time: '20:00', title: '數學講義' },
          { subject_id: 2, date: '2099-09-21', start_time: '20:00', end_time: '20:45', title: '物理講義' },
        ],
      });
      return Promise.resolve({});
    });

    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText(/9\/21 · 2 項/)).toBeTruthy();
    expect(screen.getAllByText('數學').length).toBeGreaterThan(0);
    expect(screen.getAllByText('物理').length).toBeGreaterThan(0);
    expect(screen.getByText('19:00–20:00')).toBeTruthy();
    expect(screen.getByText('20:00–20:45')).toBeTruthy();
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

  it('稍後繼續：不建立 Plan、保留草稿，重開回到原本內容', async () => {
    const onCancel = vi.fn();
    const first = render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={onCancel} />);
    fireEvent.change(screen.getByLabelText('段考名稱'), { target: { value: '第二次段考' } });
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-02' } });
    fireEvent.change(screen.getByLabelText('加入科目'), { target: { value: '1' } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('examWizardDraft:v1')).name).toBe('第二次段考'));
    await click(screen.getByRole('button', { name: /^稍後繼續$/ }));
    expect(onCancel).toHaveBeenCalled();
    expect(posted('/exam-plans').length).toBe(0);
    expect(posted('/plans').length).toBe(0);
    expect(localStorage.getItem('examWizardDraft:v1')).not.toBeNull();

    first.unmount();
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText('段考名稱')).toHaveValue('第二次段考');
    expect(screen.getByLabelText('段考結束日期')).toHaveValue('2099-10-02');
    expect(screen.getByText('數學')).toBeInTheDocument();
  });

  it('草稿中的科目已被刪除時不送預覽，先帶回第一步安全移除', async () => {
    localStorage.setItem('examWizardDraft:v1', JSON.stringify({
      step: 2, name: '第二次段考', start: '2099-09-20', end: '2099-10-02', level: 'progress',
      subjects: [{ listId: 999, examDate: '' }],
      scope: { 999: { items: {}, manual: [{ label: '舊講義範圍', est: 60 }] } },
    }));
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);

    expect(await screen.findByText(/草稿中的科目已不存在/)).toBeTruthy();
    expect(posted('/exam-plans/preview')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '確認，建立段考計畫' })).toBeDisabled();

    await click(screen.getByRole('button', { name: '回第一步移除失效科目' }));
    expect(screen.getByText('已刪除的科目')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下一步：加入各科範圍' })).toBeDisabled();
    await click(screen.getByRole('button', { name: '移除 已刪除的科目' }));
    expect(screen.getByRole('status')).toHaveTextContent('請至少加入一個考試科目');
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

  it('375px 單科考試日：預設真正沿用最後一天，自訂後可改回沿用', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('段考名稱'), { target: { value: '第二次段考' } });
    fireEvent.change(screen.getByLabelText('開始日期'), { target: { value: '2099-09-20' } });
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-02' } });
    fireEvent.change(screen.getByLabelText('加入科目'), { target: { value: '1' } });

    const examDate = screen.getByLabelText('數學 考試日');
    expect(examDate).toHaveValue('2099-10-02');
    expect(screen.getByText('沿用整個段考最後一天（10/2）')).toBeTruthy();

    // 總日期變更時，未自訂的單科日期必須跟著變，不能停在舊值。
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-05' } });
    expect(examDate).toHaveValue('2099-10-05');

    fireEvent.change(examDate, { target: { value: '2099-10-03' } });
    expect(screen.getByText('已自訂單科考試日。')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-06' } });
    expect(examDate).toHaveValue('2099-10-03');

    await click(screen.getByText('改回沿用最後一天'));
    expect(examDate).toHaveValue('2099-10-06');
  });

  it('單科考試日早於準備開始日時，不能進入下一步', () => {
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('段考名稱'), { target: { value: '第二次段考' } });
    fireEvent.change(screen.getByLabelText('開始日期'), { target: { value: '2099-09-20' } });
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-02' } });
    fireEvent.change(screen.getByLabelText('加入科目'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('數學 考試日'), { target: { value: '2099-09-19' } });
    expect(screen.getByText('下一步：加入各科範圍').closest('button').disabled).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('數學的考試日必須在準備開始日到段考最後一天之間');
  });

  it('375px 日期填反時會說明原因，不只是無聲停用下一步', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    render(<ExamCreateWizard lists={LISTS} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('段考名稱'), { target: { value: '第二次段考' } });
    fireEvent.change(screen.getByLabelText('開始日期'), { target: { value: '2099-10-03' } });
    fireEvent.change(screen.getByLabelText('段考結束日期'), { target: { value: '2099-10-02' } });
    expect(screen.getByText('下一步：加入各科範圍').closest('button').disabled).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('段考最後一天不能早於準備開始日');
  });
});
