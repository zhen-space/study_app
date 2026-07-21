import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';
import { resumePending, importing } from './vocabImport';

// 首頁單字區：只顯示「今天要背的單字表」；匯入與整理在「單字本」頁
export default function VocabCard({ goVocab }) {
  const [items, setItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vocabCache') || '[]'); } catch { return []; }
  });
  const [busy, setBusy] = useState(false);
  const load = () => api('/import/vocab').then(list => {
    setItems(list);
    try { localStorage.setItem('vocabCache', JSON.stringify(list)); } catch {}
  }).catch(() => {});
  useEffect(() => {
    load();
    // 單字解析到一半退出 App → 從首頁重開也會自動接著做
    if (resumePending((r, err) => { setBusy(false); if (!err) load(); })) setBusy(true);
    else if (importing()) setBusy(true);
    const onUpd = () => { setBusy(false); load(); };
    window.addEventListener('vocab-updated', onUpd);
    return () => window.removeEventListener('vocab-updated', onUpd);
  }, []);

  const cur = items.filter(x => x.date === today());
  // 單字為主、片語附屬：點單字展開「含這個字的片語」；沒對到單字的片語列在最後
  const [openW, setOpenW] = useState(null);
  const words = cur.filter(x => x.kind !== '片語');
  const phrases = cur.filter(x => x.kind === '片語');
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phrasesOf = w => phrases.filter(p => new RegExp(`\\b${esc(w.english.trim())}`, 'i').test(p.english));
  const matched = new Set();
  words.forEach(w => phrasesOf(w).forEach(p => matched.add(p.id)));
  const loose = phrases.filter(p => !matched.has(p.id));
  const Row = (x, sub) => (
    <div key={x.id} className={'vocab-row' + (sub ? ' vocab-sub' : '')}>
      <span className="vocab-en" style={x.color ? { color: x.color } : {}}>{x.english}</span>
      <span className="vocab-zh">{x.chinese}</span>
      <span />
    </div>
  );

  return (
    <div className="tgroup" style={{ marginTop: 24, borderTop: '2px dashed var(--border)', paddingTop: 12 }}>
      <div className="glabel" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        📸 今日單字{cur.length ? `（${cur.length}）` : ''}
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={goVocab}>單字本</button>
      </div>
      {busy && <div className="muted" style={{ margin: '4px 0' }}>AI 正在讀取單字…（可離開，回來會繼續）</div>}
      {cur.length
        ? <>
          {words.map(x => {
            const ps = phrasesOf(x);
            return (
              <div key={x.id}>
                <div className="vocab-row" style={{ cursor: ps.length ? 'pointer' : 'default' }}
                  onClick={() => ps.length && setOpenW(openW === x.id ? null : x.id)}>
                  <span className="vocab-en" style={x.color ? { color: x.color } : {}}>
                    {x.english}{ps.length ? <span className="muted" style={{ fontWeight: 400 }}> {openW === x.id ? '▾' : '▸'}{ps.length}</span> : null}
                  </span>
                  <span className="vocab-zh">{x.chinese}</span>
                  <span />
                </div>
                {openW === x.id && ps.map(p => Row(p, true))}
              </div>
            );
          })}
          {loose.map(p => Row(p))}
        </>
        : !busy && <div className="muted" style={{ margin: '6px 0' }}>今天沒有要背的單字——到「單字本」拍照匯入，或整本分配每天的份量</div>}
    </div>
  );
}
