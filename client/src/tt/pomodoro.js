// 番茄鐘：StudySession 的計時／顯示層。
//
// 一句話的契約：**番茄鐘不是一個 domain，它是既有 StudySession 的外觀。**
// 「使用者現在有沒有在讀書」「實際讀了幾分鐘」永遠只由 StudySession 回答，
// 這裡不存 actual_minutes、不建第二個 live session、也沒有自己的 server schema。
//
// 所以這個檔案只做兩件事：
//   1. 算出「現在是專注還是休息、還剩幾秒」
//   2. 說出「接下來應該對 StudySession 下哪一個既有指令」（start/pause/resume/stop）
//
// 真正動 StudySession 的是呼叫端，用的是既有 API。番茄鐘自己倒數到零，
// 不得完成 Material、不得完成 Task、不得改 Plan 選取、不得動 ScheduledBlock、
// 不得繞過 Lock——它只會把 StudySession 暫停下來。

export const PHASES = ['focus', 'break'];

export const DEFAULT_PREFS = { focus_minutes: 25, break_minutes: 5 };

// 偏好設定就是偏好設定，不是統計。這裡只驗範圍，不寫進任何統計來源。
export function normalizePrefs(input) {
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
  };
  return {
    focus_minutes: clamp(input?.focus_minutes, 1, 180, DEFAULT_PREFS.focus_minutes),
    break_minutes: clamp(input?.break_minutes, 1, 60, DEFAULT_PREFS.break_minutes),
  };
}

/* ---------- 狀態 ---------- */

// 本地狀態刻意只有這幾個欄位，而且**不逐秒寫入**：
// 存的是「這一段什麼時候結束」，不是「還剩幾秒」。這樣重新整理、切到背景再回來、
// 甚至關掉分頁再開，都能用同一條式子把剩餘時間算回來，不需要背景 timer。
export function startPhase(phase, prefs, studySessionId, now = Date.now(), cycleCount = 0) {
  const p = normalizePrefs(prefs);
  const minutes = phase === 'break' ? p.break_minutes : p.focus_minutes;
  return {
    study_session_id: studySessionId,
    phase,
    phase_started_at: now,
    phase_end_at: now + minutes * 60_000,
    paused_remaining_seconds: null,
    focus_minutes: p.focus_minutes,
    break_minutes: p.break_minutes,
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

/* ---------- 相位轉換 ---------- */

// 專注倒數到零 → 進休息，並且**暫停**既有 StudySession（休息不算讀書時間）。
// 休息倒數到零 → 回到專注，**resume 同一個** StudySession，不開新的。
//
// 回傳 { state, session_action }，session_action 是呼叫端要對既有 API 下的指令：
//   'pause'  → POST /study-sessions/:id/pause
//   'resume' → POST /study-sessions/:id/resume
//   null     → 不動 StudySession
export function advancePhase(state, now = Date.now()) {
  if (!state) return { state: null, session_action: null };
  if (state.phase === 'focus') {
    const next = startPhase('break', state, state.study_session_id, now, state.cycle_count + 1);
    return { state: next, session_action: 'pause' };
  }
  const next = startPhase('focus', state, state.study_session_id, now, state.cycle_count);
  return { state: next, session_action: 'resume' };
}

// 每一次 tick / 重新整理 / 從背景回來都呼叫這一支。
// 倒數已經走完（包括在背景走完的情況）就直接轉相位，不需要真的有 timer 在跑。
export function reconcile(state, now = Date.now()) {
  if (!state || isPaused(state) || !isElapsed(state, now)) return { state, session_action: null };
  return advancePhase(state, now);
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

export function reconcileWithSession(state, session, now = Date.now()) {
  if (isStale(state, session)) return { state: null, session_action: null, discarded: true };
  return { ...reconcile(state, now), discarded: false };
}

/* ---------- 本地儲存 ---------- */

const KEY = 'pomodoro_state';

export function loadState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // 形狀不對就當沒有，不要讓壞掉的舊資料卡住畫面
    if (!s || !PHASES.includes(s.phase) || !s.study_session_id) return null;
    return s;
  } catch { return null; }
}

export function saveState(state, storage = globalThis.localStorage) {
  try {
    if (!state) storage?.removeItem(KEY);
    else storage?.setItem(KEY, JSON.stringify(state));
  } catch { /* 隱私模式或配額用完：番茄鐘顯示不準沒關係，不能因此壞掉 */ }
}
