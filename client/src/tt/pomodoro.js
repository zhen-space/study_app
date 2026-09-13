// 番茄鐘：StudySession 的計時／顯示層。
//
// 一句話的契約：**番茄鐘不是一個 domain，它是既有 StudySession 的外觀。**
// 「使用者現在有沒有在讀書」「實際讀了幾分鐘」永遠只由 StudySession 回答，
// 這裡不存 actual_minutes、不建第二個 live session、也沒有自己的 server schema。
//
// 所以這個檔案只做兩件事：
//   1. 算出「現在是專注／短休息／長休息、還剩幾秒、第幾輪」
//   2. 說出「接下來應該對 StudySession 下哪一個既有指令」（pause / resume）
//
// 真正動 StudySession 的是呼叫端，用的是既有 API。番茄鐘自己倒數到零，
// 不得完成 Material、不得完成 Task、不得結束 StudySession、不得改 Plan 選取、
// 不得動 ScheduledBlock、不得繞過 Lock——它只會把 StudySession 暫停或繼續。

export const PHASES = ['focus', 'short_break', 'long_break'];

// 預設：專注 25 分、短休息 5 分、長休息 15 分、每完成 4 個專注進一次長休息。
export const DEFAULT_PREFS = {
  focus_minutes: 25,
  short_break_minutes: 5,
  long_break_minutes: 15,
  cycles_before_long_break: 4,
};

const isBreakPhase = phase => phase === 'short_break' || phase === 'long_break';

// 偏好設定就是偏好設定，不是統計。這裡只驗範圍，不寫進任何統計來源。
// 向後相容：舊版只有 break_minutes，安全地轉成 short_break_minutes。
export function normalizePrefs(input) {
  const src = input || {};
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
  };
  const shortRaw = src.short_break_minutes != null ? src.short_break_minutes : src.break_minutes;
  return {
    focus_minutes: clamp(src.focus_minutes, 1, 180, DEFAULT_PREFS.focus_minutes),
    short_break_minutes: clamp(shortRaw, 1, 60, DEFAULT_PREFS.short_break_minutes),
    long_break_minutes: clamp(src.long_break_minutes, 1, 180, DEFAULT_PREFS.long_break_minutes),
    cycles_before_long_break: clamp(src.cycles_before_long_break, 1, 12, DEFAULT_PREFS.cycles_before_long_break),
  };
}

const phaseMinutes = (phase, p) =>
  phase === 'focus' ? p.focus_minutes : phase === 'long_break' ? p.long_break_minutes : p.short_break_minutes;

/* ---------- 狀態 ---------- */

// 本地狀態刻意只有這幾個欄位，而且**不逐秒寫入**：
// 存的是「這一段什麼時候結束」，不是「還剩幾秒」。這樣重新整理、切到背景再回來、
// 甚至關掉分頁再開，都能用同一條式子把剩餘時間算回來，不需要背景 timer。
export function startPhase(phase, prefs, studySessionId, now = Date.now(), cycleCount = 0) {
  const p = normalizePrefs(prefs);
  return {
    study_session_id: studySessionId,
    phase,
    phase_started_at: now,
    phase_end_at: now + phaseMinutes(phase, p) * 60_000,
    paused_remaining_seconds: null,
    focus_minutes: p.focus_minutes,
    short_break_minutes: p.short_break_minutes,
    long_break_minutes: p.long_break_minutes,
    cycles_before_long_break: p.cycles_before_long_break,
    cycle_count: cycleCount,
  };
}

// 剩餘秒數。暫停中就用暫停當下記下來的秒數，其餘一律現算。
export function remainingSeconds(state, now = Date.now()) {
  if (!state) return 0;
  if (state.paused_remaining_seconds != null) return Math.max(0, Math.round(state.paused_remaining_seconds));
  return Math.max(0, Math.round((state.phase_end_at - now) / 1000));
}

export const isPaused = state => !!state && state.paused_remaining_seconds != null;
export const isElapsed = (state, now = Date.now()) => remainingSeconds(state, now) <= 0;

// 暫停：把剩餘秒數凍結下來。對應的 StudySession 動作是既有的 pause。
export function pause(state, now = Date.now()) {
  if (!state || isPaused(state)) return state;
  return { ...state, paused_remaining_seconds: remainingSeconds(state, now) };
}

// 繼續：把凍結的秒數換算回新的結束時間。對應既有的 resume，**同一個 StudySession**。
export function resume(state, now = Date.now()) {
  if (!state || !isPaused(state)) return state;
  return { ...state, phase_end_at: now + state.paused_remaining_seconds * 1000, paused_remaining_seconds: null };
}

// 使用者改設定：更新偏好欄位，但**不動目前正在跑的 phase 的結束時間**。
// 新的長度只從下一個 phase 開始生效（下一次 startPhase 會讀到新值）。
export function updatePrefs(state, prefs) {
  if (!state) return state;
  const p = normalizePrefs({ ...state, ...prefs });
  return {
    ...state,
    focus_minutes: p.focus_minutes,
    short_break_minutes: p.short_break_minutes,
    long_break_minutes: p.long_break_minutes,
    cycles_before_long_break: p.cycles_before_long_break,
  };
}

/* ---------- 相位轉換 ---------- */

// 專注倒數到零 → 進休息，並且**暫停**既有 StudySession（休息不算讀書時間）。
//   ・cycle_count 是「已完成的專注數」，專注結束時 +1。
//   ・每完成 cycles_before_long_break 個專注進一次長休息，其餘進短休息。
// 休息倒數到零 → 回到專注，**resume 同一個** StudySession，不開新的；cycle_count 保留。
//
// 下一個 phase 一律從「這個 phase 真正結束的時刻（phase_end_at）」接起，
// 不是從 now 接——這樣一次跨越多個 phase 時，邊界與 cycle_count 都是確定性的。
//
// 回傳 { state, session_action }，session_action 是呼叫端要對既有 API 下的指令：
//   'pause'  → PATCH /study-sessions/:id { status:'paused' }
//   'resume' → PATCH /study-sessions/:id { status:'running' }
export function advancePhase(state) {
  if (!state) return { state: null, session_action: null };
  const at = state.phase_end_at;
  if (state.phase === 'focus') {
    const nextCycle = state.cycle_count + 1;
    const long = nextCycle % state.cycles_before_long_break === 0;
    const next = startPhase(long ? 'long_break' : 'short_break', state, state.study_session_id, at, nextCycle);
    return { state: next, session_action: 'pause' };
  }
  const next = startPhase('focus', state, state.study_session_id, at, state.cycle_count);
  return { state: next, session_action: 'resume' };
}

// 每一次 tick / 重新整理 / 從背景回來都呼叫這一支。
//
// 倒數已經走完（包括在背景走完的情況）就直接轉相位，不需要真的有 timer 在跑。
// **跨越多個 phase 也是確定性的**：一路依 phase 長度往前推，直到落在「還沒結束」的
// 那個 phase，cycle_count 只會依實際跨過的專注數增加，不會少推也不會多推。
export function reconcile(state, now = Date.now()) {
  if (!state || isPaused(state) || !isElapsed(state, now)) return { state, session_action: null };
  let cur = state;
  let action = null;
  // 每個 phase 至少 1 分鐘，guard 只是防止設定被竄改成 0 長度時卡住。
  for (let guard = 0; guard < 100_000 && !isPaused(cur) && isElapsed(cur, now); guard++) {
    const adv = advancePhase(cur);
    cur = adv.state;
    action = adv.session_action;
  }
  return { state: cur, session_action: action };
}

/* ---------- 陳舊狀態 ---------- */

// 本地狀態指向一個已經不存在、已經結束、或不是這位使用者的 StudySession 時，
// 它就只是一份過期的畫面狀態，直接丟掉。
//
// 這條很重要：番茄鐘的本地狀態永遠不能反過來讓一個已結束的 StudySession
// 看起來還活著。誰在讀書由 StudySession 說了算。
export function isStale(state, session) {
  if (!state) return false;
  if (!session) return true;
  if (Number(session.id) !== Number(state.study_session_id)) return true;
  return !['running', 'paused'].includes(session.status);
}

// 先 reconcile 出「現在應該在哪個 phase」，再對照 StudySession 目前狀態算出**淨動作**：
// 跨越多個 phase 回到專注、而 session 本來就 running 時，不重複下 resume（否則會重設
// running_since、把已讀時間弄丟）。break→running 差一格才 resume，focus→paused 才 pause。
export function reconcileWithSession(state, session, now = Date.now()) {
  if (isStale(state, session)) return { state: null, session_action: null, discarded: true };
  const r = reconcile(state, now);
  let action = r.session_action;
  if (r.state) {
    const desired = r.state.phase === 'focus' ? 'running' : 'paused';
    action = desired === session.status ? null : (desired === 'running' ? 'resume' : 'pause');
  }
  return { state: r.state, session_action: action, discarded: false };
}

/* ---------- 本地儲存 ---------- */

const KEY = 'pomodoro_state';

// 把任何一版舊狀態正規化成目前形狀；形狀不對就回 null（當作沒有）。
// 向後相容：舊的 phase 'break' → 'short_break'，舊的 break_minutes → short_break_minutes。
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const phase = raw.phase === 'break' ? 'short_break' : raw.phase;
  if (!PHASES.includes(phase) || raw.study_session_id == null) return null;
  const prefs = normalizePrefs(raw);
  const started = Number(raw.phase_started_at);
  const end = Number(raw.phase_end_at);
  const cycle = Number.isInteger(raw.cycle_count) && raw.cycle_count >= 0 ? raw.cycle_count : 0;
  const pausedRem = raw.paused_remaining_seconds != null && Number.isFinite(Number(raw.paused_remaining_seconds))
    ? Number(raw.paused_remaining_seconds) : null;
  return {
    study_session_id: raw.study_session_id,
    phase,
    phase_started_at: Number.isFinite(started) ? started : Date.now(),
    phase_end_at: Number.isFinite(end) ? end : Date.now(),
    paused_remaining_seconds: pausedRem,
    focus_minutes: prefs.focus_minutes,
    short_break_minutes: prefs.short_break_minutes,
    long_break_minutes: prefs.long_break_minutes,
    cycles_before_long_break: prefs.cycles_before_long_break,
    cycle_count: cycle,
  };
}

export function loadState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    return migrateState(JSON.parse(raw));
  } catch { return null; }
}

export function saveState(state, storage = globalThis.localStorage) {
  try {
    if (!state) storage?.removeItem(KEY);
    else storage?.setItem(KEY, JSON.stringify(state));
  } catch { /* 隱私模式或配額用完：番茄鐘顯示不準沒關係，不能因此壞掉 */ }
}

// 顯示用：目前 phase 的中文名。
export function phaseLabel(phase) {
  return phase === 'focus' ? '專注中' : phase === 'long_break' ? '長休息中' : '短休息中';
}
export { isBreakPhase };

// 偏好設定持久化（純顯示設定，不是統計、不是時間真相）：讓使用者選的長度跨 session 留著。
const PREFS_KEY = 'pomodoro_prefs';
export function loadPrefs(storage = globalThis.localStorage) {
  try { return normalizePrefs(JSON.parse(storage?.getItem(PREFS_KEY) || 'null')); }
  catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(prefs, storage = globalThis.localStorage) {
  try { storage?.setItem(PREFS_KEY, JSON.stringify(normalizePrefs(prefs))); } catch { /* 隱私模式 */ }
}
