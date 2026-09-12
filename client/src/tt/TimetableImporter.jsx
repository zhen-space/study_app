import { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';

// 課表匯入 v2 的唯一前端流程：照片 → 辨識 → 結構草稿 → 檢視/修正 → 明確確認 → fixed_events。
//
// 硬性：
//   ・星期對應由伺服器結構層依「絕對欄位位置」決定，前端不重算星期。
//   ・低信心 / 有缺欄（requires_mapping_confirmation）時，確認鈕維持 server + client 雙重 gate：
//     使用者要先勾「我確認上面的星期是對的」，後端 confirm 也會再擋一次。
//   ・辨識後絕不直接寫入；只有按下確認才呼叫 /import/timetable/confirm，寫進既有 fixed_events。
//
// 這個元件同時給 Calendar 與 Wizard 兩個入口用，確保「只有一條 timetable pipeline」。
const WDN = ['日', '一', '二', '三', '四', '五', '六'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export default function TimetableImporter({ payload, imageUrl, onClose, onImported }) {
  const [preview, setPreview] = useState(null);   // 伺服器回來的辨識結果
  const [ok, setOk] = useState(false);            // 使用者已確認星期對應
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 拿到檔案就辨識一次（永遠只回 preview，不寫入）
  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true); setError('');
      try {
        const p = await api('/import/timetable', { method: 'POST', body: payload });
        if (!alive) return;
        if (!p.items?.length) { setError('沒有讀到課程，請拍清楚一點再試一次'); setPreview({ ...p, items: [] }); }
        else { setPreview({ ...p, items: p.items.map(x => ({ ...x, checked: true })) }); setOk(false); }
      } catch (e) {
        if (alive) setError('辨識失敗：' + (e.message || '請再試一次'));
      } finally { if (alive) setBusy(false); }
    })();
    return () => { alive = false; };
  }, [payload]);

  const upd = (i, patch) =>
    setPreview(t => ({ ...t, items: t.items.map((x, j) => j === i ? { ...x, ...patch } : x) }));
  const removeRow = i =>
    setPreview(t => ({ ...t, items: t.items.filter((_, j) => j !== i) }));
  // 補上漏掉的課：新增一列空白，預設掛在第一個缺欄對應的星期（沒有就星期一）
  const addRow = () => setPreview(t => {
    const dow = (t.missing_weekdays && t.missing_weekdays[0] != null) ? t.missing_weekdays[0] : 1;
    return { ...t, items: [...t.items, { day_of_week: dow, title: '', start_time: '', end_time: '', checked: true, added: true, uncertain: true }] };
  });
  // 整週往前／往後一天：一次改完，不用逐格改
  const shiftWeek = delta => setPreview(t => ({
    ...t,
    items: t.items.map(x => ({ ...x, day_of_week: ((x.day_of_week + delta) % 7 + 7) % 7 })),
  }));

  async function confirm() {
    const picked = preview.items.filter(x => x.checked);
    if (!picked.length) { setError('沒有勾選任何課程'); return; }
    for (const x of picked) {
      if (!String(x.title || '').trim()) { setError('有一堂課沒有名稱，請補上或取消勾選'); return; }
      if (!TIME_RE.test(x.start_time || '') || !TIME_RE.test(x.end_time || '')) {
        setError(`「${x.title || '未命名'}」的時間要像 08:10，請補上`); return;
      }
      if (x.end_time <= x.start_time) { setError(`「${x.title}」的結束時間要晚於開始時間`); return; }
    }
    setBusy(true); setError('');
    try {
      const { imported } = await api('/import/timetable/confirm', {
        method: 'POST',
        body: {
          items: picked.map(({ checked, uncertain, added, ...b }) => b),
          requires_mapping_confirmation: !!preview.requires_mapping_confirmation,
          mapping_confirmed: ok,
        },
      });
      await onImported?.(imported);
      onClose?.();
    } catch (e) {
      // 後端第二道 gate：低信心未確認會回 409，這時把確認提示打開
      if (e.payload?.code === 'mapping_confirmation_required' || e.code === 'mapping_confirmation_required') {
        setError('星期對應尚未確認，請先勾選「我確認上面的星期是對的」再匯入');
      } else {
        setError('匯入失敗：' + (e.message || '請再試一次'));
      }
      setBusy(false);
    }
  }

  if (!preview) {
    return (
      <div className="tile" style={{ margin: '8px 0' }}>
        {busy ? <div className="muted">辨識中…</div> : <div className="muted" role="alert">{error || '辨識中…'}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm ghost" onClick={onClose}>取消</button>
        </div>
      </div>
    );
  }

  const requires = !!preview.requires_mapping_confirmation;
  const gateBlocked = requires && !ok;

  return (
    <div className="tile tt-import" style={{ margin: '8px 0' }}>
      <b>課表辨識結果（共 {preview.items.length} 堂）</b>

      {/* 原始照片：讓使用者一邊對照原圖一邊修正 */}
      {imageUrl && (
        <details className="tt-image" style={{ margin: '6px 0' }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>看原始照片</summary>
          <img src={imageUrl} alt="上傳的課表原圖" style={{ maxWidth: '100%', borderRadius: 8, marginTop: 6 }} />
        </details>
      )}

      {requires && (
        <div className="tt-warn" style={{ margin: '6px 0', padding: '8px 10px', borderRadius: 10, background: 'var(--primary-soft)', color: 'var(--primary)', fontSize: 13 }}>
          {preview.warnings?.includes('missing_weekday_header')
            ? '這張課表上看不到「星期一、星期二…」的標題，所以星期是照欄位位置推的。請先確認下面每一堂課的星期對不對。'
            : '星期對應可能不準，請先確認下面每一堂課的星期對不對。'}
          {preview.missing_weekdays?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              可能有整欄漏掉：星期{preview.missing_weekdays.map(d => WDN[d]).join('、')} 那一欄看起來是空的。
              如果那天其實有課，請用下面的「＋ 新增漏掉的課」補上；不要把其他天往前挪。
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            整週對錯一天的話，用這兩個按鈕一次改完：
            <button className="btn sm ghost" style={{ marginLeft: 6 }} onClick={() => shiftWeek(-1)}>整週往前一天</button>
            <button className="btn sm ghost" style={{ marginLeft: 6 }} onClick={() => shiftWeek(1)}>整週往後一天</button>
          </div>
          <label className="row" style={{ marginTop: 8, gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={ok} onChange={() => setOk(v => !v)} />
            <span>我確認上面的星期是對的</span>
          </label>
        </div>
      )}

      {error && <div className="muted" role="alert" style={{ color: 'var(--danger, #e03131)', margin: '6px 0' }}>{error}</div>}

      {preview.items.map((c, i) => (
        <div key={i} className={'imp-row' + (c.uncertain ? ' tt-uncertain' : '')}>
          <input type="checkbox" aria-label={`勾選第 ${i + 1} 堂`} checked={c.checked} onChange={() => upd(i, { checked: !c.checked })} />
          {c.uncertain && <span className="tt-flag" title="這一筆信心較低，請再確認" aria-label="低信心" style={{ color: 'var(--warning, #f59f00)' }}>⚠</span>}
          <select className="imp-date" aria-label={`第 ${i + 1} 堂星期`} value={c.day_of_week} onChange={e => upd(i, { day_of_week: +e.target.value })}>
            {WDN.map((n, d) => <option key={d} value={d}>{`週${n}`}</option>)}
          </select>
          <input className="imp-title" value={c.title || ''} placeholder="課程名稱" onChange={e => upd(i, { title: e.target.value })} />
          <input className="imp-time" value={c.start_time || ''} placeholder="08:10" onChange={e => upd(i, { start_time: e.target.value })} />
          <span className="muted">–</span>
          <input className="imp-time" value={c.end_time || ''} placeholder="09:00" onChange={e => upd(i, { end_time: e.target.value })} />
          <button className="icon-btn" title="刪除" aria-label={`刪除第 ${i + 1} 堂`} onClick={() => removeRow(i)}><Icon name="x" size={13} /></button>
        </div>
      ))}

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm ghost" onClick={addRow}>＋ 新增漏掉的課</button>
      </div>

      {!preview.can_persist && (
        <div className="muted" style={{ marginTop: 8 }}>這張課表讀不出可用的結構，請換一張更清楚的照片。</div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="btn sm"
          style={{ marginLeft: 'auto' }}
          disabled={busy || !preview.can_persist || gateBlocked}
          onClick={confirm}
        >確認匯入</button>
        <button className="btn sm ghost" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

// 從 fileToPayload 的 base64 還原成可預覽的 data URL
export const payloadToImageUrl = p =>
  (p && p.data && (p.mime || '').startsWith('image/')) ? `data:${p.mime};base64,${p.data}` : null;
