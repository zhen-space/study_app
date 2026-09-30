import { useState } from 'react';
import { importPreview, commitDraft, nameCheck } from './material';
import { fileToPayload } from './vocabImport';
import MaterialDraftEditor, { emptyDraft } from './MaterialDraftEditor';
import MergeReview from './MergeReview';
import PhotoQueue from './PhotoQueue';
import { Button } from './ui';

// 「加入教材」。學生只要在兩件事之間選一個：拍照，或自己打。
//
// 兩條路最後都走同一個地方：組出一份 draft →（可以看、可以改）→ 一次建立。
// 拍照那條先經過 PhotoQueue（多張選取／連續拍攝／排序／移除／確認），再一次送 AI；
// 沒有第二套建立流程，也不會再寫進舊的目錄資料。
//
// 中途取消：什麼都不會建立。AI 讀完的階段也還沒寫任何東西。
//
// defaultSubjectId（可選）：從某個科目的情境進來（例如段考科目卡）時，預先帶入科目，
//   建立的教材就一定屬於那一科——否則使用者可能建到別科、回到卡片卻找不到、以為「建立失敗」。
// appendToBook（可選）：{ id, title }。設了就是「增加目錄／匯入更多內容」模式——
//   產生 draft 後直接走合併到這本書（略過同名偵測與另存），不建立新書。
export default function AddMaterialFlow({ lists = [], onCancel, onCreated, onAddSubject = null, appendToBook = null, defaultSubjectId = null }) {
  const [mode, setMode] = useState(null);      // null｜'photo'｜'manual'
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [problems, setProblems] = useState([]);
  const [warnings, setWarnings] = useState([]);   // 非阻擋性提醒（重複頁／重複章節需確認、部分頁沒讀到內容）
  // 同名同科三選一：conflict＝偵測到的同名教材清單；mergeTarget＝使用者選擇合併的那本。
  const [conflict, setConflict] = useState(null);   // null | { books: [...] }
  const [mergeTarget, setMergeTarget] = useState(null);

  const withContext = d => {
    if (!d?.book) return d;
    const subjectId = defaultSubjectId ?? appendToBook?.subject_list_id ?? null;
    return {
      ...d,
      book: {
        ...d.book,
        title: d.book.title?.trim() ? d.book.title : (appendToBook?.title || ''),
        subject_list_id: d.book.subject_list_id ?? (subjectId == null ? null : Number(subjectId)),
      },
    };
  };

  const editDraft = next => {
    setDraft(next);
    setErr('');
    setProblems([]);
  };

  // PhotoQueue 確認後：逐張正向＋壓縮 → 一次送 AI 解析。部分頁沒讀到內容會如實標示，不假裝全部成功。
  const parsePhotos = async files => {
    setBusy(true); setErr(''); setProblems([]); setWarnings([]);
    setStatus(`AI 讀取 ${files.length} 張照片中，大約 30 秒～1 分鐘…`);
    try {
      const payload = [];
      for (const f of files) payload.push(await fileToPayload(f));
      const r = await importPreview({
        files: payload,
        subjectListId: defaultSubjectId ?? appendToBook?.subject_list_id ?? null,
        title: appendToBook?.title || '',
      });
      const next = withContext(normalize(r.draft));
      setDraft(next);
      const itemCount = next.chapters.reduce((n, c) =>
        n + c.content_items.length + c.children.reduce((m, child) => m + child.content_items.length, 0), 0);
      setProblems((r.problems || []).filter(p => {
        if (p.path === 'book.title' && next.book.title.trim()) return false;
        if (p.path === 'chapters' && itemCount > 0 && /沒有任何內容項目/.test(p.message || '')) return false;
        return true;
      }));
      setWarnings(r.warnings || []);
      setStatus('');
    } catch (e2) { setErr(readable(e2)); setProblems(e2.payload?.problems || []); setStatus(''); }
    finally { setBusy(false); }
  };

  // 建立前先偵測同名同科：有衝突就要求三選一（合併／另存／取消），未選不 commit。
  const create = async () => {
    if (appendToBook) { setMergeTarget(appendToBook); return; }
    setBusy(true); setErr(''); setProblems([]);
    try {
      const chk = await nameCheck(draft.book.title, draft.book.subject_list_id);
      if (chk.has_conflict) { setConflict({ books: chk.same_name_books || [] }); setBusy(false); return; }
      const r = await commitDraft(draft);
      onCreated?.(r);
    } catch (e2) {
      setErr(readable(e2));
      setProblems(e2.payload?.problems || []);
    } finally { setBusy(false); }
  };

  const saveAsNew = async () => {
    setBusy(true); setErr(''); setProblems([]); setConflict(null);
    try { onCreated?.(await commitDraft(draft)); }
    catch (e2) { setErr(readable(e2)); setProblems(e2.payload?.problems || []); }
    finally { setBusy(false); }
  };

  // 合併到選定的既有教材：交給 MergeReview 走 preview → 確認 → atomic apply。
  if (mergeTarget) {
    return (
      <div className="am">
        <MergeReview bookId={mergeTarget.id} draft={draft} title={`合併到「${mergeTarget.title}」`}
          onDone={r => onCreated?.(r)}
          onCancel={() => setMergeTarget(null)} />
      </div>
    );
  }

  // 同名同科三選一畫面。使用者未選之前，什麼都不寫。
  if (conflict) {
    return (
      <div className="am">
        <h3 className="am-title">已有同名同科目的教材</h3>
        <p className="am-lead">「{draft.book.title}」已經存在。你要合併到現有教材，還是另存成新的？</p>
        {err && <div className="mt-err" role="alert">{err}</div>}
        <div style={{ display: 'grid', gap: 8, margin: '8px 0' }}>
          {conflict.books.map(b => (
            <button key={b.id} type="button" className="am-choice" disabled={busy}
              onClick={() => setMergeTarget(b)}>
              <span className="am-choice-icon" aria-hidden="true">🔀</span>
              <span className="am-choice-main">
                <span className="am-choice-title">合併到「{b.title}」</span>
                <span className="am-choice-sub">保留既有完成度與計畫選取，只補上新內容</span>
              </span>
            </button>
          ))}
          <button type="button" className="am-choice" disabled={busy} onClick={saveAsNew}>
            <span className="am-choice-icon" aria-hidden="true">➕</span>
            <span className="am-choice-main">
              <span className="am-choice-title">另存成新教材</span>
              <span className="am-choice-sub">建立一本全新的教材，與現有的分開</span>
            </span>
          </button>
        </div>
        <div className="am-foot"><Button variant="tertiary" disabled={busy} onClick={() => setConflict(null)}>取消</Button></div>
      </div>
    );
  }

  // 拍照流程：先收集／排序照片，確認後才解析。
  if (mode === 'photo' && !draft) {
    return (
      <div className="am">
        {status && <div className="am-status" role="status" style={{ marginBottom: 8 }}>{status}</div>}
        {err && <div className="mt-err" role="alert" style={{ marginBottom: 8 }}>{err}</div>}
        <PhotoQueue busy={busy}
          onConfirm={parsePhotos}
          onCancel={() => { setMode(null); setErr(''); setStatus(''); }} />
      </div>
    );
  }

  if (draft) {
    return (
      <div className="am">
        <h3 className="am-title">{mode === 'photo' ? '確認讀到的內容' : '自己建立教材'}</h3>
        {mode === 'photo' && <p className="am-lead">有讀錯或漏掉的地方可以直接改。</p>}
        {warnings.length > 0 && (
          <ul className="md-problems" role="status" style={{ borderColor: 'var(--warning,#b7791f)' }}>
            {warnings.map((w, i) => <li key={i}>⚠️ {typeof w === 'string' ? w : w.message}</li>)}
          </ul>
        )}
        <MaterialDraftEditor value={draft} onChange={editDraft} lists={lists} onAddSubject={onAddSubject}
          lockSubjectId={defaultSubjectId}
          busy={busy} error={err} problems={problems}
          submitLabel={appendToBook ? '預覽合併' : '建立教材'} onSubmit={create}
          onCancel={() => { setDraft(null); setMode(null); setErr(''); setProblems([]); setWarnings([]); }} />
      </div>
    );
  }

  return (
    <div className="am">
      <h3 className="am-title">加入教材</h3>
      {err && <div className="mt-err" role="alert">{err}</div>}
      <div className="am-choices">
        <button type="button" className="am-choice" disabled={busy}
          onClick={() => { setMode('photo'); setErr(''); }}>
          <span className="am-choice-icon" aria-hidden="true">📷</span>
          <span className="am-choice-main">
            <span className="am-choice-title">拍照／匯入教材目錄</span>
            <span className="am-choice-sub">拍課本目錄（可多張），AI 幫你打好</span>
          </span>
        </button>
        <button type="button" className="am-choice" disabled={busy}
          onClick={() => { setMode('manual'); setDraft(withContext(emptyDraft())); }}>
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
  const content = (items, fallbackTitle = '') => {
    const out = (items || []).map(i => ({
      kind: i.kind, title: i.title,
      ...(i.estimated_minutes != null ? { estimated_minutes: i.estimated_minutes } : {}),
    }));
    return out.length || !fallbackTitle.trim() ? out : [{ kind: 'reading', title: fallbackTitle.trim() }];
  };
  return {
    book: {
      title: d?.book?.title || '',
      publisher: d?.book?.publisher || '',
      subject_list_id: d?.book?.subject_list_id ?? null,
    },
    chapters: (d?.chapters || []).map(c => {
      const children = (c.children || []).map(s => ({
        kind: s.kind, title: s.title || '',
        content_items: content(s.content_items, s.title || ''),
      }));
      return {
        title: c.title || '',
        content_items: content(c.content_items, children.length ? '' : (c.title || '')),
        children,
      };
    }),
  };
}
