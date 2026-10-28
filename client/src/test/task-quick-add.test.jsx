import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

const props = {
  view: { type: 'tasks' }, tasks: [], lists: fx.lists, filters: [], reload: vi.fn(),
  title: '任務', onNav: vi.fn(),
};

describe('任務快速新增', () => {
  beforeEach(() => { api.mockReset(); props.reload.mockReset(); localStorage.removeItem('token'); });

  it('中文輸入法按 Enter 選字時不送出，組字完成後才建立', async () => {
    api.mockResolvedValue({ id: 99 });
    render(<Tasks {...props} />);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'ㄨ' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    await act(async () => { fireEvent.submit(input.closest('form')); });
    expect(api).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { data: '物理' });
    fireEvent.change(input, { target: { value: '物理作業' } });
    await act(async () => { fireEvent.submit(input.closest('form')); });
    expect(api).toHaveBeenCalledWith('/tasks', { method: 'POST', body: { title: '物理作業' } });
    expect(input).toHaveValue('');
  });

  it('輸入標題後可直接加日期、科目、優先級與標籤，成功後重設選項', async () => {
    api.mockResolvedValue({ id: 102 });
    props.reload.mockResolvedValue();
    render(<Tasks {...props} tasks={[{
      id: 8, title: '既有任務', tags: ['複習'], list_id: fx.lists[0].id,
      completed: false, deleted: false, due_date: '2099-01-01', due_time: null,
      priority: 0, subtasks: [], notes: '',
    }]} />);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');

    fireEvent.change(input, { target: { value: '準備數學小考' } });
    expect(screen.getByLabelText('快速新增選項')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '明天' }));
    fireEvent.change(screen.getByLabelText('快速新增科目'), { target: { value: String(fx.lists[0].id) } });
    fireEvent.change(screen.getByLabelText('快速新增優先級'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('快速新增標籤'), { target: { value: '複習' } });

    await act(async () => { fireEvent.submit(input.closest('form')); });

    expect(api).toHaveBeenCalledWith('/tasks', {
      method: 'POST',
      body: { title: '準備數學小考', due_date: expect.any(String), list_id: fx.lists[0].id, priority: 3, tags: ['複習'] },
    });
    expect(input).toHaveValue('');
    expect(screen.queryByLabelText('快速新增選項')).not.toBeInTheDocument();
  });

  it('可直接建立重複任務，未選日期時自動從今天起算', async () => {
    api.mockResolvedValue({ id: 103 });
    props.reload.mockResolvedValue();
    render(<Tasks {...props} />);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');

    fireEvent.change(input, { target: { value: '每週整理筆記' } });
    fireEvent.change(screen.getByLabelText('快速新增重複規則'), { target: { value: 'weekly' } });
    await act(async () => { fireEvent.submit(input.closest('form')); });

    expect(api).toHaveBeenCalledWith('/tasks', {
      method: 'POST',
      body: { title: '每週整理筆記', recurring: 'weekly', due_date: expect.any(String) },
    });
    expect(input).toHaveValue('');
    expect(screen.queryByLabelText('快速新增選項')).not.toBeInTheDocument();
  });

  it('沒有既有標籤時也能在快速新增直接建立新標籤', async () => {
    api.mockResolvedValue({ id: 105 });
    props.reload.mockResolvedValue();
    render(<Tasks {...props} />);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');

    fireEvent.change(input, { target: { value: '整理化學錯題' } });
    fireEvent.change(screen.getByLabelText('快速新增標籤'), { target: { value: ' 錯題 ' } });
    await act(async () => { fireEvent.submit(input.closest('form')); });

    expect(api).toHaveBeenCalledWith('/tasks', {
      method: 'POST',
      body: { title: '整理化學錯題', tags: ['錯題'] },
    });
    expect(input).toHaveValue('');
  });

  it('可在快速新增直接附上備註', async () => {
    api.mockResolvedValue({ id: 106 });
    props.reload.mockResolvedValue();
    render(<Tasks {...props} />);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');

    fireEvent.change(input, { target: { value: '準備英文報告' } });
    fireEvent.change(screen.getByLabelText('快速新增備註'), { target: { value: ' 帶講義第 3 頁 ' } });
    await act(async () => { fireEvent.submit(input.closest('form')); });

    expect(api).toHaveBeenCalledWith('/tasks', {
      method: 'POST',
      body: { title: '準備英文報告', notes: '帶講義第 3 頁' },
    });
    expect(screen.queryByLabelText('快速新增選項')).not.toBeInTheDocument();
  });

  it('可直接設定時間，未選日期時自動排在今天', async () => {
    api.mockResolvedValue({ id: 104 });
    props.reload.mockResolvedValue();
    render(<Tasks {...props} />);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');

    fireEvent.change(input, { target: { value: '晚間複習' } });
    fireEvent.change(screen.getByLabelText('快速新增時間'), { target: { value: '20:30' } });
    await act(async () => { fireEvent.submit(input.closest('form')); });

    expect(api).toHaveBeenCalledWith('/tasks', {
      method: 'POST',
      body: { title: '晚間複習', due_time: '20:30', due_date: expect.any(String) },
    });
    expect(input).toHaveValue('');
    expect(screen.queryByLabelText('快速新增選項')).not.toBeInTheDocument();
  });

  it('API 失敗時保留內容並顯示錯誤，可再次編輯重試', async () => {
    api.mockRejectedValueOnce(new Error('暫時無法新增'));
    render(<Tasks {...props} />);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');
    fireEvent.change(input, { target: { value: '國文作文' } });
    await act(async () => { fireEvent.submit(input.closest('form')); });

    expect(await screen.findByRole('alert')).toHaveTextContent('暫時無法新增');
    expect(input).toHaveValue('國文作文');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(props.reload).not.toHaveBeenCalled();
  });

  it('同一輪重入 submit 只建立一筆任務', async () => {
    let form;
    let reentered = false;
    api.mockImplementation(() => {
      if (!reentered) {
        reentered = true;
        fireEvent.submit(form);
      }
      return Promise.resolve({ id: 100 });
    });
    props.reload.mockResolvedValue();
    render(<Tasks {...props} />);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');
    form = input.closest('form');
    fireEvent.change(input, { target: { value: '英文作業' } });

    fireEvent.submit(form);

    await waitFor(() => expect(input).toHaveValue(''));
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(1);
  });

  it('送出中切到別頁、之後 POST 失敗時，回來仍保留內容與錯誤，可直接重送', async () => {
    localStorage.setItem('token', 'session-a');
    let rejectPost;
    api.mockImplementationOnce(() => new Promise((_, reject) => { rejectPost = reject; }));
    const first = render(<Tasks {...props} />);
    fireEvent.change(screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存'), { target: { value: '化學實驗報告' } });
    fireEvent.change(screen.getByLabelText('快速新增優先級'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('快速新增備註'), { target: { value: '附圖表' } });
    fireEvent.submit(screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存').closest('form'));

    // 例如在 Render 冷啟動時切到「今天」或行事曆：Tasks 卸載，請求才失敗。
    first.unmount();
    await act(async () => { rejectPost(new Error('伺服器暫時沒有回應')); });

    api.mockResolvedValueOnce({ id: 107 });
    props.reload.mockResolvedValue();
    // 正式環境包在 StrictMode：開發時的重複初始化／重複掛載也不能把草稿吃掉。
    render(<StrictMode><Tasks {...props} /></StrictMode>);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');
    expect(input).toHaveValue('化學實驗報告');
    expect(input).not.toBeDisabled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('伺服器暫時沒有回應');
    expect(screen.getByLabelText('快速新增優先級')).toHaveValue('3');
    expect(screen.getByLabelText('快速新增備註')).toHaveValue('附圖表');
    expect(props.reload).not.toHaveBeenCalled();

    await act(async () => { fireEvent.submit(input.closest('form')); });
    expect(api).toHaveBeenLastCalledWith('/tasks', {
      method: 'POST', body: { title: '化學實驗報告', priority: 3, notes: '附圖表' },
    });
    expect(input).toHaveValue('');
  });

  it('送出中登出並換另一個帳號登入、之後 POST 失敗時，不把前一位的草稿給新帳號', async () => {
    localStorage.setItem('token', 'session-a');
    let rejectPost;
    api.mockImplementationOnce(() => new Promise((_, reject) => { rejectPost = reject; }));
    const first = render(<Tasks {...props} />);
    fireEvent.change(screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存'), { target: { value: 'A 的私人待辦' } });
    fireEvent.change(screen.getByLabelText('快速新增備註'), { target: { value: 'A 的備註' } });
    fireEvent.submit(screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存').closest('form'));

    // App.jsx 登出只移除 token 並導向 /login，不會重新載入 JS 模組。
    first.unmount();
    localStorage.removeItem('token');
    localStorage.setItem('token', 'session-b');
    await act(async () => { rejectPost(new Error('伺服器暫時沒有回應')); });

    const second = render(<StrictMode><Tasks {...props} /></StrictMode>);
    expect(screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存')).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/A 的/)).toBeNull();
    second.unmount();

    // 不只是對 B 隱藏：草稿已丟棄，A 之後再用同一個 token 回來也不會再冒出來。
    localStorage.setItem('token', 'session-a');
    render(<Tasks {...props} />);
    expect(screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存')).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('送出中切到別頁、之後 POST 成功時，回來不殘留舊內容或錯誤', async () => {
    let resolvePost;
    api.mockImplementationOnce(() => new Promise(resolve => { resolvePost = resolve; }));
    props.reload.mockResolvedValue();
    const first = render(<Tasks {...props} />);
    fireEvent.change(screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存'), { target: { value: '英文單字' } });
    fireEvent.submit(screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存').closest('form'));

    first.unmount();
    await act(async () => { resolvePost({ id: 108 }); });

    render(<Tasks {...props} />);
    expect(screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存')).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(1);
  });

  it('任務已建立但刷新失敗時只提示重新載入，不誤導重送 POST', async () => {
    api.mockResolvedValue({ id: 101 });
    props.reload.mockRejectedValueOnce(new Error('重新整理失敗')).mockResolvedValueOnce();
    render(<Tasks {...props} />);
    const input = screen.getByPlaceholderText('＋ 新增任務，按 Enter 儲存');
    fireEvent.change(input, { target: { value: '國文講義' } });

    await act(async () => { fireEvent.submit(input.closest('form')); });

    expect(input).toHaveValue('');
    expect(await screen.findByRole('alert')).toHaveTextContent('任務已新增，但畫面暫時無法重新載入');
    expect(screen.queryByText('新增任務失敗')).toBeNull();
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(props.reload).toHaveBeenCalledTimes(2);
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(1);
  });
});
