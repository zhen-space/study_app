import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, PageHeader, SurfaceCard, EmptyState } from './ui';

const TYPES = [
  ['class', '固定課表'], ['fixed_event', '固定行程'], ['sleep', '睡眠'],
  ['meal', '用餐'], ['availability', '可讀書時間'],
];
const DAYS = ['日', '一', '二', '三', '四', '五', '六'];
const typeName = type => TYPES.find(x => x[0] === type)?.[1] || type;

// B：所有計畫共用的結構化作息；不屬於某一個 Plan，也不改寫舊 fixed_events。
export default function RoutinesView() {
  const [routines, setRoutines] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [form, setForm] = useState({ type: 'class', title: '', weekdays: [1, 2, 3, 4, 5], start_time: '19:00', end_time: '20:00' });
  const [exception, setException] = useState({ date: '', kind: 'unavailable', title: '', start_time: '', end_time: '' });
  const [error, setError] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [exceptionBusy, setExceptionBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const pendingCreate = useRef(null);
  const pendingException = useRef(null);
  const load = () => Promise.all([api('/routines'), api('/routine-exceptions')])
    .then(([rs, es]) => { setRoutines(rs); setExceptions(es); return rs; });
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  const toggleDay = day => setForm(x => ({ ...x, weekdays: x.weekdays.includes(day) ? x.weekdays.filter(d => d !== day) : [...x.weekdays, day].sort() }));
  const create = async () => {
    if (createBusy || pendingCreate.current) return;
    const body = { ...form };
    pendingCreate.current = { body, beforeIds: new Set(routines.map(r => r.id)) };
    setCreateBusy(true); setError('');
    try {
      await api('/routines', { method: 'POST', body });
    } catch (e) {
      try { resolveCreate(await api('/routines'), e); }
      catch { setError('無法確認固定時間是否新增，請重新載入；重新載入前請勿再次新增。'); }
      setCreateBusy(false);
      return;
    }
    pendingCreate.current = null;
    setForm(x => ({ ...x, title: '' }));
    try { await load(); }
    catch { setError('固定時間已新增，但畫面暫時無法重新載入。'); }
    finally { setCreateBusy(false); }
  };
  const resolveCreate = (current, originalError) => {
    setRoutines(current);
    const pending = pendingCreate.current;
    if (!pending) return;
    const weekdays = JSON.stringify(pending.body.weekdays);
    const committed = current.some(r => !pending.beforeIds.has(r.id) && r.type === pending.body.type
      && (r.title || '') === (pending.body.title || '') && r.weekdays === weekdays
      && (r.start_time || '') === (pending.body.start_time || '') && (r.end_time || '') === (pending.body.end_time || ''));
    pendingCreate.current = null;
    if (committed) {
      setForm(x => ({ ...x, title: '' }));
      setError('新增回應中斷，已重新載入確認。');
    } else setError(originalError?.message || '固定時間沒有新增成功，已重新載入；可再次新增。');
  };
  const retryPending = async () => {
    if (retrying || (!pendingCreate.current && !pendingException.current)) return;
    setRetrying(true);
    try {
      if (pendingCreate.current) resolveCreate(await api('/routines'));
      else resolveException(await api('/routine-exceptions'));
    }
    catch { setError('仍然無法重新載入，請稍後再試。'); }
    finally { setRetrying(false); }
  };
  const createException = async () => {
    if (exceptionBusy || pendingException.current) return;
    const body = { ...exception };
    pendingException.current = { body, beforeIds: new Set(exceptions.map(e => e.id)) };
    setExceptionBusy(true); setError('');
    try { await api('/routine-exceptions', { method: 'POST', body }); }
    catch (e) {
      try { resolveException(await api('/routine-exceptions'), e); }
      catch { setError('無法確認例外日是否新增，請重新載入；重新載入前請勿再次新增。'); }
      setExceptionBusy(false);
      return;
    }
    pendingException.current = null;
    setException({ date: '', kind: 'unavailable', title: '', start_time: '', end_time: '' });
    try { await load(); }
    catch { setError('例外日已新增，但畫面暫時無法重新載入。'); }
    finally { setExceptionBusy(false); }
  };
  const resolveException = (current, originalError) => {
    setExceptions(current);
    const pending = pendingException.current;
    if (!pending) return;
    const committed = current.some(e => !pending.beforeIds.has(e.id) && e.date === pending.body.date
      && e.kind === pending.body.kind && (e.title || '') === (pending.body.title || '')
      && (e.start_time || '') === (pending.body.start_time || '') && (e.end_time || '') === (pending.body.end_time || ''));
    pendingException.current = null;
    if (committed) {
      setException({ date: '', kind: 'unavailable', title: '', start_time: '', end_time: '' });
      setError('新增例外日回應中斷，已重新載入確認。');
    } else setError(originalError?.message || '例外日沒有新增成功，已重新載入；可再次新增。');
  };
  // §J：全 App 的時間設定集中在這一頁（課表／固定行程／作息／可讀書時間／例外日），
  // 從行事曆右上「時間設定」或側欄進來；設定不再散在各處。
  return <div className="main"><PageHeader title="時間設定" subtitle="課表、固定行程、作息、可讀書時間與例外日；會套用到所有計畫" />
    <div className="main-body">
      {error && <SurfaceCard tone="warning"><div role="alert">{error}</div>{(pendingCreate.current || pendingException.current) && <Button size="sm" variant="tertiary" disabled={retrying} onClick={retryPending}>{retrying ? '重新載入中…' : '重新載入'}</Button>}</SurfaceCard>}
      <SurfaceCard large><div className="ui-section-title">新增固定時間</div>
        <select value={form.type} onChange={e => setForm(x => ({ ...x, type: e.target.value }))}>{TYPES.map(([v, n]) => <option value={v} key={v}>{n}</option>)}</select>
        <input placeholder="名稱（例如：數學課、晚自習）" value={form.title} onChange={e => setForm(x => ({ ...x, title: e.target.value }))} />
        <div className="row" style={{ gap: 4, flexWrap: 'wrap', margin: '8px 0' }}>{DAYS.map((day, i) => <Button key={day} size="sm" variant={form.weekdays.includes(i) ? 'primary' : 'tertiary'} onClick={() => toggleDay(i)}>週{day}</Button>)}</div>
        <div className="row" style={{ gap: 8 }}><input aria-label="開始時間" type="time" value={form.start_time} onChange={e => setForm(x => ({ ...x, start_time: e.target.value }))} /><span>至</span><input aria-label="結束時間" type="time" value={form.end_time} onChange={e => setForm(x => ({ ...x, end_time: e.target.value }))} /></div>
        <Button variant="primary" block disabled={createBusy || !!pendingCreate.current} onClick={create}>{createBusy ? '新增中…' : '加入固定時間'}</Button>
      </SurfaceCard>
      <section className="ui-section"><div className="ui-section-title">固定時間</div>
        {routines.length === 0 ? <EmptyState title="還沒有固定時間" description="加入課表、固定行程或可讀書時間後，排程會自動避開。" /> : routines.map(r => {
          let weekdays = []; try { weekdays = JSON.parse(r.weekdays || '[]'); } catch {}
          return <SurfaceCard key={r.id} style={{ marginBottom: 8 }}><div className="row"><div><b>{r.title || typeName(r.type)}</b><div className="ui-meta">{typeName(r.type)}・{weekdays.map(d => `週${DAYS[d]}`).join('、')}・{r.start_time}–{r.end_time}</div></div><Button size="sm" variant="tertiary" style={{ marginLeft: 'auto' }} onClick={async () => { await api(`/routines/${r.id}`, { method: 'DELETE' }); load(); }}>移除</Button></div></SurfaceCard>;
        })}
      </section>
      <SurfaceCard><div className="ui-section-title">例外日</div><input type="date" value={exception.date} onChange={e => setException(x => ({ ...x, date: e.target.value }))} />
        <select value={exception.kind} onChange={e => setException(x => ({ ...x, kind: e.target.value }))}><option value="unavailable">不可讀書</option><option value="available">額外可讀書</option></select>
        <input placeholder="說明（選填）" value={exception.title} onChange={e => setException(x => ({ ...x, title: e.target.value }))} />
        <div className="row" style={{ gap: 8 }}><input type="time" aria-label="例外開始時間" value={exception.start_time} onChange={e => setException(x => ({ ...x, start_time: e.target.value }))} /><span>至</span><input type="time" aria-label="例外結束時間" value={exception.end_time} onChange={e => setException(x => ({ ...x, end_time: e.target.value }))} /></div>
        <Button variant="secondary" block disabled={exceptionBusy || !!pendingException.current} onClick={createException}>{exceptionBusy ? '新增中…' : '加入例外日'}</Button>
        {exceptions.map(e => <div className="ui-row" key={e.id}><div className="ui-row-main"><div className="ui-row-title">{e.date}・{e.kind === 'available' ? '額外可讀書' : '不可讀書'}</div><div className="ui-row-sub">{e.title || '例外時間'} {e.start_time && `${e.start_time}–${e.end_time}`}</div></div><Button size="sm" variant="tertiary" onClick={async () => { await api(`/routine-exceptions/${e.id}`, { method: 'DELETE' }); load(); }}>移除</Button></div>)}
      </SurfaceCard>
    </div>
  </div>;
}
