// 行事曆忙碌時段的來源介面。
//
// 排程器只想知道「哪些時間不能排」。Google 走伺服器端的 FreeBusy API，
// 裝置行事曆（iPhone/iPad 的 EventKit）只有原生層拿得到——兩者最後都要收斂成
// 同一種東西，排程器不該知道它們的差別。
//
// 這個檔案就是那條邊界。它**不假裝** browser 的 JavaScript 可以直接用 EventKit：
// 目前這個 repo 沒有原生 wrapper，所以 web 上一律回報 unsupported，
// 而且必須是「功能不存在」而不是「壞掉了」——排程要照常可用。

export const PERMISSION_STATES = ['unsupported', 'not_determined', 'authorized', 'denied', 'restricted'];

// 原生層若存在，會以這個名字掛在 window 上。介面刻意做得極窄：
// 只問權限、列行事曆、要一段時間範圍內的忙碌區間。沒有任何寫入的能力。
const bridge = () => (typeof globalThis !== 'undefined' ? globalThis.StudyAppCalendar : undefined);

export const isSupported = () => {
  const b = bridge();
  return !!(b && typeof b.getBusyIntervals === 'function');
};

export async function getPermissionState() {
  const b = bridge();
  if (!isSupported()) return 'unsupported';
  try {
    const s = await b.getPermissionState();
    return PERMISSION_STATES.includes(s) ? s : 'not_determined';
  } catch { return 'unsupported'; }
}

// 只在使用者第一次要用這個功能時才問。
// 被拒絕過就不要再問——重複跳權限視窗換不到授權，只會惹人厭；
// 那時候該做的是告訴使用者去系統設定開。
export async function requestPermission() {
  const b = bridge();
  if (!isSupported()) return 'unsupported';
  const current = await getPermissionState();
  if (current === 'denied' || current === 'restricted') return current;
  try {
    const s = await b.requestPermission();
    return PERMISSION_STATES.includes(s) ? s : 'denied';
  } catch { return 'denied'; }
}

export async function listCalendars() {
  const b = bridge();
  if (!isSupported()) return [];
  try {
    const list = await b.listCalendars();
    // 只留顯示需要的東西。行事曆裡的事件內容一概不碰。
    return (Array.isArray(list) ? list : []).map(c => ({
      id: String(c.id ?? c.identifier ?? ''),
      title: String(c.title ?? ''),
      is_hidden: !!c.is_hidden,
    })).filter(c => c.id);
  } catch { return []; }
}

// 取得 [startDate, endDate] 範圍內的忙碌區間。
//
// 回傳的東西刻意只有時間與來源——標題、地點、與會者一律不帶出來，
// 因為它接下來會被送到伺服器做排程，而排程只需要時間。
export async function getBusyIntervals({ startDate, endDate, calendarIds = null }) {
  const b = bridge();
  if (!isSupported()) return [];
  if ((await getPermissionState()) !== 'authorized') return [];
  try {
    const raw = await b.getBusyIntervals({ startDate, endDate, calendarIds });
    return (Array.isArray(raw) ? raw : [])
      // 標成 free / transparent 的事件不算忙碌（整天的「生日」之類不該擋住一整天）
      .filter(x => x && x.busy !== false && x.availability !== 'free')
      .map(x => ({ start_at: x.start_at, end_at: x.end_at, source: 'apple' }))
      .filter(x => x.start_at && x.end_at && x.end_at > x.start_at);
  } catch {
    // 拿不到就當作沒有裝置行事曆。這裡不能 fail closed 到擋住排程——
    // Google 那邊是使用者明確連結過的整合，讀不到是異常；裝置行事曆則是
    // 可有可無的加值，取不到只是少一個來源。
    return [];
  }
}

// 給 UI 用的一句話說明。unsupported 要講清楚是平台限制，不是壞了。
export function permissionMessage(state) {
  return {
    unsupported: '裝置行事曆同步目前只支援 iPhone / iPad App',
    not_determined: '尚未授權讀取裝置行事曆',
    authorized: '已授權讀取裝置行事曆',
    denied: '已拒絕存取行事曆。請到系統設定開啟權限',
    restricted: '此裝置的行事曆存取受到限制',
  }[state] || '尚未授權讀取裝置行事曆';
}
