// 教材匯入 hotfix 前端行為：
//   ① PhotoQueue 多張累積／排序／移除／上限；確認才送出（不每張立刻解析）。
//   ② AddMaterialFlow：拍照先進 PhotoQueue（不立即 parse）；defaultSubjectId 預帶科目。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { act } from 'react';

// jsdom 沒有 object URL：補上，讓縮圖 <img> 有 src、卸載時可 revoke。
beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PhotoQueue = (await import('../tt/PhotoQueue')).default;
const file = (name, bytes = 4, type = 'image/jpeg') => new File([new Uint8Array(bytes)], name, { type });
const setFiles = (input, files) => fireEvent.change(input, { target: { files } });

describe('PhotoQueue', () => {
  it('一次選多張 → 顯示頁數與縮圖；再拍一張會累積不覆蓋', () => {
    const onConfirm = vi.fn();
    render(<PhotoQueue onConfirm={onConfirm} onCancel={() => {}} max={3} />);
    setFiles(screen.getByLabelText('選多張照片'), [file('a.jpg'), file('b.jpg')]);
    expect(screen.getByText(/共 2 頁/)).toBeTruthy();
    // 相機再拍一張 → 累積成 3
    setFiles(screen.getByLabelText('拍下一張'), [file('c.jpg')]);
    expect(screen.getByText(/共 3 頁/)).toBeTruthy();
    expect(screen.getAllByRole('img').length).toBe(3);
  });

  it('超過張數上限 → 清楚繁中錯誤，不加入超過的', () => {
    render(<PhotoQueue onConfirm={() => {}} onCancel={() => {}} max={2} />);
    setFiles(screen.getByLabelText('選多張照片'), [file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    expect(screen.getByRole('alert').textContent).toMatch(/一次最多 2 張/);
    expect(screen.getByText(/共 2 頁/)).toBeTruthy();
  });

  it('單張超過大小上限 → 錯誤且不加入', () => {
    render(<PhotoQueue onConfirm={() => {}} onCancel={() => {}} maxFileMB={0.000001} />);
    setFiles(screen.getByLabelText('選多張照片'), [file('big.jpg', 64)]);
    expect(screen.getByRole('alert').textContent).toMatch(/超過單張/);
    expect(screen.getByText(/共 0 頁/)).toBeTruthy();
  });

  it('可移除與上下移動排序；確認以目前頁序送出', () => {
    const onConfirm = vi.fn();
    render(<PhotoQueue onConfirm={onConfirm} onCancel={() => {}} />);
    setFiles(screen.getByLabelText('選多張照片'), [file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    // 把第 1 頁下移 → 順序變 b,a,c
    fireEvent.click(screen.getByLabelText('第 1 頁下移'));
    // 移除現在的第 3 頁（c）
    fireEvent.click(screen.getByLabelText('移除第 3 頁'));
    expect(screen.getByText(/共 2 頁/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /確認送出/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const sent = onConfirm.mock.calls[0][0].map(f => f.name);
    expect(sent).toEqual(['b.jpg', 'a.jpg']);
  });

  it('沒有照片時不能確認送出', () => {
    render(<PhotoQueue onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: /確認送出/ }).disabled).toBe(true);
  });
});

// ---- AddMaterialFlow：拍照先進佇列、defaultSubjectId 預帶科目 ----
vi.mock('../tt/material', () => ({
  importPreview: vi.fn(async () => ({ draft: { book: { title: 'AI書', subject_list_id: null }, chapters: [{ title: '第一章', content_items: [{ kind: 'unit_exercise', title: '單元練習' }], children: [] }] }, problems: [], warnings: [] })),
  commitDraft: vi.fn(async () => ({ book: { id: 77, title: 'AI書' } })),
  nameCheck: vi.fn(async () => ({ has_conflict: false, same_name_books: [] })),
  ITEM_LABEL: { reading: '課本內容', example: '範例', example_problem: '例題', unit_exercise: '單元練習', past_exam: '歷屆試題' },
}));
vi.mock('../tt/vocabImport', () => ({ fileToPayload: vi.fn(async f => ({ filename: f.name, mime: 'image/jpeg', data: 'AAAA' })) }));

const AddMaterialFlow = (await import('../tt/AddMaterialFlow')).default;
const LISTS = [{ id: 1, name: '數學' }, { id: 2, name: '英文' }];

describe('AddMaterialFlow hotfix', () => {
  it('拍照 → 先進 PhotoQueue，不立即解析（importPreview 尚未呼叫）', async () => {
    const { importPreview } = await import('../tt/material');
    render(<AddMaterialFlow lists={LISTS} onCancel={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('拍照／匯入教材目錄'));
    expect(screen.getByLabelText('選多張照片')).toBeTruthy();   // 佇列畫面
    expect(importPreview).not.toHaveBeenCalled();
    // 加一張並確認 → 這時才解析
    setFiles(screen.getByLabelText('選多張照片'), [file('p.jpg')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /確認送出/ })); });
    await waitFor(() => expect(importPreview).toHaveBeenCalledTimes(1));
  });

  it('defaultSubjectId：自己建立教材時科目已預帶且鎖定（不可改成別科）', () => {
    render(<AddMaterialFlow lists={LISTS} defaultSubjectId={2} onCancel={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('自己建立教材'));
    const select = screen.getByDisplayValue('英文');
    expect(select.value).toBe('2');
    expect(select.disabled).toBe(true);               // 鎖定：不能被改成別科
    expect(screen.getByText(/已鎖定為這次要加入的科目/)).toBeTruthy();
  });

  it('無 defaultSubjectId（教材庫獨立建立）：科目可自由選擇，不鎖定', () => {
    render(<AddMaterialFlow lists={LISTS} onCancel={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByText('自己建立教材'));
    const select = screen.getByRole('combobox');       // 科目 select
    expect(select.disabled).toBe(false);
  });

  it('defaultSubjectId：AI 讀到的 draft 沒科目時，補上預帶科目', async () => {
    const onCreated = vi.fn();
    render(<AddMaterialFlow lists={LISTS} defaultSubjectId={1} onCancel={() => {}} onCreated={onCreated} />);
    fireEvent.click(screen.getByText('拍照／匯入教材目錄'));
    setFiles(screen.getByLabelText('選多張照片'), [file('p.jpg')]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /確認送出/ })); });
    // 進到編輯畫面，科目已是「數學」
    await waitFor(() => expect(screen.getByDisplayValue('數學')).toBeTruthy());
    expect(screen.getByDisplayValue('數學').value).toBe('1');
  });
});
