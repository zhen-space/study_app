// 真實 Chrome 375px 驗證（手動執行，不在 CI）：計畫明細的依日期／依科目切換、已有日期任務的
// 改日期、長按拖曳、重新整理後仍保留、權威刷新失敗時鎖定與重試，以及沒有水平溢位。
//
// 不把 playwright-core 加進專案依賴；需要時另外安裝並用環境變數指定位置：
//   npm i --prefix /tmp/pw playwright-core@1.47.2
//   (cd client && npm run build)
//   PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core \
//   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//   SHOT_DIR=/tmp/shots node client/scripts/verify-plan-detail-375.mjs
//
// 會用暫存 SQLite 起一台只給這次驗證用的後端（伺服器同時提供 client/dist），不碰任何正式資料。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (!process.env.PLAYWRIGHT_CORE) {
  console.error('請以 PLAYWRIGHT_CORE 指定 playwright-core 的目錄（見檔頭說明）。');
  process.exit(2);
}
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE);
const { createClient } = createRequire(path.join(repo, 'server', 'package.json'))('@libsql/client');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = process.env.SHOT_DIR || mkdtempSync(path.join(tmpdir(), 'verify-375-shots-'));
mkdirSync(shotDir, { recursive: true });

// 台灣時區的相對日期（與伺服器 todayTW 一致）。
const day = n => {
  const d = new Date(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const md = d => `${+d.slice(5, 7)}/${+d.slice(8)}`;

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); };

const port = 3900 + Math.floor(Math.random() * 90);
const dbFile = path.join(mkdtempSync(path.join(tmpdir(), 'verify-375-')), 'db.sqlite');
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: path.join(repo, 'server'),
  env: { ...process.env, PORT: String(port), DB_FILE: dbFile, JWT_SECRET: 'verify-375', TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
const base = `http://127.0.0.1:${port}`;

let browser;
let db;
try {
  for (let i = 0; i < 300; i++) {
    try { const r = await fetch(base + '/api/auth/me'); if (r.status) break; } catch { await new Promise(r => setTimeout(r, 100)); }
    if (i === 299) throw new Error(`測試伺服器未在 30 秒內啟動：\n${serverLog.slice(-1500)}`);
  }
  const { token } = await (await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'verify@t.local', password: '12345678', name: '驗證' }),
  })).json();

  // 種子：一個進行中計畫；前天排過但沒做（已逾期、active 版本已無安排）、明天有一段安排、從沒排過。
  db = createClient({ url: 'file:' + dbFile });
  const uid = Number((await db.execute('SELECT id FROM users LIMIT 1')).rows[0].id);
  const list = Number((await db.execute({ sql: "INSERT INTO lists (user_id,name,color) VALUES (?,'數學','#0086CC')", args: [uid] })).lastInsertRowid);
  const planId = Number((await db.execute({ sql: "INSERT INTO plans (user_id,name,status,start_date,target_date) VALUES (?,'段考驗證','active',?,?)", args: [uid, day(-5), day(14)] })).lastInsertRowid);
  const mk = async (title, due) => Number((await db.execute({
    sql: 'INSERT INTO tasks (user_id,list_id,title,plan_id,due_date,estimated_minutes) VALUES (?,?,?,?,?,60)',
    args: [uid, list, title, planId, due],
  })).lastInsertRowid);
  const overdue = await mk('前天的進度一個很長很長的標題用來測試三百七十五寬度會不會擠壓', null);
  const dated = await mk('明天的進度', day(1));
  await mk('從沒排過', null);
  const version = async (no, blocks) => {
    const v = Number((await db.execute({
      sql: "INSERT INTO schedule_versions (user_id,version_no,source,effective_from,block_count) VALUES (?,?,'initial',?,?)",
      args: [uid, no, day(-3), blocks.length],
    })).lastInsertRowid);
    for (const [t, d] of blocks) await db.execute({ sql: 'INSERT INTO scheduled_blocks (user_id,schedule_version_id,task_id,date) VALUES (?,?,?,?)', args: [uid, v, t, d] });
    return v;
  };
  await version(1, [[overdue, day(-2)], [dated, day(1)]]);
  const active = await version(2, [[dated, day(1)]]);
  await db.execute({ sql: 'INSERT OR REPLACE INTO user_schedule_state (user_id,active_version_id) VALUES (?,?)', args: [uid, active] });
  const dueOf = async id => (await db.execute({ sql: 'SELECT due_date FROM tasks WHERE id=?', args: [id] })).rows[0].due_date;
  // 畫面會先樂觀顯示新位置；資料庫要等伺服器交易完成，輪詢到預期值或逾時。
  const waitDue = async (id, want) => {
    let got;
    for (let i = 0; i < 50; i++) {
      try { got = await dueOf(id); }
      catch (error) { if (error.code !== 'SQLITE_BUSY') throw error; }
      if (got === want) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return got;
  };
  const activeVersion = async () => Number((await db.execute({ sql: 'SELECT active_version_id FROM user_schedule_state WHERE user_id=?', args: [uid] })).rows[0].active_version_id);

  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  await ctx.addInitScript(t => { localStorage.setItem('token', t); }, token);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const manual = [];
  const taskPatches = [];
  page.on('request', r => {
    if (r.url().includes('/api/schedule/manual')) manual.push(r.postDataJSON());
    if (r.method() === 'PATCH' && /\/api\/tasks\/\d+/.test(r.url())) taskPatches.push(r.url());
  });
  // 水平溢位：文件寬度不得超過視窗，也不得有任何可見元素超出右緣。
  const overflow = () => page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll('body *')].filter(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !el.closest('.sr-only') && r.right > vw + 0.5;
    }).slice(0, 5).map(el => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80));
    return { scrollWidth: document.documentElement.scrollWidth, vw, over };
  });
  const noOverflow = async name => {
    const o = await overflow();
    check(`${name}：沒有水平溢位`, o.scrollWidth <= o.vw && !o.over.length, JSON.stringify(o));
  };
  const scheduleCard = () => page.getByText('目前生效的確切安排').locator('..').locator('..');
  const scheduleRegion = name => scheduleCard().getByRole('region', { name });
  const openPlan = async () => {
    await page.goto(base + '/?go=plans');
    await page.getByText('段考驗證').first().click();
    await page.getByRole('tablist', { name: '日期安排分區' }).waitFor();
  };

  // ① 依日期／依科目切換直接位於「日期安排」卡片，不靠捲到頁底才找到
  await openPlan();
  const toggle = scheduleCard().getByRole('tablist', { name: '日期安排分區' });
  check('切換位於日期安排卡片且可見', await toggle.isVisible());
  check('預設依科目', await toggle.getByRole('tab', { name: '依科目' }).getAttribute('aria-selected') === 'true');
  check('依科目：實際按科目分區', await scheduleRegion('數學安排').getByText(/前天的進度/).isVisible()
    && await scheduleRegion('數學安排').getByText('從沒排過').isVisible());
  await noOverflow('依科目');
  await page.screenshot({ path: path.join(shotDir, '1-subject.png'), fullPage: true });
  await toggle.getByRole('tab', { name: '依日期' }).click();
  check('切到依日期', await toggle.getByRole('tab', { name: '依日期' }).getAttribute('aria-selected') === 'true');
  check('依日期：明天的任務在日期分區', await scheduleRegion(`${md(day(1))}安排`).getByText('明天的進度').isVisible());
  await noOverflow('依日期');
  await page.screenshot({ path: path.join(shotDir, '2-date.png'), fullPage: true });

  // ② 已有日期的任務：用「改日期」按鈕（不靠長按）
  const target = day(5);
  await scheduleCard().getByRole('button', { name: '改「明天的進度」的日期' }).click();
  const sheet = page.getByRole('dialog', { name: '移到其他日期' });
  await sheet.waitFor();
  await noOverflow('日期選擇器');
  await page.screenshot({ path: path.join(shotDir, '3-picker.png') });
  await sheet.getByLabel('日期').fill(target);
  await sheet.getByRole('button', { name: '移到這一天' }).click();
  await sheet.waitFor({ state: 'detached' });
  await scheduleRegion(`${md(target)}安排`).getByText('明天的進度').waitFor();
  const datedDue = await waitDue(dated, target);
  check('改日期：資料庫 due_date 更新', datedDue === target, datedDue);
  check('改日期：只走 manual transaction（block_id）', manual.length === 1 && manual[0].moves[0].block_id != null && manual[0].moves[0].date === target, JSON.stringify(manual));
  const status = await page.getByRole('status').filter({ hasText: '已把' }).textContent().catch(() => '');
  check('改日期：live region 宣告結果', status.includes(`移到 ${md(target)}`), status);

  // ③ 長按拖曳：已逾期 → 明天
  const row = scheduleCard().getByText(/前天的進度/);
  const box = await row.boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const sx = box.x + 20;
  const sy = box.y + box.height / 2;
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
  await page.waitForTimeout(700);
  const overlayHidden = await page.getByText('拖到要移動的日期分區後放開').evaluate(el => el.closest('[aria-hidden="true"]') != null).catch(() => false);
  check('長按：拖曳提示出現且 overlay 為 aria-hidden', overlayHidden);
  const zone = page.locator(`[aria-hidden="true"] [data-drop-date="${day(1)}"]`);
  const zb = await zone.boundingBox();
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + (zb.x + zb.width / 2 - sx) * i / 8, y: sy + (zb.y + zb.height / 2 - sy) * i / 8 }] });
    await page.waitForTimeout(30);
  }
  check('長按：拖曳中頁面不捲動', (await page.evaluate(() => window.scrollY)) === scrollBefore);
  await noOverflow('拖曳中');
  await page.screenshot({ path: path.join(shotDir, '4-dragging.png') });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await scheduleCard().getByText(/前天的進度/).waitFor();
  const overdueDue = await waitDue(overdue, day(1));
  check('長按：資料庫 due_date 變成明天', overdueDue === day(1), String(overdueDue));
  check('長按：以 task_id 重新加入，不 PATCH due_date', manual.length === 2 && manual[1].moves[0].task_id === overdue && taskPatches.length === 0, JSON.stringify(manual));

  // ④ 重新整理後仍保留
  const versionAfterMoves = await activeVersion();
  // 整頁重新載入：App 不把目前畫面記在網址，重新載入後回到計畫明細（使用者也是這樣走）。
  await page.reload();
  await page.waitForLoadState('networkidle');
  await openPlan();
  check('重新整理：仍是依日期', await scheduleCard().getByRole('tab', { name: '依日期' }).getAttribute('aria-selected') === 'true');
  check('重新整理：已逾期消失、任務在明天', await scheduleCard().getByText('已逾期（1）').count() === 0
    && await scheduleRegion(`${md(day(1))}安排`).getByText(/前天的進度/).isVisible());
  check('重新整理：改日期的任務仍在新日期', await scheduleRegion(`${md(target)}安排`).getByText('明天的進度').isVisible());
  await noOverflow('重新整理後');
  await page.screenshot({ path: path.join(shotDir, '5-after-reload.png'), fullPage: true });

  // ⑤ 權威刷新失敗：寫入成功、active 版本讀不到 → 鎖定；重試仍失敗維持；恢復後重試解鎖
  let failActive = false;
  await page.route('**/api/schedule/active', route => (failActive ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"暫時無法載入"}' }) : route.continue()));
  failActive = true;
  await scheduleCard().getByRole('button', { name: '替「從沒排過」選擇日期' }).click();
  await sheet.waitFor();
  await sheet.getByLabel('日期').fill(day(3));
  await sheet.getByRole('button', { name: '移到這一天' }).click();
  const banner = page.getByText('日期已更新，但最新安排暫時無法載入', { exact: true });
  await banner.waitFor();
  check('刷新失敗：寫入已提交', await activeVersion() === versionAfterMoves + 1);
  check('刷新失敗：鎖定（沒有任何改日期按鈕）', await page.getByRole('button', { name: /^改「|^替「/ }).count() === 0);
  await noOverflow('鎖定中');
  await page.screenshot({ path: path.join(shotDir, '6-locked.png'), fullPage: true });
  const retry = page.getByRole('button', { name: '重新載入確認' });
  await retry.click();
  await page.getByText('暫時無法載入').first().waitFor();
  await page.waitForTimeout(300);
  check('重試仍失敗：維持鎖定', await banner.isVisible() && await page.getByRole('button', { name: /^改「|^替「/ }).count() === 0);
  failActive = false;
  await retry.click();
  await banner.waitFor({ state: 'detached' });
  check('重試成功：解鎖、改日期按鈕回來', await page.getByRole('button', { name: /^改「|^替「/ }).count() > 0);
  check('重試成功：沒有重送寫入', manual.length === 3, JSON.stringify(manual.length));

  // ⑥ 任務清單：依日期／依科目切換可見、沒有水平溢位
  await page.goto(base + '/?go=tasks');
  const taskToggle = page.getByRole('tablist', { name: '分區方式' });
  await taskToggle.waitFor();
  check('任務清單：切換可見', await taskToggle.isVisible());
  await noOverflow('任務清單依日期');
  await taskToggle.getByRole('tab', { name: '依科目' }).click();
  await noOverflow('任務清單依科目');
  await page.screenshot({ path: path.join(shotDir, '7-tasks-subject.png'), fullPage: true });

  check('沒有頁面錯誤', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  check('腳本執行完成', false, String(e.stack || e) + '\n' + serverLog.slice(-1500));
} finally {
  db?.close();
  await browser?.close();
  server.kill('SIGKILL');
}

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : `\n      ${c.detail}`}`);
console.log(`\n截圖：${shotDir}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
