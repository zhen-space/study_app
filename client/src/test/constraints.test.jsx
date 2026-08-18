import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const ConstraintSheet = (await import('../tt/ConstraintSheet')).default;

const click = el => act(async () => { el.click(); });
const type = (el, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('Master C：AI constraint 確認層', () => {
  beforeEach(() => { api.mockReset(); });

  it('AI 結果必須先顯示 supported／unsupported，確認時只送支援欄位', async () => {
    const close = vi.fn();
    api.mockImplementation((path, opts) => {
      if (path === '/plans/12/constraints' && !opts) return Promise.resolve({ intent: {}, unsupported: [] });
      if (path === '/plans/12/constraints/parse') return Promise.resolve({
        supported: { deadline: '2099-01-20', max_per_day: 2 },
        unsupported: [{ key: 'strict_dependency', reason: '目前排程器尚未安全支援此條件' }],
      });
      if (path === '/plans/12/constraints' && opts?.method === 'PUT') return Promise.resolve({ confirmed: true });
      return Promise.resolve({});
    });
    render(<ConstraintSheet planId={12} onClose={close} />);
    const source = await screen.findByLabelText('排程條件');
    await type(source, '數學要在英文前完成');
    await click(screen.getByRole('button', { name: '請 AI 解讀' }));
    expect(await screen.findByText(/deadline/)).toBeInTheDocument();
    expect(screen.getByText(/strict_dependency/)).toBeInTheDocument();
    await click(screen.getByRole('button', { name: '確認套用已支援條件' }));
    const put = api.mock.calls.find(([path, opts]) => path === '/plans/12/constraints' && opts?.method === 'PUT');
    expect(put[1].body.intent).toEqual({ deadline: '2099-01-20', max_per_day: 2 });
    expect(close).toHaveBeenCalledOnce();
  });
});
