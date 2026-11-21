import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATERIAL_COMMIT_FENCE_KEY,
  clearMaterialCommitFence,
  createMaterialCommitFence,
  loadMaterialCommitFence,
  saveMaterialCommitFence,
} from '../tt/materialCommitFence';

const tokenFor = userId => {
  const payload = btoa(JSON.stringify({ userId }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `x.${payload}.y`;
};

describe('教材 commit session fence 資料隔離稽核', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('token', tokenFor('student-a'));
  });

  it('重新整理前後保存 exact draft 與同一把 request id，不保存 token', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '12345678-1234-1234-1234-123456789abc' });
    const draft = {
      book: { title: '物理課本', subject_list_id: 7 },
      chapters: [{ title: '第一章', content_items: [{ title: '彈力', kind: 'reading' }], children: [] }],
    };

    const fence = createMaterialCommitFence(draft);
    saveMaterialCommitFence(fence);

    expect(loadMaterialCommitFence()).toEqual(fence);
    expect(fence.body.draft).toEqual(draft);
    expect(fence.body.client_request_id).toBe('12345678-1234-1234-1234-123456789abc');
    expect(sessionStorage.getItem(MATERIAL_COMMIT_FENCE_KEY)).not.toContain(localStorage.getItem('token'));
  });

  it('切換帳號時 fail closed：刪除舊 fence，絕不 replay 別人的教材', () => {
    const oldFence = createMaterialCommitFence({
      book: { title: '甲的教材' },
      chapters: [{ title: '第一章', content_items: [{ title: '內容', kind: 'reading' }], children: [] }],
    });
    saveMaterialCommitFence(oldFence);

    localStorage.setItem('token', tokenFor('student-b'));

    expect(loadMaterialCommitFence()).toBeNull();
    expect(sessionStorage.getItem(MATERIAL_COMMIT_FENCE_KEY)).toBeNull();
  });

  it('只允許 fence owner 清除自己的 pending request', () => {
    const fence = createMaterialCommitFence({ book: { title: '待確認教材' }, chapters: [] });
    saveMaterialCommitFence(fence);

    clearMaterialCommitFence('student-b');
    expect(loadMaterialCommitFence()).toEqual(fence);

    clearMaterialCommitFence('student-a');
    expect(loadMaterialCommitFence()).toBeNull();
  });
});
