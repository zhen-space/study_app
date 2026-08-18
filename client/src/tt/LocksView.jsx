import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, PageHeader, SurfaceCard } from './ui';
const label = l => l.type === 'task' ? `任務 #${l.task_id}` : l.type === 'day' ? `${l.date} 全天` : `${l.date} ${l.start_time}–${l.end_time}`;
export default function LocksView({ tasks=[] }) {
  const [locks,setLocks]=useState([]), [type,setType]=useState('task'), [task,setTask]=useState(''), [date,setDate]=useState(''), [start,setStart]=useState('19:00'), [end,setEnd]=useState('20:00'), [err,setErr]=useState('');
  const load=()=>api('/schedule/locks').then(setLocks).catch(e=>setErr(e.message)); useEffect(()=>{load();},[]);
  const add=async()=>{ try { setErr(''); await api('/schedule/locks',{method:'POST',body:type==='task'?{type,task_id:Number(task)}:type==='day'?{type,date}:{type,date,start_time:start,end_time:end}}); load(); }catch(e){setErr(e.message);} };
  return <div className="main"><PageHeader title="排程鎖定" subtitle="鎖定後，重新排程不會改動這些安排"/><div className="main-body">
    {err&&<SurfaceCard tone="warning">{err}</SurfaceCard>}<SurfaceCard style={{marginTop:12}}><b>新增鎖定</b><div className="row" style={{gap:8,marginTop:10}}>{['task','time','day'].map(x=><button key={x} className={type===x?'btn sm':'btn sm ghost'} onClick={()=>setType(x)}>{x==='task'?'任務':x==='time'?'時段':'整天'}</button>)}</div>
    {type==='task'?<select aria-label="選擇已排入時間的任務" value={task} onChange={e=>setTask(e.target.value)}><option value="">選擇已排入時間的任務</option>{tasks.filter(t=>t.plan_id&&!t.deleted&&!t.completed&&t.due_date).map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select>:<><input aria-label="鎖定日期" type="date" value={date} onChange={e=>setDate(e.target.value)}/>{type==='time'&&<div className="row"><input aria-label="鎖定開始時間" type="time" value={start} onChange={e=>setStart(e.target.value)}/><span>至</span><input aria-label="鎖定結束時間" type="time" value={end} onChange={e=>setEnd(e.target.value)}/></div>}</>}<Button variant="primary" block disabled={type==='task'?!task:!date||(type==='time'&&(!start||!end))} onClick={add}>鎖定</Button></SurfaceCard>
    {locks.map(l=><SurfaceCard key={l.id} style={{marginTop:8}}><div className="row"><span>{label(l)}</span><Button size="sm" style={{marginLeft:'auto'}} onClick={async()=>{await api(`/schedule/locks/${l.id}`,{method:'DELETE'});load();}}>解除鎖定</Button></div></SurfaceCard>)}
  </div></div>;
}
