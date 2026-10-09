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
  ITEM_LABEL: {
    reading: '閱讀', example: '例題', example_problem: '例題練習',
    chapter_exercise: '單元練習', past_exam: '歷屆試題',
  },
  CHAPTER_LEVEL_KINDS: ['chapter_exercise', 'past_exam'],
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
  beforeEach(() => vi.clearAllMocks());

  it('keeps a real create failure retryable and sends the same scoped payload', async () => {
    material.createNode
      .mockRejectedValueOnce(new Error('暫時無法建立'))
      .mockResolvedValueOnce({ id: 11, book_id: 7, parent_id: 10, kind: 'section', title: '新的節' });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    view({ onChanged });

    const add = screen.getByRole('button', { name: '第一章：加一節' });
    fireEvent.click(add);
    expect(await screen.findByRole('alert')).toHaveTextContent('暫時無法建立');
    expect(add).toBeEnabled();

    fireEvent.click(add);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onChanged.mock.calls[0][0]).toMatchObject({ id: 11, parent_id: 10 });
    expect(onChanged.mock.calls[0][1].tree.nodes[0].children[0]).toMatchObject({
      id: 11, parent_id: 10, title: '新的節',
    });
    expect(material.createNode).toHaveBeenCalledTimes(2);
    expect(material.createNode).toHaveBeenLastCalledWith({
      book_id: 7, parent_id: 10, kind: 'section', title: '新的節',
    });
  });

  it('reports a saved change when refresh fails and prevents duplicate retry', async () => {
    material.createNode.mockResolvedValue({ id: 11 });
    const onChanged = vi.fn().mockRejectedValue(new Error('refresh failed'));
    const onDone = vi.fn();
    view({ onChanged, onDone });

    const add = screen.getByRole('button', { name: '第一章：加一節' });
    fireEvent.click(add);
    expect(await screen.findByRole('alert')).toHaveTextContent('變更已儲存');
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(material.createNode).toHaveBeenCalledTimes(1);

    const done = screen.getByRole('button', { name: '完成編輯' });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalledOnce();
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
});
