import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';
import { filesToPayload, savePending, runImport, resumePending, importing } from './vocabImport';

// 單字本：匯入與整理都在這裡（像排程精靈一樣獨立一頁）；首頁只顯示當日單字表
export default function VocabView() {
  const [items, setItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vocabCache') || '[]'); } catch { return []; }
  });
  const [busy, setBusy] = useState(false);
  const [perDay, setPerDay] = useState(() => +(localStorage.getItem('vocabPerDay') || 10));
  const [openDays, setOpenDays] = useState(() => new Set([today()]));
  const load = () => api('/import/vocab').then(list => {
    setItems(list);
    try { localStorage.setItem('vocabCache', JSON.stringify(list)); } catch {}
  }).catch(() => {});
  useEffect(() => {
    load();
    // 上次解析到一半退出 App → 自動接著做
    if (resumePending((r, err) => { setBusy(false); if (err) alert('讀取失敗：' + err.message + '（檔案已保留，重開會再試）'); else load(); })) setBusy(true);
    else if (importing()) setBusy(true);
    const onUpd = () => { setBusy(false); load(); };
    window.addEventListener('vocab-updated', onUpd);
    return () => window.removeEventListener('vocab-updated', onUpd);
  }, []);

  const dates = [...new Set(items.map(x => x.date))].sort();

  function report(r, mode, over) {
    if (!r) return;
    const dup = r.skipped ? `（略過已存在的 ${r.skipped} 個）` : '';
    if (!r.added) alert(r.skipped ? `這些單字都已經在單字本裡了${dup}` : 'AI 沒有找到單字');
    else if (mode === 'spread') alert(`已匯入 ${r.added} 個${dup}，從今天起每天 ${perDay} 個、共 ${r.days} 天${over ? '（一次最多 12 份，超過的沒讀）' : ''}`);
    else alert(`已加入今天 ${r.added} 個單字${dup}`);
  }
  async function doImport(e, mode) {
    const list = e.target.files;
    if (!list?.length) return;
    const over = list.length > 12;
    setBusy(true);
    try {
      const files = await filesToPayload(list); // 照片自動縮圖壓縮，不會爆大小限制
      e.target.value = '';
      const payload = { files, mode, perDay };
      savePending(payload); // 中途退出 App 也能回來繼續
      const r = await runImport(payload);
      report(r, mode, over);
      load();
    } catch (err) { alert('讀取失敗：' + err.message + '（檔案已保留，重開 App 會自動再試）'); }
    setBusy(false);
  }
  async function del(id) {
    setItems(list => list.filter(x => x.id !== id));
    try { await api(`/import/vocab/${id}`, { method: 'DELETE' }); } catch {}
    load();
  }
  async function delDay(d) {
    const ids = items.filter(x => x.date === d).map(x => x.id);
    setItems(list => list.filter(x => x.date !== d));
    for (const id of ids) { try { await api(`/import/vocab/${id}`, { method: 'DELETE' }); } catch {} }
    load();
  }
  const setN = v => { const n = Math.max(1, Math.min(200, +v || 1)); setPerDay(n); try { localStorage.setItem('vocabPerDay', String(n)); } catch {} };
  const toggleDay = d => setOpenDays(s => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const label = d => `${+d.slice(5, 7)}/${+d.slice(8)}${d === today() ? '（今天）' : ''}`;

  // 編輯單字（英文、中文、單字/片語、顏色）
  const [editId, setEditId] = useState(null);
  const VOCAB_COLORS = ['', '#0086CC', '#8AC4DE', '#005B98', '#192F60', '#CB1B45', '#E98B2A', '#00896C', '#66327C'];
  const updLocal = (id, patch) => setItems(list => list.map(x => x.id === id ? { ...x, ...patch } : x));
  const sendPatch = (id, patch) => api(`/import/vocab/${id}`, { method: 'PATCH', body: patch }).catch(() => {});
  const patchWord = (id, patch) => { updLocal(id, patch); sendPatch(id, patch); };
  const WordRow = x => (
    <div key={x.id}>
      <div className="vocab-row" style={{ cursor: 'pointer' }} onClick={() => setEditId(editId === x.id ? null : x.id)}>
        <span className="vocab-en" style={x.color ? { color: x.color } : {}}>
          {x.english}{x.kind === '片語' && <span className="chip" style={{ fontSize: 10, marginLeft: 4 }}>片語</span>}
        </span>
        <span className="vocab-zh">{x.chinese}</span>
        <button className="icon-btn" style={{ padding: 2 }} onClick={e => { e.stopPropagation(); del(x.id); }}>✕</button>
      </div>
      {editId === x.id && (
        <div style={{ padding: '6px 2px 10px', borderBottom: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
          <div className="row">
            <input value={x.english} style={{ flex: 1, fontWeight: 600 }}
              onChange={e => updLocal(x.id, { english: e.target.value })} onBlur={e => sendPatch(x.id, { english: e.target.value })} />
            <input value={x.chinese} placeholder="中文" style={{ flex: 1 }}
              onChange={e => updLocal(x.id, { chinese: e.target.value })} onBlur={e => sendPatch(x.id, { chinese: e.target.value })} />
            <button className="btn sm ghost" onClick={() => patchWord(x.id, { kind: x.kind === '片語' ? '單字' : '片語' })}>{x.kind}</button>
          </div>
          <div className="swatches" style={{ marginTop: 6 }}>
            {VOCAB_COLORS.map(c => (
              <span key={c || 'none'} className={'swatch' + ((x.color || '') === c ? ' on' : '')}
                style={c ? { background: c } : { background: '#fff', border: '1px solid var(--border)' }}
                title={c ? '' : '預設'} onClick={() => patchWord(x.id, { color: c })} />
            ))}
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setEditId(null)}>完成</button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="main">
      <div className="main-head"><h2>單字本</h2><span className="muted">{items.length} 個</span></div>
      <div className="main-body">
        <div className="tile" style={{ margin: '8px 0' }}>
          <b>匯入單字</b>
          <div className="muted" style={{ margin: '2px 0 8px' }}>拍照或選檔案（可多張、最多 12 份），AI 自動整理成英文＋中文、分單字/片語</div>
          <label className="btn sm" style={{ display: 'inline-block', cursor: 'pointer', opacity: busy ? .5 : 1 }}>
            📅 當日單字（全部算今天）
            <input type="file" multiple accept="image/*,.pdf,.xlsx,.csv,.docx,.txt" style={{ display: 'none' }} disabled={busy} onChange={e => doImport(e, 'today')} />
          </label>
          <div className="row" style={{ marginTop: 10 }}>
            <label className="btn sm" style={{ cursor: 'pointer', opacity: busy ? .5 : 1 }}>
              📚 整本分配（從今天起）
              <input type="file" multiple accept="image/*,.pdf,.xlsx,.csv,.docx,.txt" style={{ display: 'none' }} disabled={busy} onChange={e => doImport(e, 'spread')} />
            </label>
            <span className="muted">一天</span>
            <input type="number" min="1" max="200" value={perDay} onChange={e => setN(e.target.value)} style={{ width: 58 }} />
            <span className="muted">個</span>
          </div>
          {busy && <div className="muted" style={{ marginTop: 8 }}>AI 讀取中，可先去做別的事…</div>}
        </div>

        {dates.map(d => {
          const list = items.filter(x => x.date === d);
          const open = openDays.has(d);
          return (
            <div key={d} className="tgroup">
              <div className="glabel" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => toggleDay(d)}>
                <span>{open ? '▾' : '▸'}</span>{label(d)}
                <span className="muted" style={{ fontWeight: 400 }}>{list.length} 個</span>
                <button className="icon-btn" style={{ marginLeft: 'auto' }} title="刪除這一天全部"
                  onClick={e => { e.stopPropagation(); delDay(d); }}>✕</button>
              </div>
              {open && list.map(WordRow)}
            </div>
          );
        })}
        {!dates.length && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>還沒有單字，先匯入一批吧</div>}
      </div>
    </div>
  );
}
