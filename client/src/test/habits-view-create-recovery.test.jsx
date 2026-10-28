import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const HabitsView = (await import('../tt/HabitsView')).default;

const createCalls = () => api.mock.calls.filter(([path, o]) => path === '/habits' && o?.method === 'POST');
const nameInput = () => screen.getByPlaceholderText('＋ 新增習慣（如：背 10 個單字）');
const catInput = () => screen.getByPlaceholderText('輸入新分類或選現有（可留空）');
const submit = () => fireEvent.submit(nameInput().closest('form'));

function mount(reload = vi.fn().mockResolvedValue(undefined)) {
  render(<HabitsView habits={[]} reload={reload} />);
  return reload;
}

describe('習慣頁新增習慣的 IME／防重／寫入／刷新邊界', () => {
  beforeEach(() => {
    api.mockReset();
    api.mockResolvedValue({ id: 31 });
  });

  it('新增成功：送出一次、清空名稱、整包重新載入、不顯示錯誤', async () => {
    const reload = mount();

    fireEvent.change(nameInput(), { target: { value: '  背單字  ' } });
    fireEvent.change(catInput(), { target: { value: ' 英文 ' } });
    await act(async () => { submit(); });

    expect(createCalls()).toEqual([['/habits', {
      method: 'POST', body: { name: '背單字', icon: '⭐', miss_policy: 'drop', category: '英文' },
    }]]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith();
    expect(nameInput()).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增' })).not.toBeDisabled();
  });

  it('只有空白的名稱不送出', async () => {
    const reload = mount();

    fireEvent.change(nameInput(), { target: { value: '   ' } });
    await act(async () => { submit(); });

    expect(createCalls()).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it('中文輸入法組字中按 Enter 選字不送出，組字完成後才以完整名稱建立', async () => {
    mount();
    const input = nameInput();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'ㄅㄟˋ' } });
    // 組字中的 Enter 要被擋下，不能觸發表單隱式送出
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false);
    await act(async () => { submit(); });
    expect(createCalls()).toHaveLength(0);

    fireEvent.compositionEnd(input, { target: { value: '背單字' } });
    expect(input).toHaveValue('背單字');
    // 組字結束後的一般 Enter 不擋，交給表單送出
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    await act(async () => { submit(); });
    expect(createCalls().map(([, o]) => o.body.name)).toEqual(['背單字']);
  });

  it('Safari 先結束組字才送出 keyCode 229 的 Enter，也不能被當成送出', () => {
    mount();

    expect(fireEvent.keyDown(nameInput(), { key: 'Enter', keyCode: 229 })).toBe(false);
    expect(fireEvent.keyDown(catInput(), { key: 'Enter', keyCode: 229 })).toBe(false);
  });

  it('在分類欄組字時按 Enter 也不會送出新增', async () => {
    mount();
    fireEvent.change(nameInput(), { target: { value: '跑步' } });

    fireEvent.compositionStart(catInput());
    expect(fireEvent.keyDown(catInput(), { key: 'Enter', isComposing: true })).toBe(false);
    await act(async () => { submit(); });
    expect(createCalls()).toHaveLength(0);

    fireEvent.compositionEnd(catInput(), { target: { value: '運動' } });
    await act(async () => { submit(); });
    expect(createCalls().map(([, o]) => o.body)).toEqual([
      { name: '跑步', icon: '⭐', miss_policy: 'drop', category: '運動' },
    ]);
  });

  it('寫入或刷新尚未結束前，連點／重入送出都不會建立第二筆', async () => {
    let resolveWrite;
    let reentered = false;
    api.mockImplementation(() => {
      // 同一個事件循環內再送一次：此時 React 還沒重繪，只能靠同步鎖擋下
      if (!reentered) { reentered = true; submit(); }
      return new Promise(resolve => { resolveWrite = resolve; });
    });
    let resolveReload;
    const reload = vi.fn(() => new Promise(resolve => { resolveReload = resolve; }));
    mount(reload);

    fireEvent.change(nameInput(), { target: { value: '背單字' } });
    submit();
    expect(createCalls()).toHaveLength(1);
    expect(screen.getByRole('button', { name: '新增中…' })).toBeDisabled();
    expect(nameInput()).toBeDisabled();
    submit();
    fireEvent.click(screen.getByRole('button', { name: '新增中…' }));
    expect(createCalls()).toHaveLength(1);

    await act(async () => { resolveWrite({ id: 31 }); });
    expect(reload).toHaveBeenCalledTimes(1);
    // 寫入完成但刷新還沒回來：仍要擋
    submit();
    expect(createCalls()).toHaveLength(1);

    await act(async () => { resolveReload(); });
    expect(screen.getByRole('button', { name: '新增' })).not.toBeDisabled();
    expect(createCalls()).toHaveLength(1);
  });

  it('寫入失敗時顯示錯誤、保留所有輸入、不刷新，直接再按一次即可重試', async () => {
    api.mockRejectedValueOnce(new Error('網路連線中斷'));
    const reload = mount();
    const [iconSelect, policySelect] = screen.getAllByRole('combobox').filter(el => el.tagName === 'SELECT');

    fireEvent.change(iconSelect, { target: { value: '💧' } });
    fireEvent.change(nameInput(), { target: { value: '喝水' } });
    fireEvent.change(catInput(), { target: { value: '健康' } });
    fireEvent.change(policySelect, { target: { value: 'keep' } });
    await act(async () => { submit(); });

    expect(screen.getByRole('alert')).toHaveTextContent('網路連線中斷');
    expect(reload).not.toHaveBeenCalled();
    expect(nameInput()).toHaveValue('喝水');
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true');
    expect(catInput()).toHaveValue('健康');
    expect(iconSelect).toHaveValue('💧');
    expect(policySelect).toHaveValue('keep');
    expect(screen.getByRole('button', { name: '新增' })).not.toBeDisabled();

    await act(async () => { submit(); });
    const body = { name: '喝水', icon: '💧', miss_policy: 'keep', category: '健康' };
    expect(createCalls().map(([, o]) => o.body)).toEqual([body, body]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(nameInput()).toHaveValue('');
  });

  it('沒有錯誤訊息的寫入失敗退回預設繁中提示', async () => {
    api.mockRejectedValueOnce(new Error(''));
    mount();

    fireEvent.change(nameInput(), { target: { value: '喝水' } });
    await act(async () => { submit(); });

    expect(screen.getByRole('alert')).toHaveTextContent('習慣沒有新增成功，請再試一次。');
  });

  it('已寫入但刷新失敗：不誤報新增失敗、清空已送出名稱，重試只重新載入不重送', async () => {
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error('刷新失敗'))
      .mockResolvedValue(undefined);
    mount(reload);

    fireEvent.change(nameInput(), { target: { value: '背單字' } });
    await act(async () => { submit(); });

    expect(screen.getByRole('alert')).toHaveTextContent('習慣已新增，但畫面暫時無法重新載入。');
    expect(nameInput()).toHaveValue('');
    expect(nameInput()).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('button', { name: '新增' })).not.toBeDisabled();
    // 名稱已清空，再按新增也不會重送同一筆
    await act(async () => { submit(); });
    expect(createCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenLastCalledWith();
    expect(createCalls()).toHaveLength(1);
  });

  it('重試刷新仍失敗時保留提示，且仍不重送新增', async () => {
    const reload = vi.fn().mockRejectedValue(new Error('刷新失敗'));
    mount(reload);

    fireEvent.change(nameInput(), { target: { value: '背單字' } });
    await act(async () => { submit(); });
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('仍然無法重新載入，請稍後再試。'));
    expect(createCalls()).toHaveLength(1);
  });
});
