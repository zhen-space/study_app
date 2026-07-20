import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';

// 首頁單字區：只顯示「今天要背的單字表」；匯入與整理在「單字本」頁
export default function VocabCard({ goVocab }) {
  const [items, setItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vocabCache') || '[]'); } catch { return []; }
  });
  useEffect(() => {
    api('/import/vocab').then(list => {
      setItems(list);
      try { localStorage.setItem('vocabCache', JSON.stringify(list)); } catch {}
    }).catch(() => {});
  }, []);

  const cur = items.filter(x => x.date === today());
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
          </div>
        ))}
      </>
    );
  };

  return (
    <div className="tgroup" style={{ marginTop: 24, borderTop: '2px dashed var(--border)', paddingTop: 12 }}>
      <div className="glabel" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        📸 今日單字{cur.length ? `（${cur.length}）` : ''}
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={goVocab}>單字本</button>
      </div>
      {cur.length
        ? <><Section kind="單字" /><Section kind="片語" /></>
        : <div className="muted" style={{ margin: '6px 0' }}>今天沒有要背的單字——到「單字本」拍照匯入，或整本分配每天的份量</div>}
    </div>
  );
}
