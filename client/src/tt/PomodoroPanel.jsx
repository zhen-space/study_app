import { useEffect, useRef, useState } from 'react';
import { Button, SurfaceCard } from './ui';
import {
  DEFAULT_PREFS, startPhase, remainingSeconds, isPaused, pause, resume,
  reconcileWithSession, loadState, saveState, normalizePrefs,
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

export default function PomodoroPanel({ session, onSessionAction }) {
  const [state, setState] = useState(() => loadState());
  const [, tick] = useState(0);
  const busy = useRef(false);

  const put = next => { setState(next); saveState(next); };

  // 每秒重畫一次倒數，並檢查相位有沒有走完。
  //
  // 這個 interval 純粹是為了讓畫面上的秒數會動——剩餘時間是從 phase_end_at 現算的，
  // 就算分頁被凍結、或使用者關掉再打開，回來一樣算得出正確的剩餘秒數。
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (busy.current) return;
    const out = reconcileWithSession(state, session);
    if (out.discarded) { put(null); return; }        // 指向已結束／不存在的 session：丟掉
    if (out.state !== state) put(out.state);
    if (out.session_action) {
      busy.current = true;
      Promise.resolve(onSessionAction(out.session_action)).finally(() => { busy.current = false; });
    }
  });

  if (!session || !['running', 'paused'].includes(session.status)) return null;

  const prefs = normalizePrefs(state || DEFAULT_PREFS);
  if (!state) {
    return (
      <SurfaceCard>
        <div className="row" style={{ alignItems: 'center' }}>
          <div>
            <b>番茄鐘</b>
            <div className="ui-meta" style={{ marginTop: 2 }}>
              專注 {prefs.focus_minutes} 分鐘、休息 {prefs.break_minutes} 分鐘。休息時間不算進讀書時間。
            </div>
          </div>
          <Button style={{ marginLeft: 'auto' }}
            onClick={() => put(startPhase('focus', prefs, session.id, Date.now()))}>開始番茄鐘</Button>
        </div>
      </SurfaceCard>
    );
  }

  const left = remainingSeconds(state);
  const focus = state.phase === 'focus';
  return (
    <SurfaceCard tone={focus ? 'accent' : undefined}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div>
          <b>{focus ? '專注中' : '休息中'}　{mmss(left)}</b>
          <div className="ui-meta" style={{ marginTop: 2 }}>
            {focus ? '時間到會自動進入休息並暫停計時' : '休息不算讀書時間，時間到會自動繼續'}
            　已完成 {state.cycle_count} 輪
          </div>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          {isPaused(state)
            ? <Button onClick={() => put(resume(state))}>繼續</Button>
            : <Button onClick={() => put(pause(state))}>暫停番茄鐘</Button>}
          <Button onClick={() => put(null)}>關閉番茄鐘</Button>
        </div>
      </div>
    </SurfaceCard>
  );
}
