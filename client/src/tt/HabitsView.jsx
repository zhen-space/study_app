import { useRef, useState } from 'react';
import { api } from '../api';
import { today, addDays } from './helpers';

const ICONS = ['⭐', '💧', '🏃', '📖', '🧘', '💪', '🌙', '🍎'];

export default function HabitsView({ habits, reload }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('⭐');
  const [missPolicy, setMissPolicy] = useState('drop');
  const [category, setCategory] = useState('');

  const week = [...Array(7)].map((_, i) => addDays(today(), i - 3)); // 今天置中：左邊前三天、右邊後三天
  const cats = [...new Set(habits.map(h => h.category).filter(Boolean))];

  const streak = h => {
    let s = 0, d = today();
    if (!h.checkins.includes(d)) d = addDays(d, -1);
    while (h.checkins.includes(d)) { s++; d = addDays(d, -1); }
    return s;
  };
  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await api('/habits', { method: 'POST', body: { name: name.trim(), icon, miss_policy: missPolicy, category: category.trim() } });
    setName('');
    reload();
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
  // 只重新載入、不重送打卡
  async function retryRefresh() {
    if (refreshBusy) return;
    setRefreshBusy(true);
    try { await reload(); setRefreshError(''); }
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
        <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => api(`/habits/${h.id}`, { method: 'DELETE' }).then(reload)}>✕</button>
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
  const grouped = [...cats.sort(), ...(habits.some(h => !h.category) ? [''] : [])];
  // 分類標題的圖標＝該分類第一個習慣的圖標
  const catIcon = cat => habits.find(h => (h.category || '') === cat)?.icon || '';

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
            <select value={icon} onChange={e => setIcon(e.target.value)}>{ICONS.map(i => <option key={i}>{i}</option>)}</select>
            <input placeholder="＋ 新增習慣（如：背 10 個單字）" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn sm">新增</button>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">分類：</span>
            <input list="habit-cats" placeholder="輸入新分類或選現有（可留空）" value={category}
              onChange={e => setCategory(e.target.value)} style={{ width: 200 }} />
            <datalist id="habit-cats">{cats.map(c => <option key={c} value={c} />)}</datalist>
            <span className="muted">沒打卡時：</span>
            <select value={missPolicy} onChange={e => setMissPolicy(e.target.value)}>
              <option value="drop">跳過就好，不用補</option>
              <option value="keep">保留，要回來補卡</option>
            </select>
          </div>
        </form>
        {grouped.map(cat => (
          <div key={cat || '__none'} className="tgroup">
            {(cat || cats.length > 0) && <div className="glabel">{cat ? `${catIcon(cat)} ${cat}` : '未分類'}</div>}
            {habits.filter(h => (h.category || '') === cat).map(h => HabitRow(h, !cat))}
          </div>
        ))}
        {habits.length === 0 && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>還沒有習慣，新增一個開始打卡吧</div>}
      </div>
    </div>
  );
}
