// 教材目錄匯入時「要不要刪、刪哪些」的判斷。
//
// 抽出來成模組是為了測得到。這一段是整個匯入流程裡唯一會刪資料的地方，
// 而它出過三種都會讓使用者教材消失的錯：
//
//   1. `replace !== false` —— 沒帶這個欄位就等於要刪。一支忘了帶參數的呼叫端
//      就會清掉教材。匯入一本新書是**新增**，不是取代。
//   2. `book = ? OR book = ''` —— 順手刪掉所有沒讀到書名的列，而那些很可能是
//      上一次匯入的另一本書。
//   3. 讀不到書名就整科 DELETE —— 一張模糊的第二本書照片會清掉第一本。
//
// 現在的規則只有一條可以刪：**明確要求取代，而且書名讀得出來，只刪那一本。**
// 其餘一律新增；讀不到書名又要求取代時停下來問，不猜著刪。

export const MODES = ['append', 'replace', 'refuse'];

// 回傳 { mode, book, reason }：
//   append  —— 不刪任何東西，接在後面
//   replace —— 只刪 book 這一本，其餘不動
//   refuse  —— 要求取代但沒有書名，停下來問使用者
export function planTocWrite({ replace, book }) {
  const title = String(book ?? '').trim();
  // 刻意用 === true 而不是 !== false：預設必須是「不刪」。
  if (replace !== true) return { mode: 'append', book: title, reason: null };
  if (!title) return { mode: 'refuse', book: '', reason: 'replace_requires_book' };
  return { mode: 'replace', book: title, reason: null };
}

// 取代時要刪的範圍。回傳 null 代表不刪。
//
// 範圍永遠是 (user_id, list_id, book) 三者精確相符——不含空書名、
// 不含同科的其他書、不含其他使用者。
export function deleteScope({ replace, book, userId, listId }) {
  const planned = planTocWrite({ replace, book });
  if (planned.mode !== 'replace') return null;
  return { user_id: userId, list_id: listId, book: planned.book };
}

// 這次匯入會不會動到某一列既有資料。給測試與 code review 用的明確斷言。
export function wouldDelete(existingRow, scope) {
  if (!scope) return false;
  return existingRow.user_id === scope.user_id
    && existingRow.list_id === scope.list_id
    && existingRow.book === scope.book;
}
