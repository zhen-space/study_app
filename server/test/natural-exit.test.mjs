// 測試跑完之後，程序要自己結束。
//
// 這一支存在的理由：CI 上出現過某個 TZ 的 job 停在「Run npm test」十幾分鐘到
// 六小時上限，而同一個 commit 的其他 TZ job 九十幾秒就通過——測試全部通過了，
// 是程序不肯結束。那種狀況下沒有任何測試會失敗，所以需要一支專門守「會不會
// 自然退出」的測試，否則下次再發生一樣看不出來。
//
// 這裡不用 --test-force-exit。用了就等於把這個問題蓋起來：程序照樣被強制結束，
// 洩漏的 handle 一樣存在，只是沒有人會發現。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 跑一個真的會開伺服器的測試檔，量它多久之後自己結束。
function runOnce(file, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    // 這一支自己就是跑在 node --test 底下，而 test runner 會給子行程設
    // NODE_TEST_CONTEXT；巢狀的 runner 讀到它會以為自己是子測試而一直等下去。
    // 清掉這幾個變數，裡面那個 runner 才會當成獨立執行。
    const env = { ...process.env };
    for (const k of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[k];
    const proc = spawn(process.execPath, ['--test', '--test-concurrency=1', file], {
      cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ timedOut: true, ms: Date.now() - started, out });
    }, timeoutMs);
    proc.on('exit', code => {
      clearTimeout(timer);
      resolve({ timedOut: false, code, ms: Date.now() - started, out });
    });
  });
}

test('開過伺服器的測試檔跑完會自己結束，不需要強制退出', async () => {
  // 這一支會走 startServer / stop 的完整路徑，是最小的代表性樣本
  const r = await runOnce('test/study-session-live-index.test.mjs', 90_000);
  assert.equal(r.timedOut, false,
    `跑完之後沒有結束（${r.ms}ms）。代表有 handle 沒關掉——通常是漏掉的測試伺服器或 libsql client。\n${r.out.slice(-2000)}`);
  assert.equal(r.code, 0);
  assert.match(r.out, /# pass \d+/);
});

test('測試腳本不得用 --test-force-exit 把不結束的問題蓋掉', () => {
  const pkg = JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
  assert.equal(/--test-force-exit/.test(pkg.scripts.test), false,
    'force-exit 只能當診斷手段，不能長期用來遮住資源洩漏');
});

test('startServer 的每一條失敗路徑都會把伺服器殺掉', () => {
  const src = readFileSync(path.join(serverDir, 'test/helpers.mjs'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  // bail() 是所有啟動失敗的共同出口，它一定要殺行程
  const bail = code.slice(code.indexOf('const bail = ()'), code.indexOf('const base = '));
  assert.ok(/killServer\(\)/.test(bail), 'bail() 必須殺掉 spawn 出來的伺服器');
  // 註冊請求必須包在 try 裡：伺服器慢啟動時它會丟連線錯誤，
  // 例外穿出去就會讓那一台沒人管
  const reg = code.slice(code.indexOf("/auth/register"), code.indexOf('const H = {'));
  assert.ok(/catch\s*\{\s*throw bail\(\)/.test(code.slice(code.indexOf('let token;'), code.indexOf('const H = {'))),
    '註冊失敗必須走 bail()');
  assert.ok(reg.length > 0);
  // stop() 除了殺行程，也要把 stdio 收掉——只 kill 不收，pipe 仍是活的 handle
  assert.ok(/proc\.stdout\?\.destroy\(\)/.test(code));
});
