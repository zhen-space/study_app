// Global Add（§A）：全 App 統一新增入口。
// 釘住：固定順序 5 項、第一層不直接進 Quick Task、學校作業/任務走同一顆 ＋、
// Study 等操作頁不顯示 ＋。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;

let calls;
const setApi = (over = {}) => {
  api.mockImplementation((raw, opts) => {
    calls.push([raw, opts]);
    const path = raw.startsWith('/plans?') ? '/plans' : raw;
    if (path in over) { const v = over[path]; return Promise.resolve(typeof v === 'function' ? v(opts) : v); }
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    if (path.startsWith('/tasks/')) return Promise.resolve({});
    return Promise.resolve([]);
  });
};
let errors;
beforeEach(() => { calls = []; errors = []; vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' '))); localStorage.clear(); setApi(); });
afterEach(() => vi.restoreAllMocks());
const click = el => act(async () => { el.click(); });
const bottomNav = () => document.querySelector('.bottom-nav');
async function mountShell() {
  render(<Shell onLogout={() => {}} />);
  await screen.findByRole('heading', { name: '今天' });
  await screen.findByText('買參考書');
}
const fab = () => screen.getByRole('button', { name: '新增' });

describe('Global Add', () => {
  it('右下 ＋ 打開固定順序 5 項，第一層不直接進 Quick Task', async () => {
    await mountShell();
    await click(fab());
    const dlg = screen.getByRole('dialog');
    const items = within(dlg).getAllByRole('button').map(b => b.getAttribute('aria-label')).filter(Boolean);
    expect(items).toEqual(['新增學校作業', '新增任務', '新增計畫', '新增行程', '新增重要日子']);
    // 第一層不應直接出現 Quick Task 的輸入框
    expect(within(dlg).queryByLabelText('任務標題')).toBeNull();
  });

  it('選「任務」→ Quick Task 第二層，送 POST /tasks', async () => {
    await mountShell();
    await click(fab());
    await click(screen.getByRole('button', { name: '新增任務' }));
    const input = await screen.findByLabelText('任務標題');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '買便當'); input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(screen.getByRole('button', { name: '新增任務' }));
    const post = calls.find(([p, o]) => p === '/tasks' && o?.method === 'POST');
    expect(post?.[1]?.body?.title).toBe('買便當');
  });

  it('375px 手機的 Quick Task 可一次填日期、時間、科目、優先級與備註', async () => {
    await mountShell();
    await click(fab());
    await click(screen.getByRole('button', { name: '新增任務' }));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText('任務標題');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '準備物理小考'); input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(within(dialog).getByText('更多選項'));
    await act(async () => {
      const change = (label, value) => {
        const field = within(dialog).getByLabelText(label);
        const proto = field instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype
          : field instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
        field.dispatchEvent(new Event('change', { bubbles: true }));
      };
      change('任務日期', '2030-05-06');
      change('任務時間', '20:30');
      change('任務科目', String(fx.lists[0].id));
      change('任務優先級', '3');
      change('任務備註', '帶講義第 3 頁');
    });
    await click(within(dialog).getByRole('button', { name: '新增任務' }));
    const post = calls.find(([p, o]) => p === '/tasks' && o?.method === 'POST');
    expect(post?.[1]?.body).toEqual({
      title: '準備物理小考', due_date: '2030-05-06', due_time: '20:30',
      list_id: fx.lists[0].id, priority: 3, notes: '帶講義第 3 頁',
    });
  });

  it('選「學校作業」→ 開學校作業表單（同一顆 ＋，不是另一套入口）', async () => {
    await mountShell();
    await click(fab());
    await click(screen.getByRole('button', { name: '新增學校作業' }));
    expect(await screen.findByRole('heading', { name: '新增學校作業' })).toBeInTheDocument();
  });

  it('只在 Today／計畫／任務／行事曆顯示；Study／Wizard／Plan 明細／設定不顯示', async () => {
    await mountShell();
    const side = document.querySelector('.sidebar');
    // 四個瀏覽頁：有 ＋
    expect(fab()).toBeInTheDocument();                                   // Today
    await click(within(bottomNav()).getByText('計畫').closest('button'));
    expect(screen.getByRole('button', { name: '新增' })).toBeInTheDocument();
    await click(within(bottomNav()).getByText('任務').closest('button'));
    expect(screen.getByRole('button', { name: '新增' })).toBeInTheDocument();
    await click(within(bottomNav()).getByText('行事曆').closest('button'));
    expect(screen.getByRole('button', { name: '新增' })).toBeInTheDocument();
    // 操作／表單頁：沒有 ＋
    await click(within(bottomNav()).getByLabelText('開始讀書'));           // Study
    expect(screen.queryByRole('button', { name: '新增' })).toBeNull();
    await click(within(side).getByText('設定'));                          // Settings
    expect(screen.queryByRole('button', { name: '新增' })).toBeNull();
  });

  it('Global Add 不含 開始讀書／匯入課表／Google Calendar', async () => {
    await mountShell();
    await click(fab());
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).queryByText(/開始讀書/)).toBeNull();
    expect(within(dlg).queryByText(/匯入課表/)).toBeNull();
    expect(within(dlg).queryByText(/Google/)).toBeNull();
  });
});
