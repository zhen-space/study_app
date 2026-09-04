// 番茄鐘：StudySession 的顯示層。
//
// 這裡要釘住的全是負向行為：不得產生第二個 live session、休息不算讀書時間、
// 倒數結束不得完成任何東西、陳舊狀態不得讓已結束的 session 看起來還活著。
import { describe, it, expect } from 'vitest';
import {
  PHASES, DEFAULT_PREFS, normalizePrefs, startPhase, remainingSeconds, isPaused, isElapsed,
  pause, resume, advancePhase, reconcile, isStale, reconcileWithSession,
  loadState, saveState,
} from '../tt/pomodoro';

const T0 = 1_800_000_000_000;
const SID = 42;
const focus = (now = T0) => startPhase('focus', DEFAULT_PREFS, SID, now);

describe('偏好設定', () => {
  it('只有兩個相位', () => {
    expect(PHASES).toEqual(['focus', 'break']);
  });

  it('超出範圍或不是整數就退回預設', () => {
    expect(normalizePrefs({ focus_minutes: 50, break_minutes: 10 }))
      .toEqual({ focus_minutes: 50, break_minutes: 10 });
    expect(normalizePrefs({ focus_minutes: 0 }).focus_minutes).toBe(25);
    expect(normalizePrefs({ focus_minutes: 999 }).focus_minutes).toBe(25);
    expect(normalizePrefs({ break_minutes: 1.5 }).break_minutes).toBe(5);
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

describe('倒數', () => {
  it('存的是結束時間，不是剩餘秒數', () => {
    const s = focus();
    expect(s.phase_end_at - s.phase_started_at).toBe(25 * 60_000);
    expect(remainingSeconds(s, T0)).toBe(1500);
    expect(remainingSeconds(s, T0 + 60_000)).toBe(1440);
  });

  it('剩餘秒數不會變成負的', () => {
    expect(remainingSeconds(focus(), T0 + 99 * 60_000)).toBe(0);
    expect(isElapsed(focus(), T0 + 99 * 60_000)).toBe(true);
  });

  it('暫停凍結剩餘秒數，繼續時換算回新的結束時間', () => {
    const s = pause(focus(), T0 + 60_000);
    expect(isPaused(s)).toBe(true);
    expect(remainingSeconds(s, T0 + 10 * 60_000)).toBe(1440, '暫停期間時間流逝不扣秒數');

    const r = resume(s, T0 + 10 * 60_000);
    expect(isPaused(r)).toBe(false);
    expect(remainingSeconds(r, T0 + 10 * 60_000)).toBe(1440);
  });

  it('重複暫停或對未暫停的繼續都不會弄壞狀態', () => {
    const s = pause(focus(), T0 + 60_000);
    expect(pause(s, T0 + 120_000)).toEqual(s);
    expect(resume(focus(), T0)).toEqual(focus());
  });
});

describe('相位轉換', () => {
  it('專注結束 → 休息，並且暫停 StudySession（休息不算讀書時間）', () => {
    const out = advancePhase(focus(), T0 + 25 * 60_000);
    expect(out.state.phase).toBe('break');
    expect(out.session_action).toBe('pause');
    expect(out.state.study_session_id).toBe(SID);
  });

  it('休息結束 → 回到專注，resume 同一個 StudySession，不開新的', () => {
    const brk = startPhase('break', DEFAULT_PREFS, SID, T0);
    const out = advancePhase(brk, T0 + 5 * 60_000);
    expect(out.state.phase).toBe('focus');
    expect(out.session_action).toBe('resume');
    expect(out.state.study_session_id).toBe(SID, '必須是同一個 session');
  });

  it('一個完整循環之後 cycle_count 加一', () => {
    const a = advancePhase(focus(), T0 + 25 * 60_000).state;
    expect(a.cycle_count).toBe(1);
    const b = advancePhase(a, T0 + 30 * 60_000).state;
    expect(b.cycle_count).toBe(1, '回到專注時不重複計數');
  });

  it('相位轉換只會回 pause / resume，永遠不會 stop', () => {
    const actions = [];
    let s = focus();
    for (let i = 0; i < 6; i++) {
      const out = advancePhase(s, s.phase_end_at);
      actions.push(out.session_action);
      s = out.state;
    }
    expect(actions).toEqual(['pause', 'resume', 'pause', 'resume', 'pause', 'resume']);
    expect(actions).not.toContain('stop');
  });
});

describe('重新整理與背景恢復', () => {
  it('倒數還沒走完就什麼都不做', () => {
    const out = reconcile(focus(), T0 + 60_000);
    expect(out.session_action).toBe(null);
    expect(out.state.phase).toBe('focus');
  });

  it('在背景走完的倒數，回來時直接轉相位——不需要背景 timer', () => {
    const out = reconcile(focus(), T0 + 26 * 60_000);
    expect(out.state.phase).toBe('break');
    expect(out.session_action).toBe('pause');
  });

  it('暫停中的狀態不會因為時間流逝自己轉相位', () => {
    const s = pause(focus(), T0 + 60_000);
    const out = reconcile(s, T0 + 999 * 60_000);
    expect(out.state.phase).toBe('focus');
    expect(out.session_action).toBe(null);
  });
});

describe('陳舊的本地狀態', () => {
  const live = { id: SID, status: 'running' };

  it('對得上而且還活著就不算陳舊', () => {
    expect(isStale(focus(), live)).toBe(false);
    expect(isStale(focus(), { id: SID, status: 'paused' })).toBe(false);
  });

  it('session 不見、已結束、已取消、或根本是別的 session → 一律丟掉', () => {
    expect(isStale(focus(), null)).toBe(true);
    expect(isStale(focus(), { id: SID, status: 'completed' })).toBe(true);
    expect(isStale(focus(), { id: SID, status: 'cancelled' })).toBe(true);
    expect(isStale(focus(), { id: 999, status: 'running' })).toBe(true);
  });

  it('陳舊狀態被丟掉，不得讓已結束的 session 看起來還在跑', () => {
    const out = reconcileWithSession(focus(), { id: SID, status: 'completed' }, T0);
    expect(out.discarded).toBe(true);
    expect(out.state).toBe(null);
    expect(out.session_action).toBe(null);
  });
});

describe('本地儲存', () => {
  const mem = () => {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: k => m.delete(k),
    };
  };

  it('存得回來，清掉之後就沒了', () => {
    const st = mem();
    saveState(focus(), st);
    expect(loadState(st).study_session_id).toBe(SID);
    saveState(null, st);
    expect(loadState(st)).toBe(null);
  });

  it('壞掉或形狀不對的舊資料當作沒有，不讓它卡住畫面', () => {
    const st = mem();
    st.setItem('pomodoro_state', '{壞掉的 JSON');
    expect(loadState(st)).toBe(null);
    st.setItem('pomodoro_state', JSON.stringify({ phase: 'nap', study_session_id: 1 }));
    expect(loadState(st)).toBe(null);
    st.setItem('pomodoro_state', JSON.stringify({ phase: 'focus' }));
    expect(loadState(st)).toBe(null, '沒有 session id 就沒有意義');
  });

  it('storage 丟例外時不會壞掉（隱私模式／配額用完）', () => {
    const boom = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(loadState(boom)).toBe(null);
    expect(() => saveState(focus(), boom)).not.toThrow();
  });
});

describe('契約邊界', () => {
  it('本地狀態不含任何統計欄位——實際讀書時間只由 StudySession 說了算', () => {
    const keys = Object.keys(focus());
    expect(keys).toEqual([
      'study_session_id', 'phase', 'phase_started_at', 'phase_end_at',
      'paused_remaining_seconds', 'focus_minutes', 'break_minutes', 'cycle_count',
    ]);
    for (const forbidden of ['actual_minutes', 'total_minutes', 'studied_seconds', 'status']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('番茄鐘模組的程式碼完全不碰 Material / Plan / ScheduledBlock', async () => {
    const fs = await import('node:fs');
    const raw = fs.readFileSync('src/tt/pomodoro.js', 'utf8');
    // 註解裡本來就會提到這些名字（開頭那段正是在說明「不得碰它們」），
    // 所以先把註解拿掉再比對——要釘的是程式碼，不是說明文字。
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [/material/i, /plan_id/i, /scheduled_block/i, /schedule_version/i, /actual_minutes/i]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
