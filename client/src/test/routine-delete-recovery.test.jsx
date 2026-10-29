import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const RoutinesView = (await import('../tt/RoutinesView')).default;

const routine = { id: 7, type: 'class', title: '晚自習', weekdays: '[1,2,3,4,5]', start_time: '19:00', end_time: '20:00' };
const deletes = () => api.mock.calls.filter(([path, options]) => path === '/routines/7' && options?.method === 'DELETE');

describe('固定時間移除失敗復原', () => {
  beforeEach(() => { api.mockReset(); });

  it('DELETE 已提交但回應遺失時讀回確認且不重送', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/routines/7' && options?.method === 'DELETE') return Promise.reject(new Error('中斷'));
      if (path === '/routines') return Promise.resolve(++reads === 1 ? [routine] : []);
      return Promise.resolve([]);
    });
    render(<RoutinesView />);
    await screen.findByText('晚自習');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移除' })); });

    expect(screen.getByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(screen.queryByText('晚自習')).not.toBeInTheDocument();
    expect(deletes()).toHaveLength(1);
  });

  it('DELETE 與確認讀取都失敗時阻擋重送，重新載入只讀取', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/routines/7' && options?.method === 'DELETE') return Promise.reject(new Error('中斷'));
      if (path === '/routines') {
        reads += 1;
        if (reads === 2) return Promise.reject(new Error('離線'));
        return Promise.resolve(reads === 1 ? [routine] : []);
      }
      return Promise.resolve([]);
    });
    render(<RoutinesView />);
    await screen.findByText('晚自習');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移除' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('無法確認固定時間是否移除');
    expect(screen.getByRole('button', { name: '移除' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(deletes()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已重新載入確認'));
    expect(screen.queryByText('晚自習')).not.toBeInTheDocument();
    expect(deletes()).toHaveLength(1);
  });
});
