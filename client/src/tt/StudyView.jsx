import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';
import { Button, PageHeader, SurfaceCard, EmptyState, BottomSheet } from './ui';
import PomodoroPanel from './PomodoroPanel';

// 「讀書」＝中央主要動作：現在就開始一段讀書。
//
// StudySession 是實際讀書時間的單一來源。從 Today／Calendar 的 ScheduledBlock
// 啟動時會保留 scheduled_block_id；在這個頁面直接選一般 Task 則是 manual session。
// 舊 pomo 僅保留歷史相容資料，不再另外提供第二套計時器狀態。

// 這一頁只放得下幾筆，所以「放哪幾筆」就是這一頁的全部價值：
// 該讀的是逾期的、今天的、最近的，不是排在最後面的那幾項。
// GET /tasks 是照新到舊回傳的，直接切前幾筆會剛好切到最遠的未來——
// 學生看到的會是下週的內容，今天要做的那一項反而被擠掉。
const MAX_ROWS = 8;
export function pickStudyTasks(tasks, td = today(), limit = MAX_ROWS) {
  const rank = t => (!t.due_date ? 2 : t.due_date < td ? 0 : 1);   // 逾期 → 有日期 → 沒日期
  return tasks
    .filter(t => !t.completed && !t.deleted)
    .sort((a, b) =>
      rank(a) - rank(b)
      || (a.due_date || '9999-99-99').localeCompare(b.due_date || '9999-99-99')
      || (a.due_time || '99:99').localeCompare(b.due_time || '99:99')
      || a.id - b.id)
    .slice(0, limit);
}

const dueLabel = (t, td) => {
  if (!t.due_date) return '尚未安排';
  const hm = t.due_time ? ' ' + t.due_time.slice(0, 5) : '';
  if (t.due_date < td) return `逾期 ${t.due_date.slice(5)}${hm}`;
  if (t.due_date === td) return `今天${hm}`;
  return t.due_date.slice(5) + hm;
};

// 補登：真的讀了，只是當下沒開計時器。它是正式的讀書紀錄，分鐘數會進統計；
// 但它不是「正在讀」，所以不會有計時器的中間狀態，也不會把教材標成完成。
function BackfillSheet({ tasks, onClose, onDone }) {
  const [taskId, setTaskId] = useState(tasks[0] ? String(tasks[0].id) : '');
  const [date, setDate] = useState(today());
  const [start, setStart] = useState('19:00');
  const [minutes, setMinutes] = useState('60');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api('/study-sessions/backfill', {
        method: 'POST',
        body: { task_id: Number(taskId), date, start_time: start, minutes: Number(minutes) },
      });
      onDone();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <BottomSheet onClose={onClose} label="補登讀書時間">
      <b style={{ fontSize: 17 }}>補登讀書時間</b>
      <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
        之前讀了但忘記計時，補記進來。會算進讀書時間統計，但不會把教材標成完成。
      </div>
      {err && <div className="error" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}

      <label className="ui-meta" htmlFor="bf-task" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>讀的是</label>
      <select id="bf-task" aria-label="讀的是" value={taskId} style={{ width: '100%' }}
        onChange={e => setTaskId(e.target.value)}>
        {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
      </select>

      <div className="row" style={{ marginTop: 'var(--sp-4)', alignItems: 'flex-end' }}>
        <span style={{ flex: 1 }}>
          <label className="ui-meta" htmlFor="bf-date">日期</label>
          <input id="bf-date" type="date" aria-label="日期" value={date} max={today()}
            style={{ width: '100%' }} onChange={e => setDate(e.target.value)} />
        </span>
        <span style={{ flex: 1 }}>
          <label className="ui-meta" htmlFor="bf-start">從幾點開始</label>
          <input id="bf-start" type="time" aria-label="從幾點開始" value={start}
            style={{ width: '100%' }} onChange={e => setStart(e.target.value)} />
        </span>
      </div>

      <label className="ui-meta" htmlFor="bf-min" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>讀了幾分鐘</label>
      <input id="bf-min" type="number" min="1" max="1440" aria-label="讀了幾分鐘" value={minutes}
        style={{ width: '100%' }} onChange={e => setMinutes(e.target.value)} />
      <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-2)', flexWrap: 'wrap' }}>
        {[25, 30, 45, 60, 90, 120].map(m => (
          <button key={m} type="button" className="md-add-pill" onClick={() => setMinutes(String(m))}>{m} 分</button>
        ))}
      </div>

      <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" style={{ marginLeft: 'auto' }}
          disabled={busy || !taskId || !(Number(minutes) > 0)}
          onClick={submit}>{busy ? '補登中…' : '補登'}</Button>
      </div>
    </BottomSheet>
  );
}

export default function StudyView({ tasks, goPlans }) {
  const [backfill, setBackfill] = useState(false);
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/study-sessions').then(rows => setSession(rows.find(x => x.status === 'running') || rows.find(x => x.status === 'paused') || null)).catch(() => {}); }, []);
  const start = async task => { try { setError(''); setSession(await api('/study-sessions', { method: 'POST', body: { task_id: task.id, source: 'manual' } })); } catch (e) { setError(e.message); } };
  const end = async status => { try { setError(''); setSession(await api(`/study-sessions/${session.id}`, { method: 'PATCH', body: { status } })); } catch (e) { setError(e.message); } };
  const active = session?.status === 'running';
  const paused = session?.status === 'paused';
  const titleOf = s => s?.task_title || tasks.find(t => Number(t.id) === Number(s?.task_id))?.title || '讀書任務';
  const td = today();
  const pick = pickStudyTasks(tasks, td);
  const [doneMsg, setDoneMsg] = useState('');
  // 補登可以補到任何還沒完成的任務，不受首頁那份「最該做的幾項」上限影響
  const candidates = pickStudyTasks(tasks, td, Infinity);
  return <div className="main"><PageHeader title="讀書" subtitle="記下實際讀書時間，之後可比較原定安排與實際進度" />
    <div className="main-body">{error && <SurfaceCard tone="warning">{error}</SurfaceCard>}
      {/* 番茄鐘只是這一段 StudySession 的計時外觀：相位切換時走的是下面同一組
          pause / resume，不會另外開一個 session，也不會結束它。 */}
      {session && <PomodoroPanel session={session} onSessionAction={a => end(a === 'pause' ? 'paused' : 'running')} />}
      {active ? <SurfaceCard tone="accent"><b>正在讀書：{titleOf(session)}</b><div className="ui-meta" style={{ marginTop: 4 }}>開始於 {new Date(session.started_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</div><div className="row" style={{ marginTop: 12 }}><Button onClick={() => end('paused')}>暫停</Button><Button variant="primary" style={{ marginLeft: 'auto' }} onClick={() => end('completed')}>完成本次讀書</Button></div></SurfaceCard>
        : paused ? <SurfaceCard tone="accent"><b>讀書已暫停：{titleOf(session)}</b><div className="ui-meta" style={{ marginTop: 4 }}>已累積 {session.actual_minutes || 0} 分鐘</div><div className="row" style={{ marginTop: 12 }}><Button variant="primary" onClick={() => end('running')}>繼續讀書</Button><Button style={{ marginLeft: 'auto' }} onClick={() => end('completed')}>結束本次讀書</Button></div></SurfaceCard>
        // 一項任務都沒有的時候，「選一個尚未完成的任務」底下空空如也——
        // 中央主要動作不能是一條死路，要說得出下一步在哪裡。
        : pick.length === 0 ? <EmptyState
            title="還沒有可以讀的任務"
            description="先建立一個讀書計畫，AI 會把教材內容排成每天的任務；也可以到「任務」自己加一項。"
            action={goPlans && <Button variant="primary" size="lg" onClick={goPlans}>建立讀書計畫</Button>} />
        : <SurfaceCard><b>開始一段讀書</b><div className="ui-meta" style={{ marginTop: 4 }}>照時間先後列出最該做的幾項。</div>{pick.map(t => <div className="ui-row" key={t.id}><div className="ui-row-main"><div className="ui-row-title">{t.title}</div><div className="ui-row-sub" style={t.due_date && t.due_date < td ? { color: 'var(--danger)' } : undefined}>{dueLabel(t, td)}</div></div><Button size="sm" variant="primary" onClick={() => start(t)}>開始</Button></div>)}</SurfaceCard>}
      {/* 補登不受「正在讀」影響：它記的是已經讀完的事，任何時候都補得了。
          沒有任何任務時就沒得補，那時的出口是上面的空狀態。 */}
      {candidates.length > 0 && (
        <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
          <Button size="sm" variant="tertiary" onClick={() => setBackfill(true)}>
            之前讀了忘記計時？補登
          </Button>
        </div>
      )}
      {backfill && (
        <BackfillSheet tasks={candidates} onClose={() => setBackfill(false)}
          onDone={() => { setBackfill(false); setDoneMsg('已補登，讀書時間統計已更新'); }} />
      )}
      {doneMsg && <div className="ui-meta" role="status" style={{ marginTop: 'var(--sp-2)' }}>{doneMsg}</div>}
    </div></div>;
}
