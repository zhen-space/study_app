import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tt/material', () => ({
  updateBook: vi.fn(),
  updateNode: vi.fn(),
  updateContentItem: vi.fn(),
  deleteNode: vi.fn(),
  deleteContentItem: vi.fn(),
  createNode: vi.fn(),
  createContentItem: vi.fn(),
  getBookTree: vi.fn(),
  ITEM_LABEL: {
    reading: '閱讀', example: '例題', example_problem: '例題練習',
    unit_exercise: '單元練習', past_exam: '歷屆試題',
  },
  CHAPTER_LEVEL_KINDS: ['unit_exercise', 'past_exam'],
}));

import MaterialBookEditor from '../tt/MaterialBookEditor';
import * as material from '../tt/material';

const book = {
  id: 7, title: '英文課本', subject_list_id: 2, publisher: '龍騰', book_type: '課本',
};
const tree = {
  nodes: [{ id: 10, title: '第一章', kind: 'chapter', content_items: [], children: [] }],
};

function view(overrides = {}) {
  return render(<MaterialBookEditor
    book={book}
    tree={tree}
    lists={[{ id: 2, name: '英文' }]}
    onChanged={vi.fn()}
    onDone={vi.fn()}
    {...overrides}
  />);
}

describe('MaterialBookEditor mutation recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('token', `x.${btoa(JSON.stringify({ userId: 'student-a' }))}.y`);
    material.getBookTree.mockResolvedValue({
      book,
      nodes: [{ ...tree.nodes[0], children: [{
        id: 11, book_id: 7, parent_id: 10, kind: 'section', title: '新的節', content_items: [], children: [],
      }] }],
    });
  });

  it('網路錯誤只允許安全重送同一筆新增請求', async () => {
    material.createNode
      .mockRejectedValueOnce(new Error('暫時無法建立'))
      .mockResolvedValueOnce({ id: 11, book_id: 7, parent_id: 10, kind: 'section', title: '新的節' });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    view({ onChanged });

    const add = screen.getByRole('button', { name: '第一章：加一節' });
    fireEvent.click(add);
    expect(await screen.findByRole('alert')).toHaveTextContent('只會重新確認同一筆請求');
    expect(add).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '重新確認新增' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onChanged.mock.calls[0][0]).toMatchObject({ id: 11, parent_id: 10 });
    expect(onChanged.mock.calls[0][1].tree.nodes[0].children[0]).toMatchObject({
      id: 11, parent_id: 10, title: '新的節',
    });
    expect(material.createNode).toHaveBeenCalledTimes(2);
    expect(material.createNode.mock.calls[1][0]).toEqual(material.createNode.mock.calls[0][0]);
    expect(material.createNode.mock.calls[0][0]).toMatchObject({
      book_id: 7, parent_id: 10, kind: 'section', title: '新的節',
      client_request_id: expect.any(String),
    });
    expect(sessionStorage.getItem('tt-material-book-create-v1:7')).toBeNull();
  });

  it('reports a saved change when refresh fails and prevents duplicate retry', async () => {
    material.createNode.mockResolvedValue({ id: 11 });
    const onChanged = vi.fn().mockRejectedValue(new Error('refresh failed'));
    const onDone = vi.fn();
    view({ onChanged, onDone });

    const add = screen.getByRole('button', { name: '第一章：加一節' });
    fireEvent.click(add);
    expect(await screen.findByRole('alert')).toHaveTextContent('新增已儲存');
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(material.createNode).toHaveBeenCalledTimes(1);

    const done = screen.getByRole('button', { name: '完成編輯' });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('5xx 後重新整理只 replay 原 endpoint、body 與 request id，成功後重讀教材樹', async () => {
    material.createNode
      .mockRejectedValueOnce(Object.assign(new Error('暫時無法回應'), { status: 503 }))
      .mockResolvedValueOnce({ id: 11, book_id: 7, parent_id: 10, kind: 'topic', title: '新的主題' });
    const first = view();
    fireEvent.click(screen.getByRole('button', { name: '第一章：加一主題' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('只會重新確認同一筆請求');
    const firstBody = material.createNode.mock.calls[0][0];
    expect(JSON.parse(sessionStorage.getItem('tt-material-book-create-v1:7'))).toMatchObject({
      endpoint: '/material/nodes', body: firstBody,
    });

    first.unmount();
    const onChanged = vi.fn();
    view({ onChanged });
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());

    expect(material.createNode).toHaveBeenCalledTimes(2);
    expect(material.createNode.mock.calls[1][0]).toEqual(firstBody);
    expect(material.getBookTree).toHaveBeenCalledWith(7);
    expect(sessionStorage.getItem('tt-material-book-create-v1:7')).toBeNull();
  });

  it('新增內容的 5xx 也鎖住其他新增，只能 replay 同一筆 content request', async () => {
    material.createContentItem
      .mockRejectedValueOnce(Object.assign(new Error('伺服器忙碌'), { status: 500 }))
      .mockResolvedValueOnce({ id: 21, node_id: 10, kind: 'unit_exercise', title: '單元練習' });
    view();
    const addItem = screen.getByRole('button', { name: '第一章：加入單元練習' });
    fireEvent.click(addItem);

    expect(await screen.findByRole('alert')).toHaveTextContent('只會重新確認同一筆請求');
    expect(addItem).toBeDisabled();
    expect(screen.getByRole('button', { name: '第一章：加一節' })).toBeDisabled();
    const firstBody = material.createContentItem.mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: '重新確認新增' }));

    await waitFor(() => expect(material.createContentItem).toHaveBeenCalledTimes(2));
    expect(material.createContentItem.mock.calls[1][0]).toEqual(firstBody);
    expect(firstBody.client_request_id).toEqual(expect.any(String));
  });

  it('切換帳號會丟棄別人的 pending 新增，不會 replay', () => {
    sessionStorage.setItem('tt-material-book-create-v1:7', JSON.stringify({
      owner: 'student-a', book_id: 7, endpoint: '/material/nodes',
      body: { book_id: 7, parent_id: 10, kind: 'section', title: '別人的節', client_request_id: 'request-student-a' },
    }));
    localStorage.setItem('token', `x.${btoa(JSON.stringify({ userId: 'student-b' }))}.y`);

    view();

    expect(material.createNode).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('tt-material-book-create-v1:7')).toBeNull();
    expect(screen.getByRole('button', { name: '第一章：加一節' })).toBeEnabled();
  });

  it('synchronously guards rapid duplicate creates while the request is pending', async () => {
    let resolveCreate;
    const onChanged = vi.fn().mockResolvedValue(undefined);
    view({ onChanged });

    const add = screen.getByRole('button', { name: '第一章：加一節' });
    let nestedClickSent = false;
    material.createNode.mockImplementation(() => {
      if (!nestedClickSent) {
        nestedClickSent = true;
        fireEvent.click(add);
      }
      return new Promise(resolve => { resolveCreate = resolve; });
    });
    fireEvent.click(add);
    expect(material.createNode).toHaveBeenCalledTimes(1);

    resolveCreate({ id: 11 });
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it('does not keep the editor blocked while the outer library refresh runs', async () => {
    material.createNode.mockResolvedValue({
      id: 11, book_id: 7, parent_id: 10, kind: 'section', title: '新的節',
    });
    const onChanged = vi.fn(() => new Promise(() => {}));
    const onDone = vi.fn();
    view({ onChanged, onDone });

    fireEvent.click(screen.getByRole('button', { name: '第一章：加一節' }));
    await waitFor(() => expect(material.createNode).toHaveBeenCalledOnce());

    const done = await screen.findByRole('button', { name: '完成編輯' });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0][0].tree.nodes[0].children[0].id).toBe(11);
  });

  it('leaves without writing when the editor is completed unchanged', () => {
    const onDone = vi.fn();
    view({ onDone });
    fireEvent.click(screen.getByRole('button', { name: '完成編輯' }));

    expect(onDone).toHaveBeenCalledOnce();
    expect(material.createNode).not.toHaveBeenCalled();
    expect(material.createContentItem).not.toHaveBeenCalled();
    expect(material.updateBook).not.toHaveBeenCalled();
  });

  it('明確 4xx 會解除 fence，允許修正後再次新增', async () => {
    material.createNode.mockRejectedValueOnce(Object.assign(new Error('節點資料不正確'), { status: 422 }));
    view();

    const add = screen.getByRole('button', { name: '第一章：加一節' });
    fireEvent.click(add);

    expect(await screen.findByRole('alert')).toHaveTextContent('節點資料不正確');
    expect(add).toBeEnabled();
    expect(screen.queryByRole('button', { name: '重新確認新增' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem('tt-material-book-create-v1:7')).toBeNull();
  });

  it.each([
    [408, undefined, '逾時'],
    [409, 'IDEMPOTENCY_REQUEST_PENDING', '仍在處理'],
  ])('%i 暫時性結果會保留 exact fence，重試仍送同一筆', async (status, code, message) => {
    material.createNode
      .mockRejectedValueOnce(Object.assign(new Error(message), {
        status, payload: code ? { code } : {},
      }))
      .mockResolvedValueOnce({ id: 11, book_id: 7, parent_id: 10, kind: 'section', title: '新的節' });
    view();

    fireEvent.click(screen.getByRole('button', { name: '第一章：加一節' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('只會重新確認同一筆請求');
    const firstBody = material.createNode.mock.calls[0][0];
    expect(JSON.parse(sessionStorage.getItem('tt-material-book-create-v1:7')).body).toEqual(firstBody);

    fireEvent.click(screen.getByRole('button', { name: '重新確認新增' }));
    await waitFor(() => expect(material.createNode).toHaveBeenCalledTimes(2));
    expect(material.createNode.mock.calls[1][0]).toEqual(firstBody);
  });

  it('登入者無法解析時 fail closed，不建立未綁 owner 的 request', async () => {
    localStorage.setItem('token', '不是有效的-token');
    view();

    fireEvent.click(screen.getByRole('button', { name: '第一章：加一節' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('無法安全確認目前登入帳號');
    expect(material.createNode).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('tt-material-book-create-v1:7')).toBeNull();
  });

  it('重試前重新驗 owner；帳號已切換就清除 fence 並停止', async () => {
    material.createNode.mockRejectedValueOnce(new Error('網路中斷'));
    view();
    fireEvent.click(screen.getByRole('button', { name: '第一章：加一節' }));
    expect(await screen.findByRole('button', { name: '重新確認新增' })).toBeEnabled();

    localStorage.setItem('token', `x.${btoa(JSON.stringify({ userId: 'student-b' }))}.y`);
    fireEvent.click(screen.getByRole('button', { name: '重新確認新增' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('屬於目前帳號與教材');
    expect(material.createNode).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('tt-material-book-create-v1:7')).toBeNull();
  });

  it.each([
    ['未知 endpoint', {
      owner: 'student-a', book_id: 7, endpoint: '/material/books',
      body: { client_request_id: 'valid_request_id_0001' },
    }],
    ['node body 指向別本教材', {
      owner: 'student-a', book_id: 7, endpoint: '/material/nodes',
      body: { book_id: 8, parent_id: 10, kind: 'section', title: '錯誤', client_request_id: 'valid_request_id_0002' },
    }],
    ['body 含契約外欄位', {
      owner: 'student-a', book_id: 7, endpoint: '/material/nodes',
      body: { book_id: 7, parent_id: 10, kind: 'section', title: '錯誤', extra: true, client_request_id: 'valid_request_id_0003' },
    }],
  ])('掛載時拒絕不合法 fence：%s', (_label, fence) => {
    sessionStorage.setItem('tt-material-book-create-v1:7', JSON.stringify(fence));
    view();

    expect(material.createNode).not.toHaveBeenCalled();
    expect(material.createContentItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('tt-material-book-create-v1:7')).toBeNull();
  });

  it('content fence 的 node 不在目前教材樹時不送出', async () => {
    sessionStorage.setItem('tt-material-book-create-v1:7', JSON.stringify({
      owner: 'student-a', book_id: 7, endpoint: '/material/content-items',
      body: {
        node_id: 999, kind: 'unit_exercise', title: '錯誤內容',
        client_request_id: 'valid_request_id_0004',
      },
    }));
    view();

    expect(await screen.findByRole('alert')).toHaveTextContent('屬於目前帳號與教材');
    expect(material.createContentItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('tt-material-book-create-v1:7')).toBeNull();
  });
});
