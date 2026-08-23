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

// 一個 UTC 時間戳屬於「台灣的哪一天」。
//
// study_sessions.started_at / ended_at 存的是 UTC ISO，但整個 App 的「今天」
// 是台灣時間（todayTW）。直接 .slice(0, 10) 取 UTC 日期，凌晨 0–8 點讀的書
// 會被算到前一天去——統計上的「今天讀了多久」就會少一段、前一天多一段。
export const twDayOf = iso => (iso ? fmtDay(new Date(Date.parse(iso) + 8 * 3600e3)) : null);
