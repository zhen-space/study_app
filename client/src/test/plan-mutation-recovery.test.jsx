import { act } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const PlanDetailView = (await import('../tt/PlanDetailView')).default;

const plan = { ...fx.plans[0], id: 12, status: 'active' };
const tasks = fx.planTasks.map(task => ({ ...task, plan_id: 12, plan_status: 'active' }));
let handlers;

function error(message, status, payload) {
  const e = new Error(message);
  e.status = status;
  e.payload = payload;
  return e;
}

function mount(reload = vi.fn().mockResolvedValue(undefined)) {
  render(<PlanDetailView
    planKey="plan:12"
    tasks={tasks}
    lists={fx.lists}
    apiPlans={[plan]}
    reload={reload}
    onBack={vi.fn()}
    goWizard={vi.fn()}
    adjustPlan={vi.fn()}
  />);
  return reload;
}

async function click(element) {
  await act(async () => { fireEvent.click(element); });
}

async function openPause() {
  await click(screen.getByRole('button', { name: '計畫選項' }));
  await click(screen.getByText('暫停計畫'));
  await click(screen.getByLabelText('保留未完成的任務'));
  return screen.getByRole('button', { name: '暫停計畫' });
}

describe('Plan mutation recovery', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    handlers = {};
    api.mockImplementation((path, options = {}) => {
      if (handlers[path]) return handlers[path](options);
      if (path === '/material/books') return Promise.resolve([]);
      if (path.endsWith('/exam')) return Promise.resolve({ subjects: [], material: [], manual_scope: [] });
      if (path.includes('/health')) return Promise.resolve({ status: 'healthy', reasons: [] });
      if (path.startsWith('/schedule/')) return Promise.resolve({ blocks: [] });
      return Promise.resolve({});
    });
  });

  it('keeps a real lifecycle API failure retryable without claiming it was saved', async () => {
    handlers['/plans/12/pause'] = vi.fn()
      .mockRejectedValueOnce(error('暫停失敗', 503))
      .mockResolvedValueOnce({ plan: { ...plan, status: 'paused' } });
    const reload = mount();
    const pause = await openPause();

    await click(pause);
    expect(await screen.findByText('暫停失敗')).toBeInTheDocument();
    expect(screen.queryByText(/變更已儲存/)).not.toBeInTheDocument();
    expect(pause).toBeEnabled();
    await click(pause);

    expect(handlers['/plans/12/pause']).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps the 375px lifecycle confirmation visible while pause is pending', async () => {
    let rejectPause;
    handlers['/plans/12/pause'] = vi.fn().mockImplementation(() => new Promise((resolve, reject) => {
      rejectPause = reject;
    }));
    mount();
    const pause = await openPause();

    fireEvent.click(pause);
    const dialog = screen.getByRole('dialog', { name: '暫停這個計畫' });
    await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'true'));
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.click(document.querySelector('.sheet-backdrop'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: '暫停中…' }));
    expect(screen.getByRole('dialog', { name: '暫停這個計畫' })).toBeInTheDocument();
    expect(handlers['/plans/12/pause']).toHaveBeenCalledOnce();

    await act(async () => { rejectPause(error('暫停失敗', 503)); });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('暫停失敗');
    expect(screen.getByRole('button', { name: '暫停計畫' })).toBeEnabled();
  });

  it('locks stale Plan mutations after commit succeeds but refresh fails', async () => {
    handlers['/plans/12/pause'] = vi.fn().mockResolvedValue({ plan: { ...plan, status: 'paused' } });
    const reload = mount(vi.fn().mockRejectedValue(new Error('離線')));
    const pause = await openPause();

    await click(pause);
    expect(await screen.findByText('變更已儲存，但畫面暫時無法更新')).toBeInTheDocument();
    expect(screen.getByText(/避免重複新增任務或重送計畫動作/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '計畫選項' })).not.toBeInTheDocument();
    expect(handlers['/plans/12/pause']).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('retries only the safe refresh and restores the Plan view', async () => {
    handlers['/plans/12/pause'] = vi.fn().mockResolvedValue({ plan: { ...plan, status: 'paused' } });
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error('離線'))
      .mockResolvedValueOnce(undefined);
    mount(reload);
    await click(await openPause());

    await click(await screen.findByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '計畫選項' })).toBeInTheDocument());
    expect(handlers['/plans/12/pause']).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not treat the end confirmation response as a committed mutation', async () => {
    handlers['/plans/12/end'] = vi.fn().mockRejectedValue(error(
      '需要確認', 409,
      { code: 'end_confirmation_required', unresolved: [{ id: 1 }] },
    ));
    const reload = mount(vi.fn().mockRejectedValue(new Error('不該呼叫')));
    await click(screen.getByRole('button', { name: '計畫選項' }));
    await click(screen.getByText('結束計畫'));

    const sheet = document.querySelector('.sheet-panel');
    expect(await within(sheet).findByText(/還有 1 項未完成/)).toBeInTheDocument();
    expect(screen.queryByText(/變更已儲存/)).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('synchronously prevents a re-entrant non-idempotent Task create', async () => {
    let resolveCreate;
    let addButton;
    let nested = false;
    handlers['/tasks'] = vi.fn().mockImplementation(() => {
      if (!nested) {
        nested = true;
        fireEvent.click(addButton);
      }
      return new Promise(resolve => { resolveCreate = resolve; });
    });
    mount();
    await click(screen.getByRole('button', { name: '新增任務' }));
    fireEvent.change(screen.getByLabelText('任務名稱'), { target: { value: '複習第三課' } });
    addButton = screen.getByRole('button', { name: '新增' });
    fireEvent.click(addButton);

    expect(handlers['/tasks']).toHaveBeenCalledOnce();
    expect(handlers['/tasks']).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', body: expect.objectContaining({ title: '複習第三課', plan_id: 12 }),
    }));
    resolveCreate({ id: 99 });
    await waitFor(() => expect(screen.queryByLabelText('任務名稱')).not.toBeInTheDocument());
  });

  it('does not offer a duplicate Task create after the Task saved but refresh failed', async () => {
    handlers['/tasks'] = vi.fn().mockResolvedValue({ id: 99 });
    mount(vi.fn().mockRejectedValue(new Error('離線')));
    await click(screen.getByRole('button', { name: '新增任務' }));
    fireEvent.change(screen.getByLabelText('任務名稱'), { target: { value: '複習第三課' } });
    await click(screen.getByRole('button', { name: '新增' }));

    expect(await screen.findByText('變更已儲存，但畫面暫時無法更新')).toBeInTheDocument();
    expect(screen.queryByLabelText('任務名稱')).not.toBeInTheDocument();
    expect(handlers['/tasks']).toHaveBeenCalledOnce();
  });
});
