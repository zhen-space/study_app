// 主題：跟隨系統／淺色／深色。
//
// 顏色本身全部是 index.css 的 token，這裡只負責在 <html> 上掛一個 data-theme，
// 讓 CSS 決定要用哪一組。所以「切主題」不需要任何元件知道自己是什麼顏色，
// 也不需要 re-render 整棵樹。
//
// 'system' 是預設，而且刻意不寫 data-theme：不設屬性時，CSS 的
// prefers-color-scheme 才會生效。寫成 data-theme="system" 會讓
// :root:not([data-theme="light"]) 之外的判斷變得很難讀。

const KEY = 'theme';
export const THEMES = [
  ['system', '跟隨系統'],
  ['light', '淺色'],
  ['dark', '深色'],
];

export function getTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }         // 隱私模式讀 localStorage 會丟例外
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  // 讓瀏覽器原生控制項（下拉、日期選擇器、捲軸）跟著換，
  // 不然深色頁面上會冒出一個白色的日期面板。
  root.style.colorScheme = theme === 'system' ? 'light dark' : theme;
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* 隱私模式：這次還是要生效 */ }
  applyTheme(theme);
}

// 開 App 就先套用：等 React 掛載完才套會閃一下白底。
export function initTheme() { applyTheme(getTheme()); }
