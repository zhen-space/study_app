import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
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
  beforeEach(() => { api.mockReset(); props.reload.mockReset(); });

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
