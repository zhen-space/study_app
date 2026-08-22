// 新版第 1 步「讀什麼」。
//
// 這一支守的是產品面的界線，每一條壞掉學生就會看不懂或被騙：
//   ・第 1 步只問兩件事：這次要準備什麼、要讀哪些內容
//   ・計畫名稱是學生打的，產生預覽不得覆寫；Edit 進來要帶回既有名稱
//   ・教材只有一個世界：沒有分頁、沒有分類、沒有任何系統內部用語
//   ・還沒確認過內容的教材，第一次要用時就地確認一次，取消就什麼都不寫
//   ・確認送出時帶的是使用者實際看過的那份來源快照
//   ・來源在確認途中變動（409）→ 用自然語言重新確認，不自動重送
//   ・「焦點」這類對不上的節點不被系統猜成任何內容種類
//   ・加入教材：拍照與自己建立最後都走同一支寫入 API
//   ・取消匯入不會留下半本教材

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React, { act } from 'react';
import * as fx from './fixtures';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const MaterialSelector = (await import('../tt/MaterialSelector')).default;
const WizardView = (await import('../tt/WizardView')).default;
const PlanDetailView = (await import('../tt/PlanDetailView')).default;

/* ---------- 尚未確認內容的教材 ---------- */

const PENDING = {
  source: 'legacy', legacy_ref: { list_id: 1, book: '舊講義' }, title: '舊講義',
  publisher: '翰林', subject_list_id: 1, completion_supported: false,
  requires_content_confirmation: true, selectable: true, chapter_count: 1,
};

const SNAPSHOT = {
  source_kind: 'legacy_toc', list_id: 1, book: '舊講義',
  row_ids: [77], fingerprint: 'fp-abc',
};

const CHECK = {
  draft: {
    book: { title: '舊講義', publisher: '翰林', subject_list_id: 1 },
    chapters: [{
      title: '第 1 章 三角',
      order: 0,
      content_items: [],
      children: [
        { kind: 'section', title: '1-1 正弦', order: 0, content_items: [], legacy_ref: { toc_id: 77, path: [0] } },
        { kind: 'topic', title: '主題一 和角', order: 1, content_items: [], legacy_ref: { toc_id: 77, path: [0, 0] } },
      ],
      unsupported_nodes: [
        { title: '焦點一 疊合', legacy_level: '焦點', legacy_ref: { toc_id: 77, path: [1] } },
      ],
      legacy_ref: { toc_id: 77, path: [] },
    }],
  },
  source_snapshot: SNAPSHOT,
  source_row_ids: [77],
  already_formalized_row_ids: [],
  unsupported_nodes: [
    { title: '焦點一 疊合', legacy_level: '焦點', legacy_ref: { toc_id: 77, path: [1] } },
  ],
  requires_content_confirmation: true,
};

const SHELF_WITH_PENDING = { books: [PENDING], counts: { material: 0, legacy: 1 } };
const EMPTY_SHELF = { books: [], counts: { material: 0, legacy: 0 } };

let calls;
let shelf;
const setApi = (over = {}) => {
  api.mockImplementation((raw, opts) => {
    calls.push([raw, opts]);
    const path = raw.split('?')[0];
    const hit = raw in over ? over[raw] : (path in over ? over[path] : undefined);
    if (hit !== undefined) return Promise.resolve(typeof hit === 'function' ? hit(opts, raw) : hit);
    if (path === '/study-materials') return Promise.resolve(shelf());
    if (path === '/material/books') return Promise.resolve(fx.materialBooks);
    if (path.startsWith('/material/books/') && path.endsWith('/tree')) {
      return Promise.resolve(fx.materialTrees[+path.split('/')[3]]);
    }
    if (path === '/material/legacy-books/1/content-check') return Promise.resolve(CHECK);
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    return Promise.resolve({});
  });
};

let errors;
beforeEach(() => {
  calls = [];
  errors = [];
  shelf = () => fx.materialShelf;
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
  setApi();
});
afterEach(() => { vi.restoreAllMocks(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const click = el => act(async () => { el.click(); });
const btn = re => screen.getByRole('button', { name: re });
const sent = (prefix, method) =>
  calls.filter(([p, o]) => p.startsWith(prefix) && (o?.method || 'GET') === method);
const checkTotal = () => document.querySelector('.mc-total').textContent;
const noCrash = () => {
  const real = errors.filter(e => !/not wrapped in act|validateDOMNesting|unique "key"/i.test(e));
  expect(real, '不應該有 runtime exception：\n' + real.join('\n')).toEqual([]);
};

const mountWizard = async (props = {}) => {
  const r = render(<WizardView lists={fx.lists} reload={() => Promise.resolve()}
    goTasks={() => {}} goCalendar={() => {}} {...props} />);
  await waitFor(() => expect(calls.some(([p]) => p === '/settings')).toBe(true));
  await flush();
  return r;
};

/* ============ 1. 這次要準備什麼 ============ */

describe('計畫名稱', () => {
  it('Create：一開始空白，學生自由輸入，不出現 Goal / 分類 / Plan name 這些字', async () => {
    await mountWizard();
    const input = screen.getByLabelText('這次要準備什麼？');
    expect(input.value).toBe('');
    expect(input.placeholder).toMatch(/第一次段考/);
    expect(document.body.textContent).not.toMatch(/Goal|目標分類|Plan name/i);
    fireEvent.change(input, { target: { value: '下週數學小考' } });
    expect(screen.getByLabelText('這次要準備什麼？').value).toBe('下週數學小考');
    noCrash();
  });

  it('產生預覽不覆寫學生打的名稱，送出時原樣送到 plans.name', async () => {
    let created = null;
    setApi({
      '/plans': opts => { created = opts?.body; return { id: 99 }; },
      '/schedule/preview': fx.preview,
    });
    await mountWizard();
    fireEvent.change(screen.getByLabelText('這次要準備什麼？'), { target: { value: '第一次段考' } });
    await click(btn(/新大滿貫/));
    await flush();
    await click(screen.getByRole('checkbox', { name: '單元1 力學（整章）' }));
    await flush();
    await click(btn(/所有教材/));
    await flush();
    await click(btn(/^下一步$/));
    await click(btn(/產生排程/));
    await flush();
    // 第 3 步不再有第二個名稱欄位，而且名稱沒有被自動改掉
    expect(screen.queryByLabelText('計畫名稱')).toBeNull();
    await click(btn(/加入待辦/));
    await flush();
    expect(created.name).toBe('第一次段考');
    noCrash();
  });

  it('Edit：直接帶回既有的 plans.name', async () => {
    await mountWizard({ mode: 'edit', planId: 12, planTitle: '第二次段考準備', planTasks: [], onDone: () => {} });
    expect(screen.getByLabelText('這次要準備什麼？').value).toBe('第二次段考準備');
    noCrash();
  });
});

/* ============ 2. 一個教材世界 ============ */

describe('教材只有一個世界', () => {
  it('正式教材與尚未確認內容的教材出現在同一份清單，沒有分頁也沒有任何內部用語', async () => {
    shelf = () => ({ books: [...fx.materialShelf.books, PENDING], counts: { material: 2, legacy: 1 } });
    render(<MaterialSelector />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    expect(screen.getByText('舊講義')).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toEqual([]);
    expect(document.body.textContent)
      .not.toMatch(/legacy|migration|formalization|identity|舊版目錄|轉換成|正式教材|selection|completion/i);
    noCrash();
  });

  it('沒有教材時給明確的下一步，而不是空白畫面', async () => {
    shelf = () => EMPTY_SHELF;
    render(<MaterialSelector />);
    await waitFor(() => expect(screen.queryByText('還沒有教材')).toBeTruthy());
    expect(screen.getByText(/加入你的第一本教材/)).toBeTruthy();
    await click(btn(/加入教材/));
    await flush();
    expect(screen.getByText('拍照／匯入教材目錄')).toBeTruthy();
    expect(screen.getByText('自己建立教材')).toBeTruthy();
    // 學生看到的是動作，不是系統名詞
    expect(document.body.textContent).not.toMatch(/Create Material|Import TOC|OCR/i);
    noCrash();
  });
});

/* ============ 3. 就地確認教材內容 ============ */

const openCheck = async () => {
  shelf = () => SHELF_WITH_PENDING;
  render(<MaterialSelector lists={fx.lists} />);
  await waitFor(() => expect(screen.queryByText('舊講義')).toBeTruthy());
  await click(btn(/舊講義/));
  await waitFor(() => expect(screen.queryByText('確認教材內容')).toBeTruthy());
};

describe('第一次要用某本教材時就地確認內容', () => {
  it('系統已知道的結構直接帶入，只問它不知道的內容種類', async () => {
    await openCheck();
    // 書名帶入、章節帶入
    expect(screen.getAllByText('舊講義').length).toBeGreaterThan(0);
    expect(screen.getByText('1-1 正弦')).toBeTruthy();
    expect(screen.getByText('主題一 和角')).toBeTruthy();
    // 問的是內容種類，而且一開始一個都沒勾（系統不替他決定）
    expect(screen.getByRole('checkbox', { name: '1-1 正弦：課本內容' }).getAttribute('aria-checked')).toBe('false');
    expect(checkTotal()).toBe('已選 0 項');
    expect(btn(/^完成$/)).toBeDisabled();
    noCrash();
  });

  it('「焦點」這種對不上的節點不被猜成任何內容種類，由學生自己說它是什麼', async () => {
    await openCheck();
    expect(screen.getByText('焦點一 疊合')).toBeTruthy();
    // 課本上的原字保留下來當線索
    expect(screen.getByText(/課本上寫「焦點」/)).toBeTruthy();
    // 沒有指定是節還是主題之前，內容不能勾
    expect(screen.getByRole('checkbox', { name: '焦點一 疊合：課本內容' })).toBeDisabled();
    await click(screen.getByRole('radio', { name: '焦點一 疊合：主題' }));
    expect(screen.getByRole('checkbox', { name: '焦點一 疊合：課本內容' })).not.toBeDisabled();
    noCrash();
  });

  it('取消：不寫任何東西', async () => {
    await openCheck();
    await click(btn(/^取消$/));
    await flush();
    expect(sent('/material/', 'POST')).toEqual([]);
    expect(screen.queryByText('確認教材內容')).toBeNull();
    noCrash();
  });

  it('確認：送出的是學生實際看過的那份來源快照，內容種類照他勾的', async () => {
    let body = null;
    setApi({
      '/material/legacy-books/1/content-check': (opts) => {
        if (opts?.method === 'POST') { body = opts.body; return { book: { id: 9 } }; }
        return CHECK;
      },
    });
    await openCheck();
    await click(screen.getByRole('checkbox', { name: '1-1 正弦：課本內容' }));
    await click(screen.getByRole('checkbox', { name: '1-1 正弦：例題' }));
    await click(screen.getByRole('checkbox', { name: '第 1 章 三角：本章：單元練習' }));
    expect(checkTotal()).toBe('已選 3 項');
    await click(btn(/^完成$/));
    await flush();

    expect(body.source_snapshot).toEqual(SNAPSHOT);
    const ch = body.draft.chapters[0];
    // 章底下直接掛單元練習，不為它造一個假的節
    expect(ch.content_items).toEqual([{ kind: 'unit_exercise', title: '單元練習', order: 0 }]);
    const sec = ch.children.find(c => c.title === '1-1 正弦');
    expect(sec.kind).toBe('section');
    expect(sec.content_items.map(i => i.kind)).toEqual(['reading', 'example_problem']);
    // 沒勾的節點就是沒有內容，系統不補
    expect(ch.children.find(c => c.title === '主題一 和角').content_items).toEqual([]);
    // 沒指定種類的「焦點」這次不進教材
    expect(ch.children.some(c => c.title === '焦點一 疊合')).toBe(false);
    noCrash();
  });

  it('「每一節通常有」一次套到整本，之後仍可逐一調整', async () => {
    await openCheck();
    await click(screen.getByRole('checkbox', { name: '每一節通常有：範例' }));
    await flush();
    expect(checkTotal()).toBe('已選 2 項');   // 兩個節點各一項
    expect(screen.getByRole('checkbox', { name: '1-1 正弦：範例' }).getAttribute('aria-checked')).toBe('true');
    await click(screen.getByRole('checkbox', { name: '1-1 正弦：範例' }));
    expect(checkTotal()).toBe('已選 1 項');
    noCrash();
  });

  it('來源在確認途中變動：用自然語言請他再看一次，而且不自動重送', async () => {
    let posts = 0;
    setApi({
      '/material/legacy-books/1/content-check': (opts) => {
        if (opts?.method === 'POST') {
          posts++;
          const e = new Error('這本教材的內容已經變動，請重新確認一次');
          e.status = 409;
          e.payload = { stale: true };
          return Promise.reject(e);
        }
        return Promise.resolve(CHECK);
      },
    });
    await openCheck();
    await click(screen.getByRole('checkbox', { name: '1-1 正弦：課本內容' }));
    await click(btn(/^完成$/));
    await flush();

    expect(screen.getByRole('status').textContent).toBe('教材內容剛剛有更新，請再確認一次。');
    // 學生看到的不是技術錯誤
    expect(document.body.textContent).not.toMatch(/409|stale|snapshot|fingerprint/i);
    // 只送了一次：不自動重試
    expect(posts).toBe(1);
    // 重新讀回最新的來源，剛才的勾選被清掉——確認的必須是他現在看到的這一份
    expect(calls.filter(([p, o]) =>
      p.startsWith('/material/legacy-books/1/content-check') && (o?.method || 'GET') === 'GET').length).toBe(2);
    expect(checkTotal()).toBe('已選 0 項');
    noCrash();
  });

  it('確認完直接進到這本教材的內容，不用回書櫃自己再找一次', async () => {
    let phase = 0;
    shelf = () => (phase === 0
      ? SHELF_WITH_PENDING
      : { books: [fx.materialShelf.books[0]], counts: { material: 1, legacy: 0 } });
    setApi({
      '/material/legacy-books/1/content-check': (opts) => {
        if (opts?.method === 'POST') { phase = 1; return { book: { id: 1 } }; }
        return CHECK;
      },
    });
    render(<MaterialSelector lists={fx.lists} />);
    await waitFor(() => expect(screen.queryByText('舊講義')).toBeTruthy());
    await click(btn(/舊講義/));
    await waitFor(() => expect(screen.queryByText('確認教材內容')).toBeTruthy());
    await click(screen.getByRole('checkbox', { name: '1-1 正弦：課本內容' }));
    await click(btn(/^完成$/));
    await flush();
    // 已經在這本教材裡面了，而且是可以直接勾選的正式內容
    expect(screen.getByRole('checkbox', { name: '單元1 力學（整章）' })).toBeTruthy();
    noCrash();
  });
});

/* ============ 4. 加入教材 ============ */

describe('加入教材', () => {
  const openAdd = async () => {
    shelf = () => EMPTY_SHELF;
    render(<MaterialSelector lists={fx.lists} onAddSubject={async n => ({ id: 9, name: n })} />);
    await waitFor(() => expect(screen.queryByText('還沒有教材')).toBeTruthy());
    await click(btn(/加入教材/));
    await flush();
  };

  it('自己建立：從空白組出完整的一本，走的是同一支寫入 API', async () => {
    let body = null;
    setApi({ '/material/import/commit': opts => { body = opts.body; return { book: { id: 5 } }; } });
    await openAdd();
    await click(btn(/自己建立教材/));
    await flush();

    fireEvent.change(screen.getByLabelText(/教材名稱|^教材名稱$/) || screen.getByPlaceholderText(/新大滿貫/),
      { target: { value: '自己打的教材' } });
    fireEvent.change(screen.getByLabelText('第 1 章名稱'), { target: { value: '第 1 章 數與式' } });
    await click(btn(/加一節／主題/));
    await flush();
    fireEvent.change(screen.getByLabelText('第 1 項名稱'), { target: { value: '1-1 數與數線' } });
    await click(btn(/1-1 數與數線：加入課本內容/));
    await click(btn(/1-1 數與數線：加入範例/));
    await click(btn(/第 1 章：加入單元練習/));
    await flush();
    expect(screen.getByText('共 3 項內容')).toBeTruthy();
    await click(btn(/^建立教材$/));
    await flush();

    const d = body.draft;
    expect(d.book.title).toBe('自己打的教材');
    expect(d.chapters.length).toBe(1);
    // 單元練習直接屬於章，不在任何一節底下
    expect(d.chapters[0].content_items.map(i => i.kind)).toEqual(['unit_exercise']);
    expect(d.chapters[0].children[0].kind).toBe('section');
    expect(d.chapters[0].children[0].content_items.map(i => i.kind)).toEqual(['reading', 'example']);
    // 節底下不會再有節或主題
    expect(d.chapters[0].children[0].children).toBeUndefined();
    noCrash();
  });

  it('一個科目都沒有的新帳號，可以就地新增科目——不然第一次使用就是死路', async () => {
    let reloaded = 0;
    shelf = () => EMPTY_SHELF;
    // 照實際情況：新增科目之後上層會 reload，科目清單才跟著更新
    function Host() {
      const [ls, setLs] = React.useState([]);
      return (
        <MaterialSelector lists={ls}
          onAddSubject={async name => {
            reloaded++;
            const made = { id: 9, name };
            setLs([made]);
            return made;
          }} />
      );
    }
    render(<Host />);
    await waitFor(() => expect(screen.queryByText('還沒有教材')).toBeTruthy());
    await click(btn(/加入教材/));
    await flush();
    await click(btn(/自己建立教材/));
    await flush();

    const sel = screen.getByLabelText('科目');
    // 一個科目都沒有，但看得到「可以新增一個」
    expect([...sel.options].map(o => o.textContent)).toEqual(['請選擇', '＋ 新增科目…']);
    fireEvent.change(sel, { target: { value: '__new' } });
    await flush();
    fireEvent.change(screen.getByLabelText('新科目名稱'), { target: { value: '數學' } });
    await click(btn(/^新增$/));
    await flush();

    expect(reloaded).toBe(1);
    // 建好之後直接選起來：學生要的是「這本書是數學」，不是「我新增了一個科目」
    expect(screen.getByLabelText('科目').value).toBe('9');
    expect(screen.queryByLabelText('新科目名稱')).toBeNull();
    noCrash();
  });

  it('已經有科目時不強迫新增，原本的選項照常在', async () => {
    await openAdd();
    await click(btn(/自己建立教材/));
    await flush();
    const opts = [...screen.getByLabelText('科目').options].map(o => o.textContent);
    expect(opts).toEqual(['請選擇', '物理', '地科', '＋ 新增科目…']);
    noCrash();
  });

  it('節與主題是同層的兩個選項，不是上下層', async () => {
    await openAdd();
    await click(btn(/自己建立教材/));
    await flush();
    await click(btn(/加一節／主題/));
    await flush();
    const kind = screen.getByLabelText('第 1 項是節還是主題');
    expect([...kind.options].map(o => o.textContent)).toEqual(['節', '主題']);
    noCrash();
  });

  it('內容種類就是學生看得懂的五個字面，沒有「其他」或「練習區」', async () => {
    await openAdd();
    await click(btn(/自己建立教材/));
    await flush();
    await click(btn(/加一節／主題/));
    await flush();
    for (const label of ['課本內容', '範例', '例題']) {
      expect(btn(new RegExp(`加入${label}$`))).toBeTruthy();
    }
    expect(btn(/加入單元練習/)).toBeTruthy();
    expect(btn(/加入歷屆試題/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/其他|練習區/);
    noCrash();
  });

  it('伺服器沒有 AI 金鑰時，講學生聽得懂的話，而且不留下半本教材', async () => {
    setApi({
      '/material/import/preview': () => {
        const e = new Error('伺服器尚未設定 AI 金鑰（ANTHROPIC_API_KEY）');
        e.status = 500;
        return Promise.reject(e);
      },
    });
    await openAdd();
    // 用 PDF：圖片會先走瀏覽器的解碼／轉正，那條路在 jsdom 裡沒有實作。
    // 兩者之後走的是同一個 handler。
    const file = new File([new Uint8Array([37, 80, 68, 70])], 'toc.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type=file]');
    // jsdom 的 file input 不能直接指派 files，要自己掛上去
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { fireEvent.change(input); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeTruthy());
    const msg = screen.getByRole('alert').textContent;
    expect(msg).toContain('自己建立教材');
    expect(msg).not.toMatch(/ANTHROPIC|API_KEY|金鑰/);
    // 卡住的讀取提示要消失，而且什麼都沒建立
    expect(screen.queryByText(/AI 讀取/)).toBeNull();
    expect(sent('/material/import/commit', 'POST')).toEqual([]);
    expect(sent('/material/books', 'POST')).toEqual([]);
    noCrash();
  });

  it('取消匯入：一本教材都沒有被建立', async () => {
    await openAdd();
    await click(btn(/自己建立教材/));
    await flush();
    fireEvent.change(screen.getByLabelText('第 1 章名稱'), { target: { value: '打到一半' } });
    await click(btn(/^取消$/));
    await flush();
    expect(sent('/material/import/commit', 'POST')).toEqual([]);
    expect(sent('/material/books', 'POST')).toEqual([]);
    expect(screen.getByText('拍照／匯入教材目錄')).toBeTruthy();
    noCrash();
  });

  it('沒有名稱或沒有任何內容時建立鍵是停用的，不會送出半本教材', async () => {
    await openAdd();
    await click(btn(/自己建立教材/));
    await flush();
    expect(btn(/^建立教材$/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText('第 1 章名稱'), { target: { value: '第 1 章' } });
    await flush();
    // 有章名但一項內容都沒有 → 仍然不能建立
    expect(btn(/^建立教材$/)).toBeDisabled();
    noCrash();
  });
});

/* ============ 5. 這次選了幾項（Edit 一進來就要對） ============ */

describe('已選數量', () => {
  it('Edit 一進來就顯示正確總數，不必先打開每一本書', async () => {
    // 書單說這本已選 3 項，但一本都還沒展開過
    shelf = () => ({
      books: [{ ...fx.materialShelf.books[0], selected_count: 3 },
        { ...fx.materialShelf.books[1], selected_count: 1 }],
      counts: { material: 2, legacy: 0 },
    });
    render(<MaterialSelector planId={55} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    expect(document.querySelector('.mt-count').textContent).toBe('已選 4 項');
    noCrash();
  });

  it('Create 的草稿模式只認草稿集合，不理會別的計畫選了什麼', async () => {
    shelf = () => ({
      books: [{ ...fx.materialShelf.books[0], selected_count: 3 }],
      counts: { material: 1, legacy: 0 },
    });
    render(<MaterialSelector draftIds={new Set([101])} onDraftChange={() => {}} />);
    await waitFor(() => expect(screen.queryByText('新大滿貫')).toBeTruthy());
    expect(document.querySelector('.mt-count').textContent).toBe('已選 1 項');
    noCrash();
  });
});

/* ============ 6. Plan Detail 的教材脈絡 ============ */

describe('Plan Detail', () => {
  const PLAN = {
    id: 70, user_id: 1, name: '第一次段考', description: '', goal_id: null, primary_list_id: 1,
    start_date: fx.TODAY, target_date: fx.TODAY, status: 'active', source: 'manual',
    created_at: '', updated_at: '', completed_at: null, archived_at: null,
    task_count: 3, completed_task_count: 0,
  };
  // 教材任務的標題是「書名｜章｜節｜內容」——**沒有**科目那一段
  const mt = (id, title, extra = {}) => ({
    id, list_id: 1, plan_id: 70, title, due_date: fx.TODAY, due_time: null, priority: 0,
    completed: 0, tags: ['讀書計劃'], subtasks: [], recurring: null, deadline_date: null,
    order_index: id, deleted: 0, material_book_id: 1, material_content_item_id: id, ...extra,
  });
  const TASKS = [
    mt(81, '新大滿貫｜第 1 章 數與式｜1-1 數與數線｜課本內容'),
    mt(82, '新大滿貫｜第 1 章 數與式｜單元練習'),
    // 手動任務：完全沒有教材 linkage，仍然要正常顯示
    { ...mt(83, '買參考書'), material_book_id: null, material_content_item_id: null },
  ];

  const mount = async () => {
    setApi({ '/plans': [PLAN], '/tasks': TASKS });
    render(<PlanDetailView planKey="plan:70" tasks={TASKS} lists={fx.lists} apiPlans={[PLAN]}
      reload={() => {}} onBack={() => {}} goWizard={() => {}} adjustPlan={() => {}} />);
    await waitFor(() => expect(screen.queryByText('第一次段考')).toBeTruthy());
    await flush();
  };

  it('教材任務保留「章」，不會只剩下「單元練習」', async () => {
    await mount();
    // 舊的前綴切法會把章一起砍掉，那樣就看不出是哪一章的單元練習
    expect(screen.getByText('第 1 章 數與式｜單元練習')).toBeTruthy();
    expect(screen.getByText('第 1 章 數與式｜1-1 數與數線｜課本內容')).toBeTruthy();
    noCrash();
  });

  it('書名寫在段落標頭，一段只寫一次，不在每一列重複', async () => {
    await mount();
    expect(screen.getAllByText('新大滿貫').length).toBe(1);
    expect(document.body.textContent.match(/新大滿貫/g).length).toBe(1);
    noCrash();
  });

  it('整段只有一本書時，書名仍然要寫出來——列上已經看不到它了', async () => {
    // 只有教材任務、只有一本書：這正是「多本才顯示標頭」會漏掉的情況
    const only = TASKS.filter(t => t.material_book_id != null);
    setApi({ '/plans': [PLAN], '/tasks': only });
    render(<PlanDetailView planKey="plan:70" tasks={only} lists={fx.lists} apiPlans={[PLAN]}
      reload={() => {}} onBack={() => {}} goWizard={() => {}} adjustPlan={() => {}} />);
    await waitFor(() => expect(screen.queryByText('第一次段考')).toBeTruthy());
    await flush();
    expect(screen.getAllByText('新大滿貫').length).toBe(1);
    noCrash();
  });

  it('沒有教材 linkage 的手動任務照常顯示，不被硬塞進某一本書', async () => {
    await mount();
    expect(screen.getByText('買參考書')).toBeTruthy();
    noCrash();
  });
});
