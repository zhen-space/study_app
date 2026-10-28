import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ api: vi.fn() }));
vi.mock('../tt/vocabImport', () => ({
  filesToPayload: vi.fn(), savePending: vi.fn(), runImport: vi.fn(), resumePending: vi.fn(() => false),
  importing: vi.fn(() => false), getCurve: vi.fn(() => ({ mode: 'none' })), setCurve: vi.fn(),
}));
const { api } = await import('../api');
const VocabView = (await import('../tt/VocabView')).default;

const words = [
  { id: 1, english: 'apple', chinese: '蘋果', kind: '單字', date: '2099-01-01' },
  { id: 2, english: 'book', chinese: '書', kind: '單字', date: '2099-01-01' },
];
const deletes = () => api.mock.calls.filter(([, options]) => options?.method === 'DELETE');

describe('單字刪除失敗復原', () => {
  beforeEach(() => {
    api.mockReset();
    localStorage.clear();
    api.mockResolvedValue(words);
  });

  it('單筆刪除回應遺失時以正式資料復原且不重送', async () => {
    api.mockImplementation((path, options) => {
      if (path === '/import/vocab/1' && options?.method === 'DELETE') return Promise.reject(new Error('回應中斷'));
      return Promise.resolve(words);
    });
    render(<VocabView />);
    fireEvent.click(await screen.findByText('1/1'));
    fireEvent.click(await screen.findByRole('button', { name: '刪除「apple」' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已重新載入確認');
    expect(screen.getByText('apple')).toBeInTheDocument();
    expect(deletes()).toHaveLength(1);
  });

  it('整日部分刪除且重讀失敗時退回畫面並鎖住，重試只讀取', async () => {
    let reads = 0;
    api.mockImplementation((path, options) => {
      if (options?.method === 'DELETE') return path.endsWith('/1') ? Promise.resolve({}) : Promise.reject(new Error('中斷'));
      if (path === '/import/vocab') {
        reads += 1;
        if (reads === 2) return Promise.reject(new Error('離線'));
        return Promise.resolve(reads === 1 ? words : [words[1]]);
      }
      return Promise.resolve([]);
    });
    render(<VocabView />);
    const dayDelete = await screen.findByRole('button', { name: /刪除 .* 全部單字/ });
    fireEvent.click(dayDelete);

    expect(await screen.findByRole('alert')).toHaveTextContent('無法確認是否刪除');
    fireEvent.click(screen.getByText('1/1'));
    expect(screen.getByText('apple')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刪除「apple」' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '重新載入' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.queryByText('apple')).not.toBeInTheDocument();
    expect(screen.getByText('book')).toBeInTheDocument();
    expect(deletes()).toHaveLength(2);
  });
});
