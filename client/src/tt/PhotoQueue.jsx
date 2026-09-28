import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

// 拍照／選相片匯入教材目錄的「收集 → 檢視 → 確認」佇列。
//
// 為什麼需要它：手機相機一次只拍一張、拍完就離開 <input>；舊流程每拍一張就直接送 AI、
// 跳到編輯畫面，等於一次只能一頁。這裡把「多次選取／連續拍攝」累積成一個有順序的佇列，
// 使用者可以看縮圖、頁碼、順序，移除、重拍、上下移動，最後一次確認才送出解析。
//
// 兩個入口分開：
//   ・選多張：<input multiple>（從相簿一次挑多張既有照片）
//   ・拍下一張：<input capture>（相機拍一張就回來，append 到佇列，不離開流程）
// 平台若支援相機多拍，兩個入口都會累積，不會互相覆蓋。
//
// 上限與清楚繁中錯誤都在這裡先擋一次（伺服器仍會再擋一次，見 routes/material.js）。

const MB = 1024 * 1024;

export default function PhotoQueue({
  onConfirm, onCancel, max = 12, maxFileMB = 10, maxTotalMB = 45, busy = false,
}) {
  const [items, setItems] = useState([]);   // [{ id, file, url }]
  const [err, setErr] = useState('');
  const seq = useRef(0);

  // object URL 生命週期：卸載時全部釋放，避免手機記憶體累積。
  useEffect(() => () => { for (const it of items) if (it.url) URL.revokeObjectURL(it.url); }, [items]);

  const totalBytes = items.reduce((n, it) => n + (it.file.size || 0), 0);
  const isImage = f => (f?.type || '').startsWith('image/');
  const accepted = f => f && (isImage(f) || f.type === 'application/pdf');

  const addFiles = fileList => {
    const incoming = [...(fileList || [])].filter(accepted);
    if (!incoming.length) { setErr('請選擇照片（JPG／PNG／HEIC）或 PDF'); return; }
    const next = [...items];
    for (const f of incoming) {
      if (next.length >= max) { setErr(`一次最多 ${max} 張，超過的沒有加入`); break; }
      if (f.size > maxFileMB * MB) { setErr(`「${f.name || '照片'}」超過單張 ${maxFileMB}MB 上限，沒有加入`); continue; }
      if (next.reduce((n, it) => n + it.file.size, 0) + f.size > maxTotalMB * MB) { setErr(`全部照片合計超過 ${maxTotalMB}MB 上限，後面的沒有加入`); break; }
      next.push({ id: ++seq.current, file: f, url: isImage(f) ? URL.createObjectURL(f) : null });
    }
    setItems(next);
  };

  const removeAt = i => setItems(list => { const it = list[i]; if (it?.url) URL.revokeObjectURL(it.url); return list.filter((_, x) => x !== i); });
  const move = (i, dir) => setItems(list => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return list;
    const copy = [...list];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  });

  const overCount = items.length > max;
  const overTotal = totalBytes > maxTotalMB * MB;
  const canConfirm = items.length > 0 && !overCount && !overTotal && !busy;

  return (
    <div className="pq">
      <h3 className="am-title">拍照／選相片：教材目錄</h3>
      <p className="am-lead">可以一次選多張，或用相機一張一張拍。順序＝之後合併目錄的頁序，送出前可調整。</p>
      {err && <div className="mt-err" role="alert" style={{ marginBottom: 8 }}>{err}</div>}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <label className="am-choice" style={{ cursor: 'pointer', flex: 1, minWidth: 140 }}>
          <span className="am-choice-icon" aria-hidden="true">🖼️</span>
          <span className="am-choice-main"><span className="am-choice-title">選多張照片</span>
            <span className="am-choice-sub">從相簿一次挑多張</span></span>
          <input type="file" accept="image/*,application/pdf" multiple disabled={busy} style={{ display: 'none' }}
            aria-label="選多張照片"
            onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <label className="am-choice" style={{ cursor: 'pointer', flex: 1, minWidth: 140 }}>
          <span className="am-choice-icon" aria-hidden="true">📷</span>
          <span className="am-choice-main"><span className="am-choice-title">{items.length ? '繼續拍下一張' : '拍第一張'}</span>
            <span className="am-choice-sub">拍完自動回到這裡</span></span>
          <input type="file" accept="image/*" capture="environment" disabled={busy} style={{ display: 'none' }}
            aria-label="拍下一張"
            onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
      </div>

      {items.length === 0 ? (
        <div className="ui-meta" style={{ marginBottom: 10 }}>還沒有照片。先選幾張，或拍一張。</div>
      ) : (
        <ul className="pq-list" style={{ listStyle: 'none', padding: 0, margin: '0 0 10px', display: 'grid', gap: 8 }}>
          {items.map((it, i) => (
            <li key={it.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="pq-page" aria-hidden="true" style={{ minWidth: 28, textAlign: 'center', fontWeight: 600 }}>{i + 1}</span>
              {it.url
                ? <img src={it.url} alt={`第 ${i + 1} 頁`} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border,#ddd)' }} />
                : <span aria-hidden="true" style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: '1px solid var(--border,#ddd)', fontSize: 20 }}>📄</span>}
              <span className="ui-meta" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.file.name || `照片 ${i + 1}`}</span>
              <button type="button" className="md-x" aria-label={`第 ${i + 1} 頁上移`} disabled={i === 0 || busy} onClick={() => move(i, -1)}>▲</button>
              <button type="button" className="md-x" aria-label={`第 ${i + 1} 頁下移`} disabled={i === items.length - 1 || busy} onClick={() => move(i, 1)}>▼</button>
              <button type="button" className="md-x" aria-label={`移除第 ${i + 1} 頁`} disabled={busy} onClick={() => removeAt(i)}>✕</button>
            </li>
          ))}
        </ul>
      )}

      <div className="am-foot row" style={{ gap: 8, alignItems: 'center' }}>
        <span className="md-total" aria-live="polite">共 {items.length} 頁 · {(totalBytes / MB).toFixed(1)}MB</span>
        <Button variant="tertiary" onClick={onCancel} disabled={busy}>返回</Button>
        <Button variant="primary" disabled={!canConfirm} onClick={() => onConfirm(items.map(it => it.file))}>
          {busy ? '讀取中…' : `確認送出（${items.length} 頁）`}
        </Button>
      </div>
    </div>
  );
}
