// 目錄自然排序（Natural Order）——**純函式**，不碰 DB。
//
// 為什麼需要：字串排序會把「第10課」排到「第2課」前面（1、10、2）。合併／增補
// 目錄時，新章節要放到既有章節之間的正確位置，必須靠章節序數，不能靠字串。
//
// 支援的序數寫法（涵蓋 blocker 要求）：
//   第一課／第二課／第十課、第一章／第二章、單元一／單元二、Ch1／Ch2／Ch10、
//   1、2、10（開頭阿拉伯數字或中文數字）。
//
// **fail-closed**：任何一個標題抽不出序數、或序數有重複，就不敢保證相對順序，
// 由呼叫端回 ORDER_CONFIRMATION_REQUIRED 交使用者確認，絕不硬猜。

const CN_DIGIT = {
  零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

// 中文／阿拉伯數字字串 → 整數（支援到 99：個、十、二十、二十一…）。無法解析回 null。
export function chineseToInt(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a === '' ? 1 : CN_DIGIT[a];
    const ones = b === '' || b == null ? 0 : CN_DIGIT[b];
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }
  // 純個位中文數字（一、二…九）。多字串接（非「十」式）不視為合法序數。
  if (s.length === 1 && s in CN_DIGIT) return CN_DIGIT[s];
  return null;
}

// 從標題抽出章節序數。抽不出回 null。
export function extractOrdinal(title) {
  const t = String(title ?? '').trim();
  if (!t) return null;
  const CN = '零〇一二兩三四五六七八九十';
  let m;
  // 第X課／章／節／回／講／週／單元／冊…
  m = t.match(new RegExp(`第\\s*(\\d+|[${CN}]+)\\s*[課章節回講週冊單元课节]`));
  if (m) return chineseToInt(m[1]);
  // 單元X／單元 X
  m = t.match(new RegExp(`單元\\s*(\\d+|[${CN}]+)`));
  if (m) return chineseToInt(m[1]);
  // ChX / Chapter X / Unit X / Lesson X（前綴英文）
  m = t.match(/\b(?:chapter|chap|ch|unit|lesson|part|u|l)\s*\.?\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  // 開頭阿拉伯數字：「1 力學」「1.」「1、」
  m = t.match(/^\s*(\d+)(?:\b|[.．、,])/);
  if (m) return parseInt(m[1], 10);
  // 開頭中文數字：「一、力學」「三 光」
  m = t.match(new RegExp(`^\\s*([${CN}]+)[、.\\uFF0E\\s]`));
  if (m) return chineseToInt(m[1]);
  return null;
}

// 兩個標題的自然比較：兩者都有序數就照序數；否則退回 localeCompare（穩定但不保證語意）。
export function naturalCompare(a, b) {
  const oa = extractOrdinal(a);
  const ob = extractOrdinal(b);
  if (oa != null && ob != null && oa !== ob) return oa - ob;
  return String(a).localeCompare(String(b), 'zh-Hant');
}

// 一組標題的序數是否可靠（全部抽得出、且不重複）。用來判斷能否安全排序。
export function ordinalsReliable(titles) {
  const ords = titles.map(extractOrdinal);
  if (ords.some(o => o == null)) return false;
  return new Set(ords).size === ords.length;
}

// 把新章節放到既有章節之間是否可靠：既有＋新合起來的序數必須全部可解析且互不重複。
// 不可靠 → 呼叫端回 ORDER_CONFIRMATION_REQUIRED。（既有集合內部若本來就重複／缺序數，
// 也算不可靠：我們無從得知新項該插在哪。）
export function canOrderReliably(existingTitles, newTitles) {
  return ordinalsReliable([...existingTitles, ...newTitles]);
}
