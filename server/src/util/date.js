// 日期一律用「YYYY-MM-DD 字串 + UTC 運算」處理。
//
// 以前的寫法是 new Date('2026-08-08T00:00:00')（照本機時區解讀）再 .toISOString()
// （照 UTC 輸出）。在 UTC+N 的機器上（例如台灣、或 CI 設了 TZ=Asia/Taipei）
// 這兩者差一天，日期會整個往前跑，排程就會少一天甚至排不出來。
// 這裡統一成 UTC 進、UTC 出，任何時區跑起來結果都一樣。

// 'YYYY-MM-DD' → Date（UTC 零點）
export const parseDay = ds => new Date(ds + 'T00:00:00Z');
// Date → 'YYYY-MM-DD'
export const fmtDay = d => d.toISOString().slice(0, 10);
// 加減天數
export const addDays = (ds, n) => {
  const d = parseDay(ds);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDay(d);
};
// 星期幾（0=日）
export const dayOfWeek = ds => parseDay(ds).getUTCDay();
// 台灣時區的今天
export const todayTW = () => fmtDay(new Date(Date.now() + 8 * 3600e3));
