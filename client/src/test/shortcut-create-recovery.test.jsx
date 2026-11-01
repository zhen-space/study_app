import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import * as fx from './fixtures';
import { today } from '../tt/helpers';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;

const responseFor = raw => {
  const path = raw.startsWith('/plans?') ? '/plans' : raw;
  if (path in fx.responses) return fx.responses[path];
  if (path.startsWith('/tasks/')) return {};
  return [];
};

describe('網址捷徑新增任務回應遺失復原', () => {
  beforeEach(() => {
    api.mockReset();
    localStorage.clear();
    window.history.replaceState({}, '', '/?add=物理講義');
  });
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('POST 已寫入但回應遺失時讀回確認，清掉網址且不重送', async () => {
    const created = {
      id: 901, title: '物理講義', due_date: today(), due_time: null,
      list_id: null, notes: '', priority: 0, tags: [], subtasks: [], completed: false, deleted: false,
    };
    let taskReads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/tasks' && options?.method === 'POST') return Promise.reject(new Error('回應遺失'));
      if (path === '/tasks') {
        taskReads += 1;
        return Promise.resolve(taskReads >= 3 ? [...fx.tasks, created] : fx.tasks);
      }
      return Promise.resolve(responseFor(path));
    });

    render(<Shell onLogout={() => {}} />);

    await waitFor(() => expect(window.location.search).toBe(''));
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(1);
    expect(screen.queryByText(/無法確認捷徑任務/)).toBeNull();
  });

  it('POST 與讀回都失敗時清掉網址並警告先確認，避免重新整理重送', async () => {
    let taskReads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/tasks' && options?.method === 'POST') return Promise.reject(new Error('回應遺失'));
      if (path === '/tasks') {
        taskReads += 1;
        if (taskReads >= 3) return Promise.reject(new Error('確認失敗'));
        return Promise.resolve(fx.tasks);
      }
      return Promise.resolve(responseFor(path));
    });

    render(<Shell onLogout={() => {}} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('請先到任務清單確認');
    expect(window.location.search).toBe('');
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(1);
  });
});
