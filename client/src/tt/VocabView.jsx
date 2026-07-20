import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';

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
  useEffect(() => { load(); }, []);

  const dates = [...new Set(items.map(x => x.date))].sort();

  async function toPayload(fileList) {
    const files = [];
    for (const file of [...fileList].slice(0, 12)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      files.push({ filename: file.name, mime: file.type, data: btoa(bin) });
    }
    return files;
  }
  async function doImport(e, mode) {
    const list = e.target.files;
    if (!list?.length) return;
    const over = list.length > 12;
    const files = await toPayload(list);
    e.target.value = '';
    setBusy(true);
    try {
      const r = await api('/import/vocab', { method: 'POST', body: { files, mode, perDay } });
      if (!r.added) alert('AI 沒有找到單字');
      else alert(mode === 'spread'
        ? `已匯入 ${r.added} 個，從今天起每天 ${perDay} 個、共 ${r.days} 天${over ? '（一次最多 12 份，超過的沒讀）' : ''}`
        : `已加入今天 ${r.added} 個單字`);
      load();
    } catch (err) { alert('讀取失敗：' + err.message); }
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
              {open && ['單字', '片語'].map(kind => {
                const ks = list.filter(x => x.kind === kind);
                if (!ks.length) return null;
                return (
                  <div key={kind}>
                    <div className="muted" style={{ margin: '6px 0 2px', fontSize: 12 }}>{kind}（{ks.length}）</div>
                    {ks.map(x => (
                      <div key={x.id} className="vocab-row">
                        <span className="vocab-en">{x.english}</span>
                        <span className="vocab-zh">{x.chinese}</span>
                        <button className="icon-btn" style={{ padding: 2 }} onClick={() => del(x.id)}>✕</button>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!dates.length && <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>還沒有單字，先匯入一批吧</div>}
      </div>
    </div>
  );
}
