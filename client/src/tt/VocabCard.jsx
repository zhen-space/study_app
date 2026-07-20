import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';

// 首頁單字區：每天拍一張要背的單字照片，AI 讀出英文／中文／片語分類
export default function VocabCard() {
  const [items, setItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vocabCache') || '[]'); } catch { return []; }
  });
  const [busy, setBusy] = useState(false);
  const [day, setDay] = useState(today());
  const load = () => api('/import/vocab').then(list => {
    setItems(list);
    try { localStorage.setItem('vocabCache', JSON.stringify(list)); } catch {}
  }).catch(() => {});
  useEffect(() => { load(); }, []);

  const dates = [...new Set(items.map(x => x.date))].sort().reverse(); // 新→舊
  const cur = items.filter(x => x.date === day);
  const di = dates.indexOf(day);

  async function upload(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const r = await api('/import/vocab', { method: 'POST', body: { filename: file.name, mime: file.type, data: btoa(bin) } });
      if (!r.added) alert('AI 沒有在照片中找到單字');
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
          <button className="icon-btn" disabled={di >= dates.length - 1} onClick={() => setDay(dates[di + 1] || dates[dates.length - 1])}>◀</button>
          <span className="muted" style={{ fontSize: 12 }}>{day === today() ? '今天' : `${+day.slice(5, 7)}/${+day.slice(8)}`}</span>
          <button className="icon-btn" disabled={di <= 0} onClick={() => setDay(dates[di - 1] || dates[0])}>▶</button>
        </>}
        <label className="btn sm ghost" style={{ marginLeft: 'auto', cursor: 'pointer' }}>
          {busy ? 'AI 讀取中…' : '＋ 拍照加入'}
          <input type="file" accept="image/*,.pdf" capture="environment" style={{ display: 'none' }} onChange={upload} disabled={busy} />
        </label>
      </div>
      {cur.length
        ? <><Section kind="單字" /><Section kind="片語" /></>
        : <div className="muted" style={{ margin: '6px 0' }}>{busy ? 'AI 正在讀取單字…' : '拍下今天要背的單字，AI 會自動整理成英文＋中文＋片語'}</div>}
    </div>
  );
}
