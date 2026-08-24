import { useEffect, useState } from 'react';
import { api } from '../api';
import { BottomSheet, SurfaceCard, Button } from './ui';

// 「為什麼這樣排」。
//
// 兩層，畫面上也照這個順序：確定性的說明先出來，AI 的人話（有的話）補在後面。
// 這樣即使 AI 不可用、逾時或出錯，這一頁仍然回答得了學生的問題——
// AI 不可用只是少了一段話，不是這一頁壞掉。
export default function ExplainSheet({ onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setData(null); setErr('');
    api('/schedule/explain')
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setErr(e.message || '讀不到排程說明'); });
    return () => { alive = false; };
  }, [reloadKey]);

  return (
    <BottomSheet onClose={onClose} label="為什麼這樣排">
      <b style={{ fontSize: 17 }}>為什麼這樣排</b>

      {err ? (
        <>
          <SurfaceCard tone="warning" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{err}</SurfaceCard>
          <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
            <Button onClick={() => setReloadKey(k => k + 1)}>重試</Button>
          </div>
        </>
      ) : !data ? (
        <div className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>讀取中…</div>
      ) : (
        <>
          {/* ① 確定性：從實際的排程、鎖定與已確認條件算出來的 */}
          <div style={{ marginTop: 'var(--sp-3)' }}>
            {data.sentences.map((line, i) => (
              <p key={i} style={{ margin: '0 0 var(--sp-2)' }}>{line}</p>
            ))}
          </div>

          {/* ② AI：有就補一段人話，沒有就講清楚為什麼沒有 */}
          {data.narrative ? (
            <SurfaceCard tone="accent" style={{ marginTop: 'var(--sp-4)' }}>
              <div className="ui-meta" style={{ marginBottom: 'var(--sp-2)' }}>AI 的說明</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{data.narrative}</div>
            </SurfaceCard>
          ) : data.ai?.reason === 'no_api_key' ? (
            <div className="ui-meta" style={{ marginTop: 'var(--sp-4)' }}>
              AI 補充說明目前沒有開啟，上面的內容仍然是這份安排的實際狀況。
            </div>
          ) : data.ai?.reason === 'error' || data.ai?.reason === 'empty_response' ? (
            <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
              <span className="ui-meta" style={{ flex: 1 }}>AI 這次沒有回應，上面的說明不受影響。</span>
              <Button size="sm" onClick={() => setReloadKey(k => k + 1)}>再試一次</Button>
            </div>
          ) : null}

          <div className="ui-meta" style={{ marginTop: 'var(--sp-4)' }}>
            這裡只是說明，不會改動你的安排。要調整請用「調整計畫」或直接改單一時段。
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
        <Button style={{ marginLeft: 'auto' }} onClick={onClose}>關閉</Button>
      </div>
    </BottomSheet>
  );
}
