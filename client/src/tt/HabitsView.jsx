import { useRef, useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';

const ICONS = ['⭐', '💧', '🏃', '📖', '🧘', '💪', '🌙', '🍎'];

export default function HabitsView({ habits, reload }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('⭐');
  const [missPolicy, setMissPolicy] = useState('drop');
  const [category, setCategory] = useState('');

  // 伺服器已確認刪除、但刷新還沒成功的習慣先從畫面拿掉，避免對已不存在的習慣打卡或再刪一次
  const [deleted, setDeleted] = useState(new Set());
  const shown = habits.filter(h => !deleted.has(h.id));

  const week = [...Array(7)].map((_, i) => addDays(today(), i - 3)); // 今天置中：左邊前三天、右邊後三天
  const cats = [...new Set(shown.map(h => h.category).filter(Boolean))];

  const streak = h => {
    let s = 0, d = today();
    if (!h.checkins.includes(d)) d = addDays(d, -1);
    while (h.checkins.includes(d)) { s++; d = addDays(d, -1); }
    return s;
  };
  // 新增習慣的伺服器端不去重，連點或同一輪 submit 重入就會建立兩筆，所以用同步 ref 上鎖到刷新結束
  const addBusyRef = useRef(false);
  const pendingAddRef = useRef(null);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');
  // 中文輸入法選字的 Enter 不能被當成送出
  const composingRef = useRef(false);
  const imeKeyDown = e => {
    if (e.key === 'Enter' && (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
  };
  async function add(e) {
    e.preventDefault();
    if (composingRef.current || addBusyRef.current || pendingAddRef.current || !name.trim()) return;
    addBusyRef.current = true;
    setAddBusy(true);
    setAddError('');
    const body = { name: name.trim(), icon, miss_policy: missPolicy, category: category.trim() };
    pendingAddRef.current = { body, beforeIds: new Set(habits.map(h => h.id)) };
    try {
      await api('/habits', { method: 'POST', body });
    } catch (err) {
      // POST 回應中斷不代表沒寫入。先讀回正式資料，避免使用者重按後建立同名習慣。
      try {
        const current = await api('/habits');
        const pending = pendingAddRef.current;
        const committed = current.some(h => !pending.beforeIds.has(h.id)
          && h.name === pending.body.name && (h.icon || '⭐') === pending.body.icon
          && (h.miss_policy || 'drop') === pending.body.miss_policy
          && (h.category || '') === pending.body.category);
        pendingAddRef.current = null;
        if (committed) {
          setName('');
          setAddError('新增回應中斷，已重新載入確認。');
          await reload();
        } else setAddError(err.message || '習慣沒有新增成功，請再試一次。');
      } catch {
        setAddError('');
        setRefreshError('無法確認習慣是否新增，請重新載入；重新載入前請勿再次新增。');
      }
      addBusyRef.current = false;
      setAddBusy(false);
      return;
    }
    // 寫入成功和重新載入是兩個邊界：刷新失敗時習慣已存在，先清掉已送出的名稱，
    // 復原只重新載入、不重送，避免建立重複的習慣
    setName('');
    pendingAddRef.current = null;
    try { await reload(); }
    catch { setRefreshError('習慣已新增，但畫面暫時無法重新載入。'); }
    addBusyRef.current = false;
    setAddBusy(false);
  }
  // 打卡圓點的狀態來自 props，要等刷新回來才會變。這段期間再點一次，送出的 undo 仍是
  // 舊畫面算的，使用者想「取消」會被當成再打一次卡，所以每個習慣同步上鎖到刷新結束。
  const busyRef = useRef(new Set());
  const [busy, setBusy] = useState(new Set());
  const [refreshError, setRefreshError] = useState('');
  const [refreshBusy, setRefreshBusy] = useState(false);
  async function check(h, date) {
    if (busyRef.current.has(h.id)) return;
    busyRef.current.add(h.id);
    setBusy(s => new Set([...s, h.id]));
    const release = () => {
      busyRef.current.delete(h.id);
      setBusy(s => { const n = new Set(s); n.delete(h.id); return n; });
    };
    const undo = h.checkins.includes(date);
    setRefreshError('');
    try {
      await api(`/habits/${h.id}/checkin`, { method: 'POST', body: { date, undo } });
    } catch (e) {
      setRefreshError(e.message || '打卡沒有儲存成功，請再試一次。');
      release();
      return;
    }
    // 寫入成功和重新載入是兩個邊界：刷新失敗時打卡其實已存好，不能誤報成打卡失敗
    try { await reload(); }
    catch {
      setRefreshError(undo ? '已取消打卡，但畫面暫時無法重新載入。'
        : date < today() ? '已補卡，但畫面暫時無法重新載入。' : '已打卡，但畫面暫時無法重新載入。');
    }
    release();
  }
  // 刪除不可復原，先確認；和打卡共用每個習慣的同步鎖，打卡進行中不能刪、刪除進行中不能打卡
  async function remove(h) {
    if (busyRef.current.has(h.id)) return;
    if (!window.confirm(`刪除習慣「${h.name}」？打卡紀錄會一起刪除，無法復原。`)) return;
    busyRef.current.add(h.id);
    setBusy(s => new Set([...s, h.id]));
    const release = () => {
      busyRef.current.delete(h.id);
      setBusy(s => { const n = new Set(s); n.delete(h.id); return n; });
    };
    setRefreshError('');
    try {
      await api(`/habits/${h.id}`, { method: 'DELETE' });
    } catch (e) {
      setRefreshError(e.message || '習慣沒有刪除成功，請再試一次。');
      release();
      return;
    }
    // 寫入成功和重新載入是兩個邊界：刷新失敗時習慣其實已刪除，先從畫面拿掉，復原只重新載入
    setDeleted(s => new Set([...s, h.id]));
    try { await reload(); }
    catch { setRefreshError('習慣已刪除，但畫面暫時無法重新載入。'); }
    release();
  }
  // 只重新載入、不重送打卡／刪除
  async function retryRefresh() {
    if (refreshBusy) return;
    setRefreshBusy(true);
    try {
      const pending = pendingAddRef.current;
      if (pending) {
        const current = await api('/habits');
        const committed = current.some(h => !pending.beforeIds.has(h.id)
          && h.name === pending.body.name && (h.icon || '⭐') === pending.body.icon
          && (h.miss_policy || 'drop') === pending.body.miss_policy
          && (h.category || '') === pending.body.category);
        pendingAddRef.current = null;
        if (committed) {
          setName('');
          setAddError('新增回應中斷，已重新載入確認。');
        } else setAddError('習慣沒有新增成功，已重新載入；可再次新增。');
      }
      await reload(); setRefreshError('');
    }
    catch { setRefreshError('仍然無法重新載入，請稍後再試。'); }
    finally { setRefreshBusy(false); }
  }
  async function moveCategory(h) {
    const c = prompt(`「${h.name}」的分類（留空＝不分類）：`, h.category || '');
    if (c === null) return;
    await api(`/habits/${h.id}`, { method: 'PATCH', body: { category: c.trim() } });
    reload();
  }

  // 第一行：名稱＋連續紀錄＋刪除；第二行：打卡圓點（今天開始往前）
  const HabitRow = (h, showIcon) => (
    <div className="habit-row" key={h.id}>
      <div className="habit-main">
        {showIcon && <span style={{ fontSize: 18 }}>{h.icon}</span>}
        <span className="habit-name" title="點名稱可改分類" onClick={() => moveCategory(h)}>{h.name}</span>
        <span className="streak">🔥 連續 {streak(h)} 天・共 {h.checkins.length} 次</span>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label={`刪除習慣「${h.name}」`}
          disabled={busy.has(h.id)} onClick={() => remove(h)}>✕</button>
      </div>
      <div className="week-dots">
        {week.map(d => (
          <div key={d} className={'wdot' + (h.checkins.includes(d) ? ' on' : '')}
            style={{
              ...(h.checkins.includes(d) ? { background: h.color } : {}),
              ...(d === today() ? { outline: '2px solid var(--primary)', outlineOffset: 1 } : {}),
              ...(d > today() ? { opacity: .45 } : {}),
            }}
            title={d} aria-busy={busy.has(h.id)} aria-disabled={busy.has(h.id) || d > today()}
            onClick={() => d <= today() && check(h, d)}>
            {d === today() ? '今' : +d.slice(8)}
          </div>
        ))}
      </div>
    </div>
  );

  // 依分類分組顯示：有分類的照名稱排、未分類放最後
  const grouped = [...cats.sort(), ...(shown.some(h => !h.category) ? [''] : [])];
  // 分類標題的圖標＝該分類第一個習慣的圖標
  const catIcon = cat => shown.find(h => (h.category || '') === cat)?.icon || '';

  return (
    <div className="main">
      <div className="main-head"><h2>習慣打卡</h2></div>
      <div className="main-body">
        {refreshError && (
          <div role="alert" className="ui-error" style={{ marginBottom: 'var(--sp-3)' }}>
            {refreshError}
            <button type="button" disabled={refreshBusy} onClick={retryRefresh} style={{ marginLeft: 8 }}>
              {refreshBusy ? '重新載入中…' : '重新載入'}
            </button>
          </div>
        )}
        <form onSubmit={add} style={{ margin: '6px 0' }}>
          <div className="row">
            <select value={icon} disabled={addBusy} onChange={e => setIcon(e.target.value)}>{ICONS.map(i => <option key={i}>{i}</option>)}</select>
            <input placeholder="＋ 新增習慣（如：背 10 個單字）" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={e => { composingRef.current = false; setName(e.currentTarget.value); }}
              onKeyDown={imeKeyDown} disabled={addBusy} aria-invalid={addError ? 'true' : undefined} />
            <button className="btn sm" disabled={addBusy}>{addBusy ? '新增中…' : '新增'}</button>
          </div>
          {addError && <div role="alert" className="ui-error" style={{ marginTop: 6 }}>{addError}</div>}
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">分類：</span>
            <input list="habit-cats" placeholder="輸入新分類或選現有（可留空）" value={category}
              onChange={e => setCategory(e.target.value)} style={{ width: 200 }}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={e => { composingRef.current = false; setCategory(e.currentTarget.value); }}
              onKeyDown={imeKeyDown} disabled={addBusy} />
            <datalist id="habit-cats">{cats.map(c => <option key={c} value={c} />)}</datalist>
            <span className="muted">沒打卡時：</span>
            <select value={missPolicy} disabled={addBusy} onChange={e => setMissPolicy(e.target.value)}>
              <option value="drop">跳過就好，不用補</option>
              <option value="keep">保留，要回來補卡</option>
            </select>
          </div>
        </form>
        {grouped.map(cat => (
          <div key={cat || '__none'} className="tgroup">
            {(cat || cats.length > 0) && <div className="glabel">{cat ? `${catIcon(cat)} ${cat}` : '未分類'}</div>}
            {shown.filter(h => (h.category || '') === cat).map(h => HabitRow(h, !cat))}
          </div>
        ))}
        {shown.length === 0 && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>還沒有習慣，新增一個開始打卡吧</div>}
      </div>
    </div>
  );
}
