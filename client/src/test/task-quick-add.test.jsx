import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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
});
