// 提醒。
//
// 這是刻意做小的：沒有 service worker、沒有 push server、沒有後端排程，
// 所以提醒**只在 App 開著的時候**送得出去。與其假裝做得到背景推播，
// 不如把限制在設定頁講清楚。
//
// 之前的版本：一進 App 就無條件要通知權限，而且只有「到期時間到了」一種提醒，
// 使用者關不掉。現在每一種提醒都可以各自關掉，權限也是使用者自己按才要。

const KEY = 'notifyPrefs';

export const NOTIFY_KINDS = [
  ['due', '任務到期', '任務設定的時間到了'],
  ['upcoming', '快要開始讀書', '排定的讀書時段開始前 10 分鐘'],
  ['overdue', '有東西逾期', '每天第一次打開時，提醒還沒做完的'],
];

const DEFAULTS = { due: true, upcoming: true, overdue: true };

export function getNotifyPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    return raw && typeof raw === 'object' ? { ...DEFAULTS, ...raw } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}
export function setNotifyPrefs(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* 隱私模式 */ }
}

export function permissionState() {
  try {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;              // 'default' | 'granted' | 'denied'
  } catch { return 'unsupported'; }
}
export async function requestPermission() {
  try {
    if (typeof Notification === 'undefined') return 'unsupported';
    return await Notification.requestPermission();
  } catch { return 'denied'; }
}

// 送出一則。權限沒給、使用者關掉這一類、或瀏覽器不支援都安靜地不做事——
// 提醒送不出去絕對不能讓呼叫端壞掉。
export function notify(kind, title, body) {
  try {
    if (permissionState() !== 'granted') return false;
    if (!getNotifyPrefs()[kind]) return false;
    new Notification(title, { body, tag: `${kind}:${body}` });   // tag：同一則不重複疊
    return true;
  } catch { return false; }
}

const HM = t => (t || '').slice(0, 5);
const nowHM = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const minutesOf = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);

// 一次掃描要送哪些提醒。純函式，時間與「已經送過哪些」都由呼叫端給，
// 才測得出來——之前那版把時間、狀態、送出全部混在一個 setInterval 裡。
export function dueNotifications({ tasks = [], blocks = [], today, now = new Date(), sent = new Set() }) {
  const prefs = getNotifyPrefs();
  const hm = nowHM(now);
  const out = [];
  const push = (key, kind, title, body) => { if (!sent.has(key)) out.push({ key, kind, title, body }); };

  if (prefs.due) {
    for (const t of tasks) {
      if (t.completed || t.deleted || t.due_date !== today || !t.due_time) continue;
      if (HM(t.due_time) === hm) push(`due:${t.id}:${today}`, 'due', '任務提醒', t.title);
    }
  }
  if (prefs.upcoming) {
    const soon = minutesOf(hm) + 10;
    for (const b of blocks) {
      if (b.date !== today || !b.start_time) continue;
      // 開始前 10 分鐘那一分鐘提醒一次
      if (minutesOf(HM(b.start_time)) === soon) {
        push(`up:${b.id}:${today}`, 'upcoming', '10 分鐘後要讀書',
          `${HM(b.start_time)} ${b.task_title_snapshot || '讀書安排'}`);
      }
    }
  }
  if (prefs.overdue) {
    const n = tasks.filter(t => !t.completed && !t.deleted && t.due_date && t.due_date < today).length;
    if (n > 0) push(`od:${today}`, 'overdue', '有東西還沒做完', `${n} 項已經逾期，到「任務」看看`);
  }
  return out;
}
