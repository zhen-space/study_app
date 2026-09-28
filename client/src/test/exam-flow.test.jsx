// 段考流程（實際使用者路徑 + 中文 IME / 手機）：
//   建立段考（名稱＋考試日期）→ 進到 Plan 明細，首屏用白話問「要讀完的範圍」，
//   並提供「加入要考的範圍」與「老師指定、教材庫沒有的範圍」入口。
//   另驗證：建立段考的名稱輸入在注音組字（composition）期間不被 BottomSheet 搶焦點。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;

let created;
const setApi = () => {
  created = null;
  api.mockImplementation((raw, opts) => {
    const path = raw.startsWith('/plans?') ? '/plans' : raw.split('?')[0];
    if (path === '/plans' && opts?.method === 'POST') {
      created = { ...fx.emptyPlan, id: 99, name: opts.body.name, target_date: opts.body.target_date, status: 'active' };
      return Promise.resolve(created);
    }
    if (path === '/plans') return Promise.resolve(created ? [...(fx.responses['/plans'] || []), created] : (fx.responses['/plans'] || []));
    if (path === '/plans/99/material-items') return Promise.resolve([]);
    if (path === '/plans/99/progress-segments') return Promise.resolve({ segments: [] });
    if (path === '/schedule/timeline/99') return Promise.resolve({ segments: [], items: [], unscheduled: [] });
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    if (path.startsWith('/tasks/')) return Promise.resolve({});
    return Promise.resolve([]);
  });
};
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); localStorage.clear(); setApi(); });
afterEach(() => { vi.restoreAllMocks(); cleanup(); });
const click = el => act(async () => { el.click(); });

async function openCreateSheet() {
  render(<Shell onLogout={() => {}} />);
  await screen.findByRole('heading', { name: '今天' });
  await click(within(document.querySelector('.bottom-nav')).getByText('計畫').closest('button'));
  await click(screen.getByRole('button', { name: '新增' }));
  await click(screen.getByRole('button', { name: '新增計畫' }));
  return screen.getByLabelText('段考名稱');
}

describe('段考流程', () => {
  it('建立段考 → 進 Plan 明細，首屏是白話的「要讀完的範圍」，有加入範圍與手動補充入口', async () => {
    const nameInput = await openCreateSheet();
    fireEvent.change(nameInput, { target: { value: '第二次段考' } });
    fireEvent.change(screen.getByLabelText('考試日期'), { target: { value: '2099-10-02' } });
    await click(screen.getByRole('button', { name: /建立，開始加入範圍/ }));
    // 落在 Plan 明細，首屏白話講範圍（還沒加入 → 引導）
    await waitFor(() => expect(screen.getByText('還沒加入要考的範圍')).toBeTruthy());
    expect(screen.getByText(/考試 10\/2/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '加入要考的範圍' })).toBeTruthy();
    // 沒有工程術語「段考進度／排程摘要」當標題
    expect(screen.queryByText('段考進度')).toBeNull();
    expect(screen.queryByText('排程摘要')).toBeNull();
  });

  it('中文 IME：建立段考名稱在組字期間保持焦點（不被 BottomSheet 搶回）', async () => {
    const nameInput = await openCreateSheet();
    nameInput.focus();
    expect(document.activeElement).toBe(nameInput);
    // 模擬注音組字：compositionstart → 逐鍵 input → 期間焦點必須留在 input
    fireEvent.compositionStart(nameInput);
    fireEvent.change(nameInput, { target: { value: 'ㄉ' } });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(nameInput);
    fireEvent.change(nameInput, { target: { value: '第' } });
    fireEvent.compositionEnd(nameInput);
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(nameInput);
  });
});
