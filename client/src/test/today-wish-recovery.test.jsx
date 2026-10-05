import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Tasks = (await import('../tt/Tasks')).default;

function mount(reload = vi.fn().mockResolvedValue(undefined)) {
  render(<Tasks view={{ type: 'today' }} tasks={[]} lists={[]} filters={[]}
    habits={[]} reload={reload} title="今天" />);
  return reload;
}

describe('375px Today 願望新增 recovery', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    api.mockReset();
    api.mockResolvedValue([]);
  });

  it('同步防止快速重送，POST 成功後刷新失敗只重試 reload', async () => {
    let resolveCreate;
    let form;
    let reentered = false;
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks' && options.method === 'POST') {
        if (!reentered) {
          reentered = true;
          fireEvent.submit(form);
        }
        return new Promise(resolve => { resolveCreate = resolve; });
      }
      return Promise.resolve([]);
    });
    const reload = vi.fn().mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce(undefined);
    mount(reload);
    const input = screen.getByPlaceholderText('＋ 記一件想做的事…');
    form = input.closest('form');
    fireEvent.change(input, { target: { value: '買新的英文講義' } });

    fireEvent.submit(form);
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(1);
    expect(input).toBeDisabled();
    await act(async () => { resolveCreate({ id: 88 }); });

    expect(await screen.findByRole('alert')).toHaveTextContent('願望已新增，但畫面暫時無法重新載入');
    expect(screen.getByPlaceholderText('＋ 記一件想做的事…')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重新載入' })).not.toBeInTheDocument());
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(1);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('真正 POST 失敗保留輸入與錯誤，允許原內容重試', async () => {
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks' && options.method === 'POST') {
        return api.mock.calls.filter(([p, o]) => p === '/tasks' && o?.method === 'POST').length === 1
          ? Promise.reject(new Error('新增暫時失敗'))
          : Promise.resolve({ id: 89 });
      }
      return Promise.resolve([]);
    });
    const reload = mount();
    const input = screen.getByPlaceholderText('＋ 記一件想做的事…');
    const form = input.closest('form');
    fireEvent.change(input, { target: { value: '複習化學' } });

    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent('新增暫時失敗');
    expect(input).toHaveValue('複習化學');
    expect(input).toBeEnabled();
    expect(reload).not.toHaveBeenCalled();

    fireEvent.submit(form);
    await waitFor(() => expect(input).toHaveValue(''));
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('中文輸入法組字期間送出不會建立半成品願望', async () => {
    mount();
    const input = screen.getByPlaceholderText('＋ 記一件想做的事…');
    const form = input.closest('form');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '複' } });
    fireEvent.submit(form);
    expect(api.mock.calls.filter(([path]) => path === '/tasks')).toHaveLength(0);
    expect(input).toHaveValue('複');

    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: '複習國文' } });
    fireEvent.submit(form);
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === '/tasks')).toHaveLength(1));
    expect(api).toHaveBeenCalledWith('/tasks', { method: 'POST', body: { title: '複習國文' } });
  });
});
