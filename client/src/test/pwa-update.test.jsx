import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const serviceWorker = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');

describe('PWA 更新機制', () => {
  it('首頁與 Service Worker 使用同一個版本，換版會淘汰舊快取', () => {
    const pageVersion = indexHtml.match(/const SW_VERSION = '([^']+)'/)?.[1];
    const cacheVersion = serviceWorker.match(/const CACHE = '([^']+)'/)?.[1];

    expect(pageVersion).toBeTruthy();
    expect(pageVersion).toBe(cacheVersion);
    expect(pageVersion).not.toBe('tt-v7');
  });

  it('先監聽更新再檢查新版，並以版本而非永久布林值限制重載', () => {
    const listenAt = indexHtml.indexOf("reg.addEventListener('updatefound'");
    const updateAt = indexHtml.indexOf('void reg.update()');

    expect(listenAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(listenAt);
    expect(indexHtml).toContain("const SW_RELOAD_KEY = 'swReloadedVersion'");
    expect(indexHtml).toContain('sessionStorage.getItem(SW_RELOAD_KEY) === SW_VERSION');
    expect(indexHtml).toContain('sessionStorage.setItem(SW_RELOAD_KEY, SW_VERSION)');
    expect(indexHtml).not.toContain("sessionStorage.getItem('swReloaded')");
  });

  it('更新完成事件與控制權切換共用同一個安全重載入口', () => {
    expect(indexHtml).toContain("worker.state === 'activated') reloadForSwVersion()");
    expect(indexHtml).toContain("navigator.serviceWorker.addEventListener('controllerchange', reloadForSwVersion)");
  });
});
