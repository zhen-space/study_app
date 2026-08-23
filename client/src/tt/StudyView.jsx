import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';
import { Button, PageHeader, SurfaceCard, EmptyState } from './ui';

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

export default function StudyView({ tasks, goPlans }) {
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
  return <div className="main"><PageHeader title="讀書" subtitle="記下實際讀書時間，之後可比較原定安排與實際進度" />
    <div className="main-body">{error && <SurfaceCard tone="warning">{error}</SurfaceCard>}
      {active ? <SurfaceCard tone="accent"><b>正在讀書：{titleOf(session)}</b><div className="ui-meta" style={{ marginTop: 4 }}>開始於 {new Date(session.started_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</div><div className="row" style={{ marginTop: 12 }}><Button onClick={() => end('paused')}>暫停</Button><Button variant="primary" style={{ marginLeft: 'auto' }} onClick={() => end('completed')}>完成本次讀書</Button></div></SurfaceCard>
        : paused ? <SurfaceCard tone="accent"><b>讀書已暫停：{titleOf(session)}</b><div className="ui-meta" style={{ marginTop: 4 }}>已累積 {session.actual_minutes || 0} 分鐘</div><div className="row" style={{ marginTop: 12 }}><Button variant="primary" onClick={() => end('running')}>繼續讀書</Button><Button style={{ marginLeft: 'auto' }} onClick={() => end('completed')}>結束本次讀書</Button></div></SurfaceCard>
        // 一項任務都沒有的時候，「選一個尚未完成的任務」底下空空如也——
        // 中央主要動作不能是一條死路，要說得出下一步在哪裡。
        : pick.length === 0 ? <EmptyState
            title="還沒有可以讀的任務"
            description="先建立一個讀書計畫，AI 會把教材內容排成每天的任務；也可以到「任務」自己加一項。"
            action={goPlans && <Button variant="primary" size="lg" onClick={goPlans}>建立讀書計畫</Button>} />
        : <SurfaceCard><b>開始一段讀書</b><div className="ui-meta" style={{ marginTop: 4 }}>照時間先後列出最該做的幾項。</div>{pick.map(t => <div className="ui-row" key={t.id}><div className="ui-row-main"><div className="ui-row-title">{t.title}</div><div className="ui-row-sub" style={t.due_date && t.due_date < td ? { color: 'var(--danger)' } : undefined}>{dueLabel(t, td)}</div></div><Button size="sm" variant="primary" onClick={() => start(t)}>開始</Button></div>)}</SurfaceCard>}
    </div></div>;
}
