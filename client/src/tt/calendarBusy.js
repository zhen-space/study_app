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

/* ---------- 選取的行事曆（只存 device-local）---------- */

// 使用者選了哪些裝置行事曆要納入忙碌計算。**只存本機**——calendar id 是每台裝置
// 各自的識別碼，跨裝置沒有意義，也不該送進後端。這裡不存任何標題或事件內容。
const SELECTION_KEY = 'apple_calendar_selected_ids';

export function loadSelectedCalendarIds(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(SELECTION_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    // 正規化：只留非空字串、去重；壞資料一律當空選取
    return [...new Set(raw.map(x => String(x ?? '').trim()).filter(Boolean))];
  } catch { return []; }
}

export function saveSelectedCalendarIds(ids, storage = globalThis.localStorage) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(x => String(x ?? '').trim()).filter(Boolean))];
  try { storage?.setItem(SELECTION_KEY, JSON.stringify(clean)); } catch { /* 隱私模式 */ }
  return clean;
}

// 把已經不存在（刪掉的）行事曆從選取中剔除，並回存。available 是目前 listCalendars 的結果。
export function pruneSelectedCalendarIds(available, storage = globalThis.localStorage) {
  const ok = new Set((Array.isArray(available) ? available : []).map(c => String(c?.id ?? '')));
  const kept = loadSelectedCalendarIds(storage).filter(id => ok.has(id));
  return saveSelectedCalendarIds(kept, storage);
}

/* ---------- 排程用：把選取行事曆的忙碌區間收成 external_busy ---------- */

// Study App v1「哪一天」一律是台灣時間；把排程日期範圍換成台灣日界的 ISO 邊界，
// 交給原生層去查那段時間的事件。
const TW = '+08:00';
export function dayRangeToIso(startDate, endDate) {
  return { startISO: `${startDate}T00:00:00${TW}`, endISO: `${endDate}T23:59:59${TW}` };
}

// 回傳 { external_busy, status }：
//   status: 'unsupported' | 'not_determined' | 'denied' | 'restricted'
//         | 'no_selection'（有授權但沒選任何行事曆）
//         | 'active'（有讀到，external_busy 為區間陣列，可能為空）
//         | 'unavailable'（原生層讀取失敗——本次優雅降級，不擋排程、不留快取）
//
// 硬性：Apple 是 optional 的本機來源。讀不到就 external_busy=null，排程照舊只用
// availability + Google busy；**絕不**因此讓整個 scheduler 失敗，也不謊稱已啟用。
export async function fetchExternalBusy({ startDate, endDate }, storage = globalThis.localStorage) {
  if (!isSupported()) return { external_busy: null, status: 'unsupported' };
  const state = await getPermissionState();
  if (state !== 'authorized') return { external_busy: null, status: state };
  const calendarIds = loadSelectedCalendarIds(storage);
  if (!calendarIds.length) return { external_busy: null, status: 'no_selection' };
  if (!startDate || !endDate) return { external_busy: null, status: 'no_selection' };
  try {
    const { startISO, endISO } = dayRangeToIso(startDate, endDate);
    const intervals = await getBusyIntervals({ startDate: startISO, endDate: endISO, calendarIds });
    return { external_busy: Array.isArray(intervals) ? intervals : [], status: 'active' };
  } catch {
    return { external_busy: null, status: 'unavailable' };
  }
}
