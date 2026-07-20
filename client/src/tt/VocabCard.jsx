import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';

// 首頁單字區：拍照/匯入 → AI 讀出英文／中文／片語
// 兩種匯入：當日（全部算今天）、整本分配（從今天起一天 N 個）
export default function VocabCard() {
  const [items, setItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vocabCache') || '[]'); } catch { return []; }
  });
  const [busy, setBusy] = useState(false);
  const [day, setDay] = useState(today());
  const [panel, setPanel] = useState(false); // 匯入面板
  const [perDay, setPerDay] = useState(() => +(localStorage.getItem('vocabPerDay') || 10));
  const load = () => api('/import/vocab').then(list => {
    setItems(list);
    try { localStorage.setItem('vocabCache', JSON.stringify(list)); } catch {}
  }).catch(() => {});
  useEffect(() => { load(); }, []);

  const dates = [...new Set(items.map(x => x.date))].sort(); // 舊→新
  const cur = items.filter(x => x.date === day);
  const di = dates.indexOf(day);

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
    setPanel(false);
    setBusy(true);
    try {
      const r = await api('/import/vocab', { method: 'POST', body: { files, mode, perDay } });
      if (!r.added) alert('AI 沒有找到單字');
      else if (mode === 'spread') alert(`已匯入 ${r.added} 個，從今天起每天 ${perDay} 個、共分配 ${r.days} 天${over ? '（一次最多 12 份檔案，超過的沒讀）' : ''}`);
      setDay(today());
      load();
    } catch (err) { alert('讀取失敗：' + err.message); }
    setBusy(false);
  }
  async function del(id) {
    setItems(list => list.filter(x => x.id !== id)); // 畫面先消失
    try { await api(`/import/vocab/${id}`, { method: 'DELETE' }); } catch {}
    load();
  }
  const setN = v => { const n = Math.max(1, Math.min(200, +v || 1)); setPerDay(n); try { localStorage.setItem('vocabPerDay', String(n)); } catch {} };

  const Section = ({ kind }) => {
    const list = cur.filter(x => x.kind === kind);
    if (!list.length) return null;
    return (
      <>
        <div className="muted" style={{ margin: '8px 0 2px', fontSize: 12 }}>{kind}（{list.length}）</div>
        {list.map(x => (
          <div key={x.id} className="vocab-row">
            <span className="vocab-en">{x.english}</span>
            <span className="vocab-zh">{x.chinese}</span>
            <button className="icon-btn" style={{ padding: 2 }} onClick={() => del(x.id)}>✕</button>
          </div>
        ))}
      </>
    );
  };

  return (
    <div className="tgroup" style={{ marginTop: 24, borderTop: '2px dashed var(--border)', paddingTop: 12 }}>
      <div className="glabel" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        📸 今日單字
        {dates.length > 1 && <>
          <button className="icon-btn" disabled={di <= 0} onClick={() => setDay(dates[Math.max(0, di - 1)])}>◀</button>
          <span className="muted" style={{ fontSize: 12 }}>{day === today() ? '今天' : `${+day.slice(5, 7)}/${+day.slice(8)}`}</span>
          <button className="icon-btn" disabled={di < 0 || di >= dates.length - 1} onClick={() => setDay(dates[Math.min(dates.length - 1, di + 1)])}>▶</button>
        </>}
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => setPanel(p => !p)} disabled={busy}>
          {busy ? 'AI 讀取中…' : '＋ 匯入'}
        </button>
      </div>

      {panel && !busy && (
        <div className="tile" style={{ margin: '8px 0', padding: 12 }}>
          <label className="btn sm" style={{ display: 'inline-block', cursor: 'pointer' }}>
            📅 當日單字（全部算今天）
            <input type="file" multiple accept="image/*,.pdf,.xlsx,.csv,.docx,.txt" style={{ display: 'none' }} onChange={e => doImport(e, 'today')} />
          </label>
          <div className="row" style={{ marginTop: 10 }}>
            <label className="btn sm" style={{ cursor: 'pointer' }}>
              📚 整本分配（從今天起）
              <input type="file" multiple accept="image/*,.pdf,.xlsx,.csv,.docx,.txt" style={{ display: 'none' }} onChange={e => doImport(e, 'spread')} />
            </label>
            <span className="muted">一天</span>
            <input type="number" min="1" max="200" value={perDay} onChange={e => setN(e.target.value)} style={{ width: 58 }} />
            <span className="muted">個</span>
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>可一次選多張照片/檔案（最多 12 份）；分配後每天的份量會自動出現在首頁</div>
        </div>
      )}

      {cur.length
        ? <><Section kind="單字" /><Section kind="片語" /></>
        : <div className="muted" style={{ margin: '6px 0' }}>{busy ? 'AI 正在讀取單字…' : '拍下要背的單字，AI 自動整理成英文＋中文＋片語；整本匯入會照份量分配到每天'}</div>}
    </div>
  );
}
