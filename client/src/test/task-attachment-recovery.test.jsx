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
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:attachment') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    HTMLAnchorElement.prototype.click.mockClear();
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

  it('附件刪除同步防重入，pending 時不能關閉明細', async () => {
    const attachment = { id: 41, name: '舊講義.pdf', size: 12 };
    let resolveDelete;
    let remove;
    let reentered = false;
    let deleted = false;
    api.mockImplementation((path, options = {}) => {
      if (path === '/attachments/41' && options.method === 'DELETE') {
        if (!reentered) {
          reentered = true;
          fireEvent.click(remove);
        }
        return new Promise(resolve => { resolveDelete = resolve; });
      }
      if (path === '/tasks/501/attachments') return Promise.resolve(deleted ? [] : [attachment]);
      if (path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    const onClose = vi.fn();
    mount(onClose);
    remove = await screen.findByRole('button', { name: '刪除附件「舊講義.pdf」' });

    fireEvent.click(remove);
    expect(api.mock.calls.filter(([path, options]) => path === '/attachments/41' && options?.method === 'DELETE')).toHaveLength(1);
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(remove).toBeDisabled();
    const close = screen.getByRole('button', { name: '附件處理中…' });
    expect(close).toBeDisabled();
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();

    deleted = true;
    await act(async () => { resolveDelete({ ok: true }); });
    await waitFor(() => expect(screen.queryByText('舊講義.pdf')).not.toBeInTheDocument());
  });

  it('真正 DELETE 失敗保留附件與錯誤，允許確認後重試', async () => {
    const attachment = { id: 42, name: '英文作業.pdf', size: 12 };
    let deletes = 0;
    api.mockImplementation((path, options = {}) => {
      if (path === '/attachments/42' && options.method === 'DELETE') {
        deletes += 1;
        return deletes === 1 ? Promise.reject(new Error('附件刪除失敗')) : Promise.resolve({ ok: true });
      }
      if (path === '/tasks/501/attachments') return Promise.resolve(deletes > 1 ? [] : [attachment]);
      if (path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    mount();
    const remove = await screen.findByRole('button', { name: '刪除附件「英文作業.pdf」' });

    fireEvent.click(remove);
    expect(await screen.findByRole('alert')).toHaveTextContent('附件刪除失敗');
    expect(screen.getByText('英文作業.pdf')).toBeInTheDocument();
    expect(remove).toBeEnabled();

    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByText('英文作業.pdf')).not.toBeInTheDocument());
    expect(deletes).toBe(2);
  });

  it('DELETE committed 後清單失敗只重試 GET，取消則零寫入', async () => {
    const attachment = { id: 43, name: '答案.pdf', size: 12 };
    let attachmentGets = 0;
    api.mockImplementation((path, options = {}) => {
      if (path === '/attachments/43' && options.method === 'DELETE') return Promise.resolve({ ok: true });
      if (path === '/tasks/501/attachments') {
        attachmentGets += 1;
        if (attachmentGets === 2) return Promise.reject(new Error('清單離線'));
        return Promise.resolve(attachmentGets === 1 ? [attachment] : []);
      }
      if (path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    mount();
    const remove = await screen.findByRole('button', { name: '刪除附件「答案.pdf」' });

    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(remove);
    expect(api.mock.calls.filter(([path]) => path === '/attachments/43')).toHaveLength(0);
    expect(screen.getByText('答案.pdf')).toBeInTheDocument();

    window.confirm.mockReturnValue(true);
    fireEvent.click(remove);
    expect(await screen.findByRole('alert')).toHaveTextContent('附件已刪除，但清單暫時無法更新');
    expect(screen.queryByText('答案.pdf')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新載入附件' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(api.mock.calls.filter(([path]) => path === '/attachments/43')).toHaveLength(1);
    expect(attachmentGets).toBe(3);
  });

  it('附件下載同步防重入，pending 時停用下載與刪除', async () => {
    const attachment = { id: 51, name: '題目.pdf', size: 12 };
    let resolveDownload;
    let download;
    let reentered = false;
    api.mockImplementation(path => {
      if (path === '/attachments/51') {
        if (!reentered) {
          reentered = true;
          fireEvent.click(download);
        }
        return new Promise(resolve => { resolveDownload = resolve; });
      }
      if (path === '/tasks/501/attachments') return Promise.resolve([attachment]);
      if (path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    mount();
    download = await screen.findByRole('button', { name: '下載附件「題目.pdf」' });

    fireEvent.click(download);
    expect(api.mock.calls.filter(([path]) => path === '/attachments/51')).toHaveLength(1);
    expect(download).toBeDisabled();
    expect(screen.getByRole('button', { name: '刪除附件「題目.pdf」' })).toBeDisabled();

    await act(async () => { resolveDownload({ name: '題目.pdf', mime: 'application/pdf', data: btoa('pdf') }); });
    await waitFor(() => expect(screen.getByRole('button', { name: '下載附件「題目.pdf」' })).toBeEnabled());
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('附件 GET 失敗顯示錯誤並保留下載入口可重試', async () => {
    const attachment = { id: 52, name: '解答.pdf', size: 12 };
    let downloads = 0;
    api.mockImplementation(path => {
      if (path === '/attachments/52') {
        downloads += 1;
        return downloads === 1
          ? Promise.reject(new Error('下載暫時失敗'))
          : Promise.resolve({ name: '解答.pdf', mime: 'application/pdf', data: btoa('answer') });
      }
      if (path === '/tasks/501/attachments') return Promise.resolve([attachment]);
      if (path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    mount();
    const download = await screen.findByRole('button', { name: '下載附件「解答.pdf」' });

    fireEvent.click(download);
    expect(await screen.findByRole('alert')).toHaveTextContent('下載暫時失敗');
    expect(download).toBeEnabled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();

    fireEvent.click(download);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(downloads).toBe(2);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });

  it('損壞的附件資料不觸發下載，顯示可恢復錯誤', async () => {
    const attachment = { id: 53, name: '損壞.pdf', size: 12 };
    api.mockImplementation(path => {
      if (path === '/attachments/53') return Promise.resolve({ name: '損壞.pdf', mime: 'application/pdf', data: '%%%不是base64' });
      if (path === '/tasks/501/attachments') return Promise.resolve([attachment]);
      if (path === '/study-sessions') return Promise.resolve([]);
      return Promise.resolve({});
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '下載附件「損壞.pdf」' }));

    expect(await screen.findByRole('alert')).not.toHaveTextContent('');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '下載附件「損壞.pdf」' })).toBeEnabled();
  });
});
