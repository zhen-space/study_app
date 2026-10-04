import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, PageHeader, SurfaceCard } from './ui';
import { onActivePlan } from './helpers';

const label = lock => lock.type === 'task'
  ? `任務 #${lock.task_id}`
  : lock.type === 'day'
    ? `${lock.date} 全天`
    : `${lock.date} ${lock.start_time}–${lock.end_time}`;

export default function LocksView({ tasks = [] }) {
  const [locks, setLocks] = useState([]);
  const [type, setType] = useState('task');
  const [task, setTask] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('19:00');
  const [end, setEnd] = useState('20:00');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [addBusy, setAddBusy] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const addingRef = useRef(false);
  const deletingRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setLocks(await api('/schedule/locks'));
      setErr('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (addBusy || addingRef.current) return;
    addingRef.current = true;
    setAddBusy(true);
    setErr('');
    try {
      const body = type === 'task'
        ? { type, task_id: Number(task) }
        : type === 'day'
          ? { type, date }
          : { type, date, start_time: start, end_time: end };
      const created = await api('/schedule/locks', { method: 'POST', body });
      // POST 回傳伺服器正規化後的完整 lock（含 existing）。寫入成功即以這份
      // 伺服器回應更新投影，避免後續 GET 失敗被誤報成建立失敗。
      setLocks(current => [...current.filter(lock => lock.id !== created.id), created]);
    } catch (e) {
      setErr(e.message);
    } finally {
      addingRef.current = false;
      setAddBusy(false);
    }
  };

  const remove = async id => {
    if (deletingId !== null || deletingRef.current) return;
    deletingRef.current = true;
    setDeletingId(id);
    setErr('');
    try {
      await api(`/schedule/locks/${id}`, { method: 'DELETE' });
      // DELETE 已在伺服器提交後，第二次呼叫會是 404。成功時直接更新目前投影，
      // 不把後續 GET 失敗誤報成「解除失敗」而誘導使用者再次送出 mutation。
      setLocks(current => current.filter(lock => lock.id !== id));
    } catch (e) {
      setErr(e.message);
    } finally {
      deletingRef.current = false;
      setDeletingId(null);
    }
  };

  const invalid = type === 'task'
    ? !task
    : !date || (type === 'time' && (!start || !end || start >= end));

  return <div className="main">
    <PageHeader title="排程鎖定" subtitle="鎖定後，重新排程不會改動這些安排" />
    <div className="main-body">
      {err && <div role="alert"><SurfaceCard tone="warning">{err}</SurfaceCard></div>}
      <SurfaceCard style={{ marginTop: 12 }}>
        <b>新增鎖定</b>
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {['task', 'time', 'day'].map(value => <button
            key={value}
            type="button"
            className={type === value ? 'btn sm' : 'btn sm ghost'}
            disabled={addBusy}
            onClick={() => setType(value)}
          >{value === 'task' ? '任務' : value === 'time' ? '時段' : '整天'}</button>)}
        </div>
        {type === 'task'
          ? <select aria-label="選擇已排入時間的任務" value={task} disabled={addBusy} onChange={e => setTask(e.target.value)}>
              <option value="">選擇已排入時間的任務</option>
              {tasks.filter(item => item.plan_id && onActivePlan(item) && !item.deleted && !item.completed && item.due_date)
                .map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          : <>
              <input aria-label="鎖定日期" type="date" value={date} disabled={addBusy} onChange={e => setDate(e.target.value)} />
              {type === 'time' && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input aria-label="鎖定開始時間" type="time" value={start} disabled={addBusy} onChange={e => setStart(e.target.value)} />
                <span>至</span>
                <input aria-label="鎖定結束時間" type="time" value={end} disabled={addBusy} onChange={e => setEnd(e.target.value)} />
              </div>}
            </>}
        <Button variant="primary" block disabled={invalid || addBusy} onClick={add}>{addBusy ? '鎖定中…' : '鎖定'}</Button>
      </SurfaceCard>
      {loading && <p aria-live="polite">載入中…</p>}
      {locks.map(lock => <SurfaceCard key={lock.id} style={{ marginTop: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span>{label(lock)}</span>
          <Button
            size="sm"
            style={{ marginLeft: 'auto' }}
            disabled={deletingId !== null}
            onClick={() => remove(lock.id)}
          >{deletingId === lock.id ? '解除中…' : '解除鎖定'}</Button>
        </div>
      </SurfaceCard>)}
    </div>
  </div>;
}
