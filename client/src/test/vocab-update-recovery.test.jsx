import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
vi.mock('../tt/vocabImport', () => ({
  filesToPayload: vi.fn(), savePending: vi.fn(), runImport: vi.fn(), resumePending: vi.fn(() => false),
  importing: vi.fn(() => false), getCurve: vi.fn(() => ({ mode: 'none' })), setCurve: vi.fn(),
}));
const { api } = await import('../api');
const VocabView = (await import('../tt/VocabView')).default;

const word = { id: 1, english: 'apple', chinese: '蘋果', kind: '單字', date: '2099-01-01' };
const patches = () => api.mock.calls.filter(([, options]) => options?.method === 'PATCH');

describe('單字更新失敗復原', () => {
  beforeEach(() => {
    api.mockReset(); localStorage.clear(); api.mockResolvedValue([word]);
  });

  it('更新回應遺失時以正式資料復原且不重送', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/import/vocab/1' && options?.method === 'PATCH') return Promise.reject(new Error('中斷'));
      if (path === '/import/vocab') return Promise.resolve(++reads === 1 ? [word] : [{ ...word, kind: '片語' }]);
      return Promise.resolve([]);
    });
    render(<VocabView />);
    fireEvent.click(await screen.findByText('1/1'));
    fireEvent.click(screen.getByText('apple'));
    fireEvent.click(screen.getByRole('button', { name: '單字' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(screen.getByRole('button', { name: '片語' })).toBeInTheDocument();
    expect(patches()).toHaveLength(1);
  });

  it('更新與重讀都失敗時鎖住該筆，重試只讀取', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (path === '/import/vocab/1' && options?.method === 'PATCH') return Promise.reject(new Error('中斷'));
      if (path === '/import/vocab') {
        reads += 1;
        if (reads === 2) return Promise.reject(new Error('離線'));
        return Promise.resolve([word]);
      }
      return Promise.resolve([]);
    });
    render(<VocabView />);
    fireEvent.click(await screen.findByText('1/1'));
    fireEvent.click(screen.getByText('apple'));
    fireEvent.click(screen.getByRole('button', { name: '單字' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認是否更新');
    expect(screen.getByRole('button', { name: '片語' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '單字' })).not.toBeDisabled();
    expect(patches()).toHaveLength(1);
  });
});
