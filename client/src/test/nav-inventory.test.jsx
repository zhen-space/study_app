// 導航回歸盤點：釘住桌面側欄、手機底部導航與任務分頁的入口存在性，
// 避免既有功能再次「有頁面卻無入口」地靜默消失。見 docs/導航盤點.md。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;

const setApi = () => api.mockImplementation((raw) => {
  const path = raw.startsWith('/plans?') ? '/plans' : raw;
  if (path in fx.responses) return Promise.resolve(fx.responses[path]);
  if (path.startsWith('/tasks/')) return Promise.resolve({});
  return Promise.resolve([]);
});
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); localStorage.clear(); setApi(); });
afterEach(() => vi.restoreAllMocks());
const click = el => act(async () => { el.click(); });

async function mountShell() {
  render(<Shell onLogout={() => {}} />);
  await screen.findByRole('heading', { name: '今天' });
}

describe('導航盤點', () => {
  it('桌面側欄含主導航與各次要頁入口', async () => {
    await mountShell();
    const side = document.querySelector('.sidebar');
    for (const label of ['今天', '計畫', '讀書', '任務', '行事曆', '目標', '教材庫', '學校作業', '統計', '單字本', '備忘錄', '習慣', '寵物', '設定']) {
      expect(within(side).getByText(label), `側欄應有「${label}」`).toBeTruthy();
    }
  });

  it('手機底部導航含 5 個主入口', async () => {
    await mountShell();
    const nav = document.querySelector('.bottom-nav');
    expect(within(nav).getByText('今天')).toBeTruthy();
    expect(within(nav).getByText('計畫')).toBeTruthy();
    expect(within(nav).getByLabelText('開始讀書')).toBeTruthy();
    expect(within(nav).getByText('任務')).toBeTruthy();
    expect(within(nav).getByText('行事曆')).toBeTruthy();
  });

  it('任務頁分頁列含 學校作業／已完成／垃圾桶', async () => {
    await mountShell();
    const nav = document.querySelector('.bottom-nav');
    await click(within(nav).getByText('任務').closest('button'));
    await screen.findByRole('tablist', { name: '任務視圖' });
    const tabs = screen.getByRole('tablist', { name: '任務視圖' });
    for (const label of ['學校作業', '已完成', '垃圾桶']) {
      expect(within(tabs).getByText(label)).toBeTruthy();
    }
  });
});
