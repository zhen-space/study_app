import { useState } from 'react';
import { importPreview, commitDraft } from './material';
import { fileToPayload } from './vocabImport';
import MaterialDraftEditor, { emptyDraft } from './MaterialDraftEditor';
import { Button } from './ui';

// 「加入教材」。學生只要在兩件事之間選一個：拍照，或自己打。
//
// 兩條路最後都走同一個地方：組出一份 draft →（可以看、可以改）→ 一次建立。
// 拍照那條多的只是「AI 先幫你打好」而已，沒有第二套建立流程，
// 也不會再寫進舊的目錄資料。
//
// 中途取消：什麼都不會建立。AI 讀完的階段也還沒寫任何東西。

export default function AddMaterialFlow({ lists = [], onCancel, onCreated }) {
  const [mode, setMode] = useState(null);      // null｜'photo'｜'manual'
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [problems, setProblems] = useState([]);

  const pick = async e => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    if (files.length > 12) { setErr('一次最多 12 張照片'); return; }
    setBusy(true); setErr(''); setProblems([]);
    setStatus(`AI 讀取 ${files.length} 張照片中，大約 30 秒～1 分鐘…`);
    try {
      const payload = [];
      for (const f of files) payload.push(await fileToPayload(f));
      const r = await importPreview({ files: payload });
      // preview 完全沒有寫任何東西。學生確認之前，這份教材還不存在。
      setDraft(normalize(r.draft));
      setProblems(r.problems || []);
      setStatus('');
    } catch (e2) { setErr(readable(e2)); setStatus(''); }
    finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setErr(''); setProblems([]);
    try {
      const r = await commitDraft(draft);
      onCreated?.(r);
    } catch (e2) {
      setErr(readable(e2));
      setProblems(e2.payload?.problems || []);
    } finally { setBusy(false); }
  };

  if (draft) {
    return (
      <div className="am">
        <h3 className="am-title">{mode === 'photo' ? '確認讀到的內容' : '自己建立教材'}</h3>
        {mode === 'photo' && <p className="am-lead">有讀錯或漏掉的地方可以直接改。</p>}
        <MaterialDraftEditor value={draft} onChange={setDraft} lists={lists}
          busy={busy} error={err} problems={problems}
          submitLabel="建立教材" onSubmit={create}
          onCancel={() => { setDraft(null); setMode(null); setErr(''); setProblems([]); }} />
      </div>
    );
  }

  return (
    <div className="am">
      <h3 className="am-title">加入教材</h3>
      {err && <div className="mt-err" role="alert">{err}</div>}
      {status && <div className="am-status" role="status">{status}</div>}
      <div className="am-choices">
        <label className={'am-choice' + (busy ? ' is-busy' : '')}>
          <span className="am-choice-icon" aria-hidden="true">📷</span>
          <span className="am-choice-main">
            <span className="am-choice-title">拍照／匯入教材目錄</span>
            <span className="am-choice-sub">拍課本目錄，或選 PDF，AI 幫你打好</span>
          </span>
          <input type="file" multiple accept="image/*,.pdf" disabled={busy}
            style={{ display: 'none' }}
            onChange={e => { setMode('photo'); pick(e); }} />
        </label>
        <button type="button" className="am-choice" disabled={busy}
          onClick={() => { setMode('manual'); setDraft(emptyDraft()); }}>
          <span className="am-choice-icon" aria-hidden="true">✏️</span>
          <span className="am-choice-main">
            <span className="am-choice-title">自己建立教材</span>
            <span className="am-choice-sub">一章一章自己輸入</span>
          </span>
        </button>
      </div>
      <div className="am-foot">
        <Button variant="tertiary" onClick={onCancel} disabled={busy}>返回</Button>
      </div>
    </div>
  );
}

// 學生不需要知道伺服器缺哪一把金鑰，他只需要知道現在能做什麼。
// 原始訊息仍然留在伺服器的 log 裡，不是被丟掉。
function readable(e) {
  const m = String(e?.message || '');
  if (/ANTHROPIC_API_KEY|AI 金鑰/.test(m)) {
    return '目前沒辦法自動讀照片，請先用「自己建立教材」輸入。';
  }
  return m || '發生錯誤';
}

// parser 回來的 draft 已經是正式形狀，這裡只補齊編輯器需要的欄位，
// 不做任何結構重組——重組就等於在前端複製一份 hierarchy 契約。
function normalize(d) {
  return {
    book: {
      title: d?.book?.title || '',
      publisher: d?.book?.publisher || '',
      subject_list_id: d?.book?.subject_list_id ?? null,
    },
    chapters: (d?.chapters || []).map(c => ({
      title: c.title || '',
      content_items: (c.content_items || []).map(i => ({ kind: i.kind, title: i.title })),
      children: (c.children || []).map(s => ({
        kind: s.kind, title: s.title || '',
        content_items: (s.content_items || []).map(i => ({ kind: i.kind, title: i.title })),
      })),
    })),
  };
}
