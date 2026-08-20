import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(cleanup);

// Node 25 也提供了自己的 experimental localStorage；在部分執行環境它會覆蓋
// jsdom 的 Storage 並缺少 clear()。以最小、標準的 Storage mock 同時覆蓋 worker
// global 與 window，讓測試行為與瀏覽器一致且每個 worker 自己隔離。
const storage = new Map();
const testLocalStorage = {
  get length() { return storage.size; },
  key: index => [...storage.keys()][index] ?? null,
  getItem: key => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: key => storage.delete(String(key)),
  clear: () => storage.clear(),
};
vi.stubGlobal('localStorage', testLocalStorage);
Object.defineProperty(window, 'localStorage', { configurable: true, value: testLocalStorage });

// jsdom 沒有這些瀏覽器 API，元件（番茄鐘、提醒通知）會直接用到
globalThis.Notification = class {
  static permission = 'granted';
  static requestPermission() { return Promise.resolve('granted'); }
};
globalThis.AudioContext = class {
  sampleRate = 44100;
  createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
  createBufferSource() { return { buffer: null, loop: false, connect() {}, start() {}, stop() {} }; }
  createBiquadFilter() { return { type: '', frequency: { value: 0 }, connect() {} }; }
  createGain() { return { gain: { value: 0 }, connect() {} }; }
  close() {}
  get destination() { return {}; }
};
if (!window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}
// 有些流程會呼叫 confirm/alert/prompt，測試環境要有個安靜的預設
vi.spyOn(window, 'alert').mockImplementation(() => {});
vi.spyOn(window, 'confirm').mockImplementation(() => false);
vi.spyOn(window, 'prompt').mockImplementation(() => null);
