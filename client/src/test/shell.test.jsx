// 前端核心 smoke test：Phase 1 資訊架構骨架的最小安全網。
//
// 目標不是完整測試體系，是保證「五大主導航與中央主要動作點下去不會炸」。
// 之所以需要：`vite build` 只打包不執行，前一版就發生過建置全綠、
// 但按鈕一按整個爆掉（變數撞名踩到 TDZ）還照樣上線。
//
// 每個 case 都會斷言沒有 runtime exception —— 用 setup 裡攔下來的
// console.error 判斷（React 把 render 期間的例外印在那裡）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import * as fx from './fixtures';

// 所有元件都走 src/api.js 的 api()，這裡整支換掉，不打真的網路
vi.mock('../api', () => ({ api: vi.fn() }));

const { api } = await import('../api');
const Shell = (await import('../tt/Shell')).default;

// 每個 case 開始前都把 api 換回預設假資料。
// （前面版本少了這步，某個 case 把 /tasks 改成空陣列之後，
//   後面所有 case 都跟著拿到空資料——測試互相污染。）
const setApi = (over = {}) => {
  api.mockImplementation(raw => {
    // Shell 會帶 ?includeArchived=1，假資料只認得基底路徑
    const path = raw.startsWith('/plans?') ? '/plans' : raw;
    if (path in over) return Promise.resolve(over[path]);
    if (path in fx.responses) return Promise.resolve(fx.responses[path]);
    if (path.endsWith('/attachments')) return Promise.resolve([]);
    if (path.startsWith('/tasks/')) return Promise.resolve({});   // 單筆更新／刪除
    return Promise.resolve([]);
  });
};

// 攔 console.error：React 的 render 例外會走這裡，測試要能看見
let errors;
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
  localStorage.clear();
  setApi();
});
afterEach(() => { vi.restoreAllMocks(); });

const noCrash = () => {
  const real = errors.filter(e => !/not wrapped in act|validateDOMNesting|unique "key"/i.test(e));
  expect(real, '不應該有 runtime exception：\n' + real.join('\n')).toEqual([]);
};

// 掛上 Shell 並等資料載入完成。
// 大標題在資料還沒回來時就會渲染，所以光等它不夠——要再等一筆
// 真的來自 /tasks 的東西出現，否則後面的斷言會拍到載入到一半的畫面
// （CI 比本機慢，這個競態只在 CI 炸過）。
async function mountShell() {
  const r = render(<Shell onLogout={() => {}} />);
  await screen.findByRole('heading', { name: '今天' });
  await screen.findByText('買參考書');      // 今天的一般任務＝/tasks 已載入
  return r;
}
// 主內容區（跟底部導航區分開——兩邊都有「開始讀書」）
const main = () => document.querySelector('.main');
const mainButton = re => within(main()).getByRole('button', { name: re });

// 底部導航（手機五入口）。用 aria-label 抓中央主要動作，其餘用文字。
const bottomNav = () => document.querySelector('.bottom-nav');
const navButton = name =>
  name === '讀書'
    ? within(bottomNav()).getByLabelText('開始讀書')
    : within(bottomNav()).getByText(name).closest('button');

async function click(el) {
  await act(async () => { el.click(); });
}

describe('Shell / IA 骨架', () => {
  it('1. Shell 能正常 render', async () => {
    await mountShell();
    expect(bottomNav()).toBeTruthy();
    noCrash();
  });

  it('2. 預設進入 Today', async () => {
    await mountShell();
    // Today 才有的東西：進度摘要 + 開始讀書
    expect(screen.getByText('項待完成')).toBeInTheDocument();
    expect(mainButton(/開始讀書/)).toBeInTheDocument();
    expect(navButton('今天').className).toContain('on');
    noCrash();
  });

  it('3. 底部導航是今天｜計畫｜〔讀書〕｜任務｜行事曆五個入口', async () => {
    await mountShell();
    const labels = [...bottomNav().querySelectorAll('button')].map(b => b.textContent.trim());
    expect(labels).toEqual(['今天', '計畫', '讀書', '任務', '行事曆']);
    // 「讀書」必須是主要動作，不是普通分頁
    expect(navButton('讀書').className).toContain('primary');
    expect(navButton('讀書').querySelector('.primary-fab')).toBeTruthy();
    noCrash();
  });
});

describe('五大主導航都能切換', () => {
  it('今天 → 計畫 → 讀書 → 任務 → 行事曆 → 今天，全程不炸', async () => {
    await mountShell();

    await click(navButton('計畫'));
    expect(screen.getByRole('heading', { name: '計畫' })).toBeInTheDocument();

    await click(navButton('讀書'));
    expect(screen.getByRole('heading', { name: '番茄專注' })).toBeInTheDocument();

    await click(navButton('任務'));
    expect(screen.getByRole('heading', { name: '所有任務' })).toBeInTheDocument();

    await click(navButton('行事曆'));
    expect(bottomNav()).toBeTruthy();          // 日曆自己的標題會隨月份變，先確認沒崩

    await click(navButton('今天'));
    expect(screen.getByText('項待完成')).toBeInTheDocument();

    noCrash();
  });
});

describe('TodayView', () => {
  it('4. 能 render，且「開始讀書」進得了 Study', async () => {
    await mountShell();
    // 今天的固定行程有出現（/events 是另一支 API，要等它回來）
    expect(await screen.findByText('數學課')).toBeInTheDocument();
    expect(screen.getByText('接下來')).toBeInTheDocument();

    await click(mainButton(/開始讀書/));
    expect(screen.getByRole('heading', { name: '番茄專注' })).toBeInTheDocument();
    noCrash();
  });

  it('今天沒有任何任務時也不會炸', async () => {
    setApi({ '/tasks': [] });
    render(<Shell onLogout={() => {}} />);
    await screen.findByRole('heading', { name: '今天' });
    expect(screen.getByText('今天沒有排任務')).toBeInTheDocument();
    noCrash();
  });
});

describe('PlansView / PlanDetailView', () => {
  it('5. PlansView 能 render，舊資料照科目列出', async () => {
    await mountShell();
    await click(navButton('計畫'));
    // 卡片標題（legacy 的名稱就是科目名）
    const titles = [...main().querySelectorAll('.tile b')].map(b => b.textContent);
    expect(titles).toContain('物理');
    expect(titles).toContain('地科');
    expect(screen.getByRole('button', { name: /建立計畫/ })).toBeInTheDocument();
    noCrash();
  });

  it('5b. 沒有任何 Plan 時不 crash', async () => {
    setApi({ '/tasks': [] });
    render(<Shell onLogout={() => {}} />);
    await screen.findByRole('heading', { name: '今天' });
    await click(navButton('計畫'));
    expect(screen.getByText(/還沒有計畫/)).toBeInTheDocument();
    noCrash();
  });

  it('6a. 有效 planKey：點計畫卡進得了明細，同科多本書再分小段', async () => {
    await mountShell();
    await click(navButton('計畫'));
    await click([...main().querySelectorAll('.tile')].find(el => el.querySelector('b')?.textContent === '物理'));
    expect(within(main()).getByRole('heading', { name: '物理' })).toBeInTheDocument();
    expect(screen.getByText(/新大滿貫/)).toBeInTheDocument();
    expect(screen.getByText(/週攻略/)).toBeInTheDocument();
    // 回得去
    await click(screen.getByRole('button', { name: /計畫列表/ }));
    expect(screen.getByRole('heading', { name: '計畫' })).toBeInTheDocument();
    noCrash();
  });

  it('6b. 無效 planKey 不 crash，給得出提示與退路', async () => {
    const PlanDetailView = (await import('../tt/PlanDetailView')).default;
    render(<PlanDetailView planKey="不存在的科目" tasks={fx.tasks} lists={fx.lists}
      reload={() => {}} onBack={() => {}} goWizard={() => {}} />);
    expect(screen.getByText(/找不到這個計畫/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /回計畫列表/ })).toBeInTheDocument();
    noCrash();
  });
});

describe('StudyView', () => {
  it('7. 能 render 既有的 PomoView（計時器與綁定任務都在）', async () => {
    await mountShell();
    await click(navButton('讀書'));
    expect(screen.getByRole('heading', { name: '番茄專注' })).toBeInTheDocument();
    expect(screen.getByText('25:00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '開始專注' })).toBeInTheDocument();
    expect(screen.getByText('綁定任務')).toBeInTheDocument();
    noCrash();
  });
});

describe('Tasks / Calendar 主導航', () => {
  it('8. 任務頁能 render，任務有出現', async () => {
    await mountShell();
    await click(navButton('任務'));
    expect(screen.getByText('買參考書')).toBeInTheDocument();
    // 已刪除的不該出現在任務頁
    expect(screen.queryByText('已刪除的東西')).not.toBeInTheDocument();
    noCrash();
  });

  it('9. 行事曆入口能 render', async () => {
    await mountShell();
    await click(navButton('行事曆'));
    expect(navButton('行事曆').className).toContain('on');
    noCrash();
  });
});

describe('Recurring Task v1', () => {
  it('10a. 學生端不再出現重複設定的入口', async () => {
    await mountShell();
    await click(navButton('任務'));
    expect(screen.queryByText(/^🔁/)).not.toBeInTheDocument();
    expect(screen.queryByText('不重複')).not.toBeInTheDocument();
    noCrash();
  });

  it('10b. 既有的 recurring 任務（含自訂 JSON 規則）照樣顯示、不造成 crash', async () => {
    await mountShell();
    await click(navButton('任務'));
    expect(screen.getByText('每天背單字')).toBeInTheDocument();
    expect(screen.getByText('每週複習')).toBeInTheDocument();
    // 打開詳情也不能炸（RepeatPicker 被旗標藏起來，但資料還在）
    await click(screen.getByText('每週複習').closest('.trow'));
    noCrash();
  });
});

describe('既有 secondary 入口沒有因 IA 重構消失', () => {
  it('11. 排程精靈、單字本、備忘錄、矩陣、習慣、寵物、統計都還到得了', async () => {
    await mountShell();
    const side = document.querySelector('.sidebar');
    for (const name of ['排程精靈', '單字本', '備忘錄', '矩陣', '習慣', '寵物', '統計']) {
      const item = within(side).getByText(name);
      expect(item, `側邊欄應該還找得到「${name}」`).toBeTruthy();
      await click(item);
      noCrash();
    }
  });

  it('任務清單分頁（未來 7 天／願望清單／已完成／垃圾桶）都還在', async () => {
    await mountShell();
    const side = document.querySelector('.sidebar');
    for (const name of ['所有任務', '未來 7 天', '願望清單', '已完成', '垃圾桶']) {
      await click(within(side).getByText(name));
      noCrash();
    }
  });
});

describe('12. 導航回歸測試', () => {
  it('連續點過所有主導航與主要動作，都不出現 runtime exception', async () => {
    await mountShell();
    const order = ['計畫', '讀書', '任務', '行事曆', '今天', '任務', '計畫', '今天'];
    for (const n of order) {
      await click(navButton(n));
      noCrash();
    }
    // 主要動作連按兩次也不能出事
    await click(navButton('讀書'));
    await click(navButton('讀書'));
    noCrash();
  });
});
