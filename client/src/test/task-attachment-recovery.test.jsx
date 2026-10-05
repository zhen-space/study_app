import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const { Detail } = await import('../tt/Tasks');

const task = (over = {}) => ({
  ...fx.tasks[0], id: 501, title: '英文作業', notes: '', tags: [], subtasks: [],
  task_kind: 'school_assignment', school_assignment_type: 'homework',
  deadline_date: fx.TODAY, deadline_time: '20:00', estimated_minutes: 30,
  ...over,
});

function uploadFile(name = '講義.pdf') {
  const file = new File(['附件內容'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn().mockResolvedValue(new TextEncoder().encode('附件內容').buffer),
  });
  return file;
}

function mount(onClose = vi.fn()) {
  render(<Detail task={task()} lists={fx.lists} onSave={vi.fn()} onDelete={vi.fn()} onClose={onClose} />);
}

describe('375px Task／School Assignment 附件上傳 recovery', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    api.mockReset();
    api.mockImplementation(path => {
      if (path.endsWith('/attachments') || path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
  });

  it('同步防止重複上傳，pending 時不能關閉明細', async () => {
    const file = uploadFile();
    let resolveUpload;
    let input;
    let reentered = false;
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/501/attachments' && options.method === 'POST') {
        if (!reentered) {
          reentered = true;
          fireEvent.change(input, { target: { files: [file] } });
        }
        return new Promise(resolve => { resolveUpload = resolve; });
      }
      if (path.endsWith('/attachments') || path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    const onClose = vi.fn();
    mount(onClose);
    input = screen.getByLabelText('新增附件');

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(api.mock.calls.filter(([path, options]) => path === '/tasks/501/attachments' && options?.method === 'POST')).toHaveLength(1));
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: '附件處理中…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '附件處理中…' }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { resolveUpload({ id: 91 }); });
    await waitFor(() => expect(screen.getByLabelText('新增附件')).toBeEnabled());
  });

  it('真正 POST 失敗顯示錯誤，清空 file input 以允許同檔重選', async () => {
    let uploads = 0;
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/501/attachments' && options.method === 'POST') {
        uploads += 1;
        return uploads === 1 ? Promise.reject(new Error('附件上傳失敗')) : Promise.resolve({ id: 92 });
      }
      if (path.endsWith('/attachments') || path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    mount();
    const input = screen.getByLabelText('新增附件');
    const file = uploadFile();

    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('附件上傳失敗');
    expect(input).toBeEnabled();
    expect(input).toHaveValue('');

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(uploads).toBe(2);
  });

  it('POST committed 後清單失敗只重試 GET，不重送附件', async () => {
    let attachmentGets = 0;
    api.mockImplementation((path, options = {}) => {
      if (path === '/tasks/501/attachments' && options.method === 'POST') return Promise.resolve({ id: 93 });
      if (path === '/tasks/501/attachments') {
        attachmentGets += 1;
        if (attachmentGets === 2) return Promise.reject(new Error('清單離線'));
        return Promise.resolve(attachmentGets === 3 ? [{ id: 93, name: '講義.pdf', size: 12 }] : []);
      }
      if (path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    mount();
    const input = screen.getByLabelText('新增附件');
    fireEvent.change(input, { target: { files: [uploadFile()] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('附件已上傳，但清單暫時無法更新');
    expect(input).toBeDisabled();
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks/501/attachments' && options?.method === 'POST')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '重新載入附件' }));
    expect(await screen.findByText('講義.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.mock.calls.filter(([path, options]) => path === '/tasks/501/attachments' && options?.method === 'POST')).toHaveLength(1);
    expect(attachmentGets).toBe(3);
  });
});
