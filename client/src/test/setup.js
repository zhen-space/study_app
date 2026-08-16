import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(cleanup);

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
