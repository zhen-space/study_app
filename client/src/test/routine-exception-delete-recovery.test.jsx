import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const RoutinesView = (await import('../tt/RoutinesView')).default;

const item = { id: 9, date: '2026-11-01', kind: 'unavailable', title: '校慶', start_time: '', end_time: '' };
const deletes = () => api.mock.calls.filter(([path, options]) => path === '/routine-exceptions/9' && options?.method === 'DELETE');

describe('例外日移除失敗復原', () => {
  beforeEach(() => { api.mockReset(); });

  it('DELETE 已提交但回應遺失時讀回確認且不重送', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/routine-exceptions/9' && options?.method === 'DELETE') return Promise.reject(new Error('中斷'));
      if (path === '/routine-exceptions') return Promise.resolve(++reads === 1 ? [item] : []);
      return Promise.resolve([]);
    });
    render(<RoutinesView />);
    await screen.findByText('校慶');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移除' })); });

    expect(screen.getByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(screen.queryByText('校慶')).not.toBeInTheDocument();
    expect(deletes()).toHaveLength(1);
  });

  it('DELETE 與確認讀取都失敗時阻擋重送，重新載入只讀取', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/routine-exceptions/9' && options?.method === 'DELETE') return Promise.reject(new Error('中斷'));
      if (path === '/routine-exceptions') {
        reads += 1;
        if (reads === 2) return Promise.reject(new Error('離線'));
        return Promise.resolve(reads === 1 ? [item] : []);
      }
      return Promise.resolve([]);
    });
    render(<RoutinesView />);
    await screen.findByText('校慶');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移除' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('無法確認例外日是否移除');
    expect(screen.getByRole('button', { name: '移除' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(deletes()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已重新載入確認'));
    expect(screen.queryByText('校慶')).not.toBeInTheDocument();
    expect(deletes()).toHaveLength(1);
  });
});
