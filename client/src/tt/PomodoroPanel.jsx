import { useEffect, useRef, useState } from 'react';
import { Button, SurfaceCard } from './ui';
import {
  startPhase, remainingSeconds, isPaused, pause, resume, updatePrefs,
  reconcileWithSession, loadState, saveState, normalizePrefs, phaseLabel,
  loadPrefs, savePrefs,
} from './pomodoro';

// 番茄鐘面板。
//
// 它**不是**另一個計時器：畫面上的倒數只是顯示，「有沒有在讀書」「讀了幾分鐘」
// 一律由既有的 StudySession 回答。這裡唯一會做的事，是在相位切換時對既有的
// StudySession API 下 pause / resume——跟使用者自己按暫停／繼續走的是同一條路。
//
// 倒數歸零不會完成任何東西：不完成 Task、不完成教材、不改 Plan、不動排程。
// 只有使用者自己按「完成本次讀書」才會結束 StudySession，那顆按鈕在外層。

const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

// 相位切換時的提醒：**只在 App 前景、且使用者已經給過權限時**送得出去。
// 不新增 Service Worker、不做背景推播、不假裝背景也會響——那是 v1 明確的範圍界線。
function notifyPhase(phase) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const body = phase === 'focus' ? '休息結束，回到專注。' : '專注結束，休息一下（休息不算讀書時間）。';
    new Notification('番茄鐘', { body });
  } catch { /* 不支援或被擋：提醒是加分，不能因此壞掉 */ }
}

export default function PomodoroPanel({ session, onSessionAction }) {
  const [state, setState] = useState(() => loadState());
  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [showSettings, setShowSettings] = useState(false);
  const [, tick] = useState(0);
  const busy = useRef(false);
  const lastPhase = useRef(state?.phase ?? null);

  const put = next => { setState(next); saveState(next); };

  // 每秒重畫一次倒數。這個 interval 純粹是為了讓畫面上的秒數會動——剩餘時間是從
  // phase_end_at 現算的，就算分頁被凍結、或使用者關掉再打開，回來一樣算得出正確秒數。
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 對照 StudySession 做相位對帳。跨越多個 phase 也是確定性的（見 pomodoro.reconcile）。
  useEffect(() => {
    if (busy.current) return;
    const out = reconcileWithSession(state, session);
    if (out.discarded) { put(null); lastPhase.current = null; return; }   // 指向已結束／不存在的 session：丟掉
    if (out.state !== state) put(out.state);
    // 前景提醒：phase 真的換了才響（背景回來一次補一響即可，不逐格洗版）
    if (out.state && out.state.phase !== lastPhase.current) {
      if (lastPhase.current !== null) notifyPhase(out.state.phase);
      lastPhase.current = out.state.phase;
    }
    if (out.session_action) {
      busy.current = true;
      Promise.resolve(onSessionAction(out.session_action)).finally(() => { busy.current = false; });
    }
  });

  if (!session || !['running', 'paused'].includes(session.status)) return null;

  // 設定：更新偏好。正在跑的 phase 結束時間不變，新長度從下一個 phase 生效（見 updatePrefs）。
  const changePref = (key, value) => {
    const nextPrefs = normalizePrefs({ ...prefs, [key]: value });
    setPrefs(nextPrefs);
    savePrefs(nextPrefs);
    if (state) put(updatePrefs(state, nextPrefs));
  };

  const settings = (
    <details className="pomo-settings" open={showSettings} onToggle={e => setShowSettings(e.target.open)} style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>設定</summary>
      <div className="ui-meta" style={{ marginTop: 6 }}>改了以後，正在進行的這一段長度不變，新長度從下一段開始。</div>
      {[
        ['focus_minutes', '專注（分）', 1, 180],
        ['short_break_minutes', '短休息（分）', 1, 60],
        ['long_break_minutes', '長休息（分）', 1, 180],
        ['cycles_before_long_break', '每幾輪長休息', 1, 12],
      ].map(([key, label, lo, hi]) => (
        <label key={key} className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
          <span style={{ minWidth: 120 }}>{label}</span>
          <input type="number" min={lo} max={hi} value={prefs[key]} aria-label={label}
            style={{ width: 72 }}
            onChange={e => changePref(key, e.target.value === '' ? '' : Number(e.target.value))} />
        </label>
      ))}
    </details>
  );

  if (!state) {
    return (
      <SurfaceCard>
        <div className="row" style={{ alignItems: 'center' }}>
          <div>
            <b>番茄鐘</b>
            <div className="ui-meta" style={{ marginTop: 2 }}>
              專注 {prefs.focus_minutes} 分、短休息 {prefs.short_break_minutes} 分、長休息 {prefs.long_break_minutes} 分（每 {prefs.cycles_before_long_break} 輪）。休息時間不算進讀書時間。
            </div>
          </div>
          <Button style={{ marginLeft: 'auto' }}
            onClick={() => { lastPhase.current = 'focus'; put(startPhase('focus', prefs, session.id, Date.now())); }}>開始番茄鐘</Button>
        </div>
        {settings}
      </SurfaceCard>
    );
  }

  const left = remainingSeconds(state);
  const focus = state.phase === 'focus';
  const done = state.cycle_count % state.cycles_before_long_break;   // 目前這一組已完成的專注數
  const progress = focus ? done + 1 : (done === 0 ? state.cycles_before_long_break : done);
  return (
    <SurfaceCard tone={focus ? 'accent' : undefined}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div>
          <b>{phaseLabel(state.phase)}　{mmss(left)}</b>
          <div className="ui-meta" style={{ marginTop: 2 }}>
            {focus ? '時間到會自動進入休息並暫停計時'
              : (state.phase === 'long_break' ? '長休息不算讀書時間，時間到會自動繼續' : '短休息不算讀書時間，時間到會自動繼續')}
            　專注 {progress} / {state.cycles_before_long_break}・已完成 {state.cycle_count} 輪
          </div>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          {isPaused(state)
            ? <Button onClick={() => put(resume(state))}>繼續</Button>
            : <Button onClick={() => put(pause(state))}>暫停番茄鐘</Button>}
          <Button onClick={() => { lastPhase.current = null; put(null); }}>關閉番茄鐘</Button>
        </div>
      </div>
      {settings}
    </SurfaceCard>
  );
}
