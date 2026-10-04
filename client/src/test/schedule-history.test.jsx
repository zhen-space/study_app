import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const ScheduleHistoryView = (await import('../tt/ScheduleHistoryView')).default;

const versions = [
  { id: 1, version_no: 1, source: 'initial', reason: '第一版', block_count: 1 },
  { id: 2, version_no: 2, source: 'manual', reason: '第二版', block_count: 1 },
];
const detail = id => ({
  version: versions.find(v => v.id === id),
  blocks: [{ id: id * 10, task_id: id, date: `2030-08-0${id}`, task_title_snapshot: `任務 ${id}` }],
});
const diff = id => ({ is_initial: id === 1, summary: { added: 1 }, items: [] });
const preview = {
  status: 'full',
  source_version: versions[0],
  base_version_id: 2,
  conflicts: [],
  unplaced_task_ids: [],
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  api.mockReset();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
});

function standardApi(overrides = {}) {
  api.mockImplementation(async (path, options) => {
    if (overrides[path]) return overrides[path](options);
    if (path === '/schedule/versions') return versions;
    const detailMatch = path.match(/^\/schedule\/versions\/(\d+)$/);
    if (detailMatch) return detail(Number(detailMatch[1]));
    const diffMatch = path.match(/^\/schedule\/versions\/(\d+)\/diff/);
    if (diffMatch) return diff(Number(diffMatch[1]));
    if (path.endsWith('/restore-preview')) return preview;
    if (options?.method === 'POST' && path.endsWith('/restore')) {
      return { applied: true, version: { version_id: 3 } };
    }
    throw new Error(`unexpected ${path}`);
  });
}

async function selectVersion(version = 1) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`V${version}`) }));
  await screen.findByText(`任務 ${version}`);
}

describe('ScheduleHistory restore recovery', () => {
  it('快速切換版本時只有最後一次請求能更新詳情', async () => {
    const pending = new Map([
      ['/schedule/versions/1', deferred()],
      ['/schedule/versions/1/diff?include_unchanged=0', deferred()],
      ['/schedule/versions/2', deferred()],
      ['/schedule/versions/2/diff?include_unchanged=0', deferred()],
    ]);
    api.mockImplementation(path => path === '/schedule/versions' ? Promise.resolve(versions) : pending.get(path).promise);
    render(<ScheduleHistoryView />);
    fireEvent.click(await screen.findByRole('button', { name: /V1/ }));
    fireEvent.click(screen.getByRole('button', { name: /V2/ }));
    pending.get('/schedule/versions/2').resolve(detail(2));
    pending.get('/schedule/versions/2/diff?include_unchanged=0').resolve(diff(2));
    expect(await screen.findByText('任務 2')).toBeTruthy();
    pending.get('/schedule/versions/1').resolve(detail(1));
    pending.get('/schedule/versions/1/diff?include_unchanged=0').resolve(diff(1));
    await waitFor(() => expect(screen.queryByText('任務 1')).toBeNull());
    expect(screen.getByText('任務 2')).toBeTruthy();
  });

  it('一般 API 失敗在 sheet 內提示、保留 preview，並可直接重試', async () => {
    let attempts = 0;
    standardApi({
      '/schedule/versions/1/restore': async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('暫時無法恢復');
        return { applied: true, version: { version_id: 1 } };
      },
    });
    render(<ScheduleHistoryView />);
    await selectVersion();
    fireEvent.click(screen.getByRole('button', { name: '恢復這個版本' }));
    const dialog = await screen.findByRole('dialog', { name: '恢復排程版本' });
    fireEvent.click(within(dialog).getByRole('button', { name: '確認恢復' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('暫時無法恢復');
    expect(within(dialog).getByText('恢復 V1')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '確認恢復' }));
    await waitFor(() => expect(attempts).toBe(2));
  });

  it('stale preview 不可重送：關閉舊確認並引導重新預覽', async () => {
    let previews = 0;
    standardApi({
      '/schedule/versions/1/restore-preview': async () => { previews += 1; return preview; },
      '/schedule/versions/1/restore': async () => {
        const error = new Error('目前生效的排程已更新');
        error.status = 409;
        error.payload = { code: 'STALE_SCHEDULE_PREVIEW' };
        throw error;
      },
    });
    render(<ScheduleHistoryView />);
    await selectVersion();
    fireEvent.click(screen.getByRole('button', { name: '恢復這個版本' }));
    const dialog = await screen.findByRole('dialog', { name: '恢復排程版本' });
    fireEvent.click(within(dialog).getByRole('button', { name: '確認恢復' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('請重新預覽');
    expect(screen.queryByRole('dialog', { name: '恢復排程版本' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '恢復這個版本' }));
    await waitFor(() => expect(previews).toBe(2));
  });

  it('套用中鎖住確認與關閉，避免 375px 連點重複 mutation', async () => {
    const post = deferred();
    standardApi({ '/schedule/versions/1/restore': () => post.promise });
    render(<ScheduleHistoryView />);
    await selectVersion();
    fireEvent.click(screen.getByRole('button', { name: '恢復這個版本' }));
    const dialog = await screen.findByRole('dialog', { name: '恢復排程版本' });
    fireEvent.click(within(dialog).getByRole('button', { name: '確認恢復' }));
    expect(within(dialog).getByRole('button', { name: '恢復中…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '關閉' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '恢復中…' }));
    expect(api.mock.calls.filter(([path, options]) => path.endsWith('/restore') && options?.method === 'POST')).toHaveLength(1);
    post.resolve({ applied: false });
  });

  it('恢復已寫入但刷新失敗時只重試投影，不會再次建立版本', async () => {
    let listAttempts = 0;
    let restoreAttempts = 0;
    standardApi({
      '/schedule/versions': async () => {
        listAttempts += 1;
        if (listAttempts === 2) throw new Error('重新整理失敗');
        return versions;
      },
      '/schedule/versions/1/restore': async () => {
        restoreAttempts += 1;
        return { applied: true, version: { version_id: 1 } };
      },
    });
    render(<ScheduleHistoryView />);
    await selectVersion();
    fireEvent.click(screen.getByRole('button', { name: '恢復這個版本' }));
    const dialog = await screen.findByRole('dialog', { name: '恢復排程版本' });
    fireEvent.click(within(dialog).getByRole('button', { name: '確認恢復' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('排程已恢復，但畫面暫時無法更新');
    expect(restoreAttempts).toBe(1);
    expect(within(dialog).getByRole('button', { name: '關閉' })).toBeDisabled();
    fireEvent.click(document.querySelector('.sheet-backdrop'));
    expect(screen.getByRole('dialog', { name: '恢復排程版本' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '重新載入結果' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '恢復排程版本' })).toBeNull());
    expect(restoreAttempts).toBe(1);
    expect(listAttempts).toBe(3);
  });
});
