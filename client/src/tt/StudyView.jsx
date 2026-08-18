import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, PageHeader, SurfaceCard } from './ui';

// 「讀書」＝中央主要動作：現在就開始一段讀書。
//
// Phase 1 只重新定位入口，不做完整的 Study Session domain。
// 既有的番茄鐘能力（絕對時間戳倒數、背景音、綁定任務、/pomo 專注紀錄）
// 原封不動保留在 PomoView 裡，這層只負責「這是讀書的入口」這件事，
// 以後 Study Session（開始／暫停／記錄實際讀了哪個 Scheduled Block）
// 接上來的時候，改這個檔案就好，不用動計時器本身。

export default function StudyView({ tasks }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/study-sessions').then(rows => setSession(rows.find(x => x.status === 'running') || rows.find(x => x.status === 'paused') || null)).catch(() => {}); }, []);
  const start = async task => { try { setError(''); setSession(await api('/study-sessions', { method: 'POST', body: { task_id: task.id, source: 'manual' } })); } catch (e) { setError(e.message); } };
  const end = async status => { try { setError(''); setSession(await api(`/study-sessions/${session.id}`, { method: 'PATCH', body: { status } })); } catch (e) { setError(e.message); } };
  const active = session?.status === 'running';
  const paused = session?.status === 'paused';
  const titleOf = s => s?.task_title || tasks.find(t => Number(t.id) === Number(s?.task_id))?.title || '讀書任務';
  return <div className="main"><PageHeader title="讀書" subtitle="記下實際讀書時間，之後可比較原定安排與實際進度" />
    <div className="main-body">{error && <SurfaceCard tone="warning">{error}</SurfaceCard>}
      {active ? <SurfaceCard tone="accent"><b>正在讀書：{titleOf(session)}</b><div className="ui-meta" style={{ marginTop: 4 }}>開始於 {new Date(session.started_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</div><div className="row" style={{ marginTop: 12 }}><Button onClick={() => end('paused')}>暫停</Button><Button variant="primary" style={{ marginLeft: 'auto' }} onClick={() => end('completed')}>完成本次讀書</Button></div></SurfaceCard> : paused ? <SurfaceCard tone="accent"><b>讀書已暫停：{titleOf(session)}</b><div className="ui-meta" style={{ marginTop: 4 }}>已累積 {session.actual_minutes || 0} 分鐘</div><div className="row" style={{ marginTop: 12 }}><Button variant="primary" onClick={() => end('running')}>繼續讀書</Button><Button style={{ marginLeft: 'auto' }} onClick={() => end('completed')}>結束本次讀書</Button></div></SurfaceCard> : <SurfaceCard><b>開始一段讀書</b><div className="ui-meta" style={{ marginTop: 4 }}>選一個尚未完成的任務開始計時。</div>{tasks.filter(t => !t.completed && !t.deleted).slice(0, 8).map(t => <div className="ui-row" key={t.id}><div className="ui-row-main"><div className="ui-row-title">{t.title}</div><div className="ui-row-sub">{t.due_date || '尚未安排'}</div></div><Button size="sm" variant="primary" onClick={() => start(t)}>開始</Button></div>)}</SurfaceCard>}
    </div></div>;
}
