// 番茄鐘 v1：StudySession 的顯示層。3 個相位（focus / short_break / long_break）、
// cycle-based 長休息、timestamp 推導、跨背景確定性對帳、舊 state 向後相容。
//
// 釘住的全是硬契約：不得產生第二個 live session、休息一律 pause、倒數結束不得完成任何
// 東西、跨越多個 phase 的 cycle_count 不得多推、舊 localStorage 不得 crash。
import { describe, it, expect } from 'vitest';
import {
  PHASES, DEFAULT_PREFS, normalizePrefs, startPhase, remainingSeconds, isPaused, isElapsed,
  pause, resume, updatePrefs, advancePhase, reconcile, reconcileWithSession, isStale,
  loadState, saveState, migrateState,
} from '../tt/pomodoro';

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const SID = 42;
const focus = (now = T0, cycle = 0, prefs = DEFAULT_PREFS) => startPhase('focus', prefs, SID, now, cycle);
const running = { id: SID, status: 'running' };
const paused = { id: SID, status: 'paused' };

describe('偏好設定', () => {
  it('三個相位', () => {
    expect(PHASES).toEqual(['focus', 'short_break', 'long_break']);
  });

  it('M. 不合法的偏好一律正規化回預設（NaN / 負 / 超範圍 / 非整數）', () => {
    expect(normalizePrefs({ focus_minutes: 50, short_break_minutes: 10, long_break_minutes: 20, cycles_before_long_break: 3 }))
      .toEqual({ focus_minutes: 50, short_break_minutes: 10, long_break_minutes: 20, cycles_before_long_break: 3 });
    expect(normalizePrefs({ focus_minutes: 0 }).focus_minutes).toBe(25);
    expect(normalizePrefs({ focus_minutes: NaN }).focus_minutes).toBe(25);
    expect(normalizePrefs({ focus_minutes: 999 }).focus_minutes).toBe(25);
    expect(normalizePrefs({ short_break_minutes: 1.5 }).short_break_minutes).toBe(5);
    expect(normalizePrefs({ cycles_before_long_break: 0 }).cycles_before_long_break).toBe(4);
    expect(normalizePrefs({ cycles_before_long_break: -3 }).cycles_before_long_break).toBe(4);
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

describe('倒數（timestamp 推導）', () => {
  it('存的是結束時間，不是剩餘秒數', () => {
    const s = focus();
    expect(s.phase_end_at - s.phase_started_at).toBe(25 * MIN);
    expect(remainingSeconds(s, T0)).toBe(1500);
    expect(remainingSeconds(s, T0 + MIN)).toBe(1440);
  });

  it('剩餘秒數不會變成負的', () => {
    expect(remainingSeconds(focus(), T0 + 99 * MIN)).toBe(0);
    expect(isElapsed(focus(), T0 + 99 * MIN)).toBe(true);
  });

  it('暫停凍結剩餘秒數，繼續時換算回新的結束時間', () => {
    const s = pause(focus(), T0 + MIN);
    expect(isPaused(s)).toBe(true);
    expect(remainingSeconds(s, T0 + 10 * MIN)).toBe(1440);
    const r = resume(s, T0 + 10 * MIN);
    expect(isPaused(r)).toBe(false);
    expect(remainingSeconds(r, T0 + 10 * MIN)).toBe(1440);
  });

  it('G. focus 進行中重新整理：用 timestamp 算剩餘，正確', () => {
    const s = focus(T0);                       // 25 分
    const reloaded = { ...JSON.parse(JSON.stringify(s)) };   // 模擬 localStorage round-trip
    expect(remainingSeconds(reloaded, T0 + 10 * MIN)).toBe(15 * 60);
  });

  it('H. short_break 進行中重新整理：剩餘正確', () => {
    const s = startPhase('short_break', DEFAULT_PREFS, SID, T0);  // 5 分
    expect(remainingSeconds(s, T0 + 2 * MIN)).toBe(3 * 60);
  });

  it('I. long_break 進行中重新整理：剩餘正確', () => {
    const s = startPhase('long_break', DEFAULT_PREFS, SID, T0);   // 15 分
    expect(remainingSeconds(s, T0 + 6 * MIN)).toBe(9 * 60);
  });
});

describe('相位／cycle 語意', () => {
  it('A. focus → short_break，並暫停 StudySession；cycle_count +1', () => {
    const out = advancePhase(focus());
    expect(out.state.phase).toBe('short_break');
    expect(out.session_action).toBe('pause');
    expect(out.state.cycle_count).toBe(1);
    expect(out.state.study_session_id).toBe(SID);
  });

  it('B. 第 4 個 focus 完成 → long_break（cycle_count 4）', () => {
    const s = focus(T0, 3);                    // 已完成 3 個 focus，這是第 4 個
    const out = advancePhase(s);
    expect(out.state.cycle_count).toBe(4);
    expect(out.state.phase).toBe('long_break');
    expect(out.session_action).toBe('pause');
    // 前三個 focus 完成時是短休息
    for (const done of [0, 1, 2]) expect(advancePhase(focus(T0, done)).state.phase).toBe('short_break');
  });

  it('C. long_break → focus，resume 同一個 session，cycle_count 保留', () => {
    const lb = startPhase('long_break', DEFAULT_PREFS, SID, T0, 4);
    const out = advancePhase(lb);
    expect(out.state.phase).toBe('focus');
    expect(out.session_action).toBe('resume');
    expect(out.state.cycle_count).toBe(4);
    expect(out.state.study_session_id).toBe(SID);
    // long_break 之後的第 5 個 focus 完成 → 5 % 4 = 1 → 短休息
    expect(advancePhase(out.state).state.phase).toBe('short_break');
  });

  it('E. break→focus 永遠是同一個 study_session_id，不會冒出新的', () => {
    let s = focus();
    const ids = new Set();
    for (let i = 0; i < 10; i++) { const o = advancePhase(s); ids.add(o.state.study_session_id); s = o.state; }
    expect([...ids]).toEqual([SID]);
  });

  it('相位轉換只會回 pause / resume，永遠不會 stop / complete', () => {
    const actions = [];
    let s = focus();
    for (let i = 0; i < 8; i++) { const o = advancePhase(s); actions.push(o.session_action); s = o.state; }
    expect(actions.every(a => a === 'pause' || a === 'resume')).toBe(true);
    expect(actions).not.toContain('stop');
    expect(actions).not.toContain('completed');
  });

  it('N. 改設定不動目前 phase 的結束時間，新長度從下一段生效', () => {
    const s = focus(T0);                       // 目前 focus 25 分
    const s2 = updatePrefs(s, { focus_minutes: 50 });
    expect(s2.phase_end_at).toBe(s.phase_end_at);   // 目前這段不變
    expect(s2.focus_minutes).toBe(50);
    // 走完 focus → short_break → 下一個 focus 用新的 50 分
    const brk = advancePhase(s2).state;
    const nextFocus = advancePhase(brk).state;
    expect(nextFocus.phase).toBe('focus');
    expect(nextFocus.phase_end_at - nextFocus.phase_started_at).toBe(50 * MIN);
  });
});

describe('D / F：休息 = 暫停，休息不進讀書時間', () => {
  it('D. focus 走完 → StudySession pause（session 目前 running）', () => {
    const out = reconcileWithSession(focus(), running, T0 + 26 * MIN);
    expect(out.state.phase).toBe('short_break');
    expect(out.session_action).toBe('pause');
  });

  it('E2. short_break 走完 → StudySession resume（session 目前 paused），不建立新 session', () => {
    const brk = startPhase('short_break', DEFAULT_PREFS, SID, T0, 1);
    const out = reconcileWithSession(brk, paused, T0 + 6 * MIN);
    expect(out.state.phase).toBe('focus');
    expect(out.session_action).toBe('resume');
    expect(out.state.study_session_id).toBe(SID);
  });

  it('F. 本地狀態不含任何統計欄位——實際讀書時間只由 StudySession 說了算', () => {
    expect(Object.keys(focus())).toEqual([
      'study_session_id', 'phase', 'phase_started_at', 'phase_end_at', 'paused_remaining_seconds',
      'focus_minutes', 'short_break_minutes', 'long_break_minutes', 'cycles_before_long_break', 'cycle_count',
    ]);
    for (const forbidden of ['actual_minutes', 'total_minutes', 'studied_seconds', 'status']) {
      expect(Object.keys(focus())).not.toContain(forbidden);
    }
  });
});

describe('背景恢復（timestamp 對帳）', () => {
  it('倒數還沒走完就什麼都不做', () => {
    const out = reconcile(focus(), T0 + MIN);
    expect(out.session_action).toBe(null);
    expect(out.state.phase).toBe('focus');
  });

  it('J. 背景跨越單一 phase：focus → short_break', () => {
    const out = reconcile(focus(), T0 + 26 * MIN);
    expect(out.state.phase).toBe('short_break');
    expect(out.state.cycle_count).toBe(1);
    expect(out.session_action).toBe('pause');
  });

  it('K. 背景跨越多個 phase：確定性落在正確 phase，cycle_count 不多推', () => {
    // focus1(0-25) sb(25-30) focus2(30-55) sb(55-60) focus3(60-85) sb(85-90) focus4(90-115)...
    const out = reconcile(focus(T0), T0 + 100 * MIN);
    expect(out.state.phase).toBe('focus');          // 100 分落在 focus4（90–115）
    expect(out.state.cycle_count).toBe(3);          // 只完成了 focus1/2/3
    // 落點的剩餘時間也要對（focus4 到 115 分結束，現在 100 分 → 剩 15 分）
    expect(remainingSeconds(out.state, T0 + 100 * MIN)).toBe(15 * 60);
  });

  it('K2. 背景跨到 long_break 區間：cycle_count = 4、phase = long_break', () => {
    const out = reconcile(focus(T0), T0 + 120 * MIN);  // 120 分落在 long_break（115–130）
    expect(out.state.phase).toBe('long_break');
    expect(out.state.cycle_count).toBe(4);
  });

  it('暫停中的狀態不會因為時間流逝自己轉相位', () => {
    const s = pause(focus(), T0 + MIN);
    const out = reconcile(s, T0 + 999 * MIN);
    expect(out.state.phase).toBe('focus');
    expect(out.session_action).toBe(null);
  });

  it('跨多個 phase 回到 focus、而 session 本來就 running：不重複 resume（避免弄丟已讀時間）', () => {
    // focus → sb → focus，若 session 仍是 running，net 動作應為 null
    const out = reconcileWithSession(focus(T0), running, T0 + 31 * MIN);
    expect(out.state.phase).toBe('focus');
    expect(out.session_action).toBe(null);
  });
});

describe('O：陳舊的本地狀態', () => {
  it('對得上而且還活著就不算陳舊', () => {
    expect(isStale(focus(), running)).toBe(false);
    expect(isStale(focus(), paused)).toBe(false);
  });

  it('session 不見／已結束／已取消／換成別的 → 一律丟掉', () => {
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

describe('L：本地儲存與舊資料遷移', () => {
  const mem = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
  };

  it('存得回來，清掉之後就沒了', () => {
    const st = mem();
    saveState(focus(), st);
    expect(loadState(st).study_session_id).toBe(SID);
    saveState(null, st);
    expect(loadState(st)).toBe(null);
  });

  it('L. 舊 state 遷移：phase "break" → "short_break"、break_minutes → short_break_minutes', () => {
    const st = mem();
    st.setItem('pomodoro_state', JSON.stringify({
      study_session_id: SID, phase: 'break', phase_started_at: T0, phase_end_at: T0 + 8 * MIN,
      paused_remaining_seconds: null, focus_minutes: 30, break_minutes: 8, cycle_count: 2,
    }));
    const s = loadState(st);
    expect(s.phase).toBe('short_break');
    expect(s.short_break_minutes).toBe(8);
    expect(s.focus_minutes).toBe(30);
    expect(s.long_break_minutes).toBe(15);            // 舊資料沒有 → 補預設
    expect(s.cycles_before_long_break).toBe(4);
    expect(s.cycle_count).toBe(2);
  });

  it('壞掉或形狀不對的舊資料當作沒有，不讓它卡住畫面（不 crash）', () => {
    const st = mem();
    st.setItem('pomodoro_state', '{壞掉的 JSON');
    expect(loadState(st)).toBe(null);
    st.setItem('pomodoro_state', JSON.stringify({ phase: 'nap', study_session_id: 1 }));
    expect(loadState(st)).toBe(null);
    st.setItem('pomodoro_state', JSON.stringify({ phase: 'focus' }));   // 沒 session id
    expect(loadState(st)).toBe(null);
    expect(migrateState(null)).toBe(null);
  });

  it('storage 丟例外時不會壞掉（隱私模式／配額用完）', () => {
    const boom = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(loadState(boom)).toBe(null);
    expect(() => saveState(focus(), boom)).not.toThrow();
  });
});

describe('P：契約邊界——倒數歸零不完成任何東西', () => {
  it('番茄鐘模組完全不碰 Task / Material / Plan / ScheduledBlock / Lock / ScheduleVersion / actual_minutes', async () => {
    const fs = await import('node:fs');
    const raw = fs.readFileSync('src/tt/pomodoro.js', 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [/material/i, /plan_id/i, /scheduled_block/i, /schedule_version/i, /actual_minutes/i, /\block\b/i, /\btask_id\b/i]) {
      expect(code).not.toMatch(forbidden);
    }
  });

  it('advancePhase 永不回結束類動作（complete / cancel / stop）', () => {
    let s = focus();
    for (let i = 0; i < 12; i++) {
      const o = advancePhase(s);
      expect(['pause', 'resume']).toContain(o.session_action);
      s = o.state;
    }
  });
});
