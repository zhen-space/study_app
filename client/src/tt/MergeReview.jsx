import { useEffect, useState, useCallback } from 'react';
import { mergePreview, mergeApply } from './material';
import { Button } from './ui';

// 合併／增補目錄的預覽與套用（B2/B3 前端）。
// 先 preview：逐章／內容分類（新增／已存在／疑似重複／順序變更），並在需要時要求
// 使用者確認「順序」與「疑似重複另建」。確認後才 atomic apply。
//
// 這個元件同時服務兩個入口：
//   ・匯入時偵測到同名同科 → 選「合併到現有」
//   ・教材 Detail 的「增加目錄／匯入更多內容」
// 兩者都是把新 TOC 併進 bookId 這本既有書，保留完成度／選取／Task linkage。

const STATUS_LABEL = {
  new: ['新增', 'var(--success, #2f855a)'],
  exists: ['已存在', 'var(--muted, #718096)'],
  suspected_duplicate: ['疑似重複', 'var(--warning, #b7791f)'],
};

function Chip({ status }) {
  const [label, color] = STATUS_LABEL[status] || STATUS_LABEL.exists;
  return <span className="ui-meta" style={{ color, fontWeight: 600 }}>{label}</span>;
}

export default function MergeReview({ bookId, draft, title = '合併目錄', onDone, onCancel }) {
  const [state, setState] = useState({ loading: true, preview: null, error: '' });
  const [confirmOrder, setConfirmOrder] = useState(false);
  const [confirmDup, setConfirmDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyErr, setApplyErr] = useState('');

  const load = useCallback(async () => {
    setState({ loading: true, preview: null, error: '' });
    try {
      const p = await mergePreview(bookId, draft);
      setState({ loading: false, preview: p, error: '' });
    } catch (e) { setState({ loading: false, preview: null, error: e.message || '預覽失敗' }); }
  }, [bookId, draft]);
  useEffect(() => { load(); }, [load]);

  const apply = async () => {
    const p = state.preview;
    if (!p) return;
    setBusy(true); setApplyErr('');
    try {
      const r = await mergeApply(bookId, draft, {
        expectedFingerprint: p.fingerprint, confirmOrder, confirmDuplicates: confirmDup,
      });
      onDone?.(r);
    } catch (e) {
      // stale → 重新預覽；其餘顯示訊息
      if (e.status === 409 && !e.payload?.code) { setApplyErr('教材在預覽後有變動，已重新載入，請再確認一次。'); await load(); }
      else setApplyErr(e.message || '合併失敗');
      setBusy(false);
    }
  };

  if (state.loading) return <div className="am"><div className="am-status" role="status">預覽合併內容中…</div></div>;
  if (state.error) {
    return (
      <div className="am">
        <div className="mt-err" role="alert">{state.error}</div>
        <div className="am-foot"><Button variant="tertiary" onClick={onCancel}>返回</Button></div>
      </div>
    );
  }

  const p = state.preview;
  const c = p.counts || {};
  const needOrder = p.order_status === 'ORDER_CONFIRMATION_REQUIRED';
  const needDup = p.has_suspected_duplicates;
  const canApply = (!needOrder || confirmOrder) && (!needDup || confirmDup);

  return (
    <div className="am">
      <h3 className="am-title">{title}</h3>
      <p className="am-lead">
        新增 {c.new || 0}、已存在 {c.exists || 0}
        {c.suspected_duplicate ? `、疑似重複 ${c.suspected_duplicate}` : ''}
        {c.order_change ? `、順序變更 ${c.order_change}` : ''}。已存在的內容會保留、不重建。
      </p>

      <div style={{ maxHeight: 260, overflow: 'auto', margin: '8px 0' }}>
        {p.chapters.map((ch, i) => (
          <div key={i} style={{ marginTop: i ? 8 : 0 }}>
            <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
              <span style={{ fontWeight: 600 }}>{ch.title}</span>
              <Chip status={ch.status} />
              {ch.order_changed && <span className="ui-meta">順序變更</span>}
            </div>
            {(ch.items || []).filter(it => it.status !== 'exists').map((it, j) => (
              <div key={j} className="row" style={{ gap: 6, marginLeft: 12, alignItems: 'baseline' }}>
                <span className="ui-meta">{it.title}</span><Chip status={it.status} />
              </div>
            ))}
            {(ch.children || []).map((cn, k) => (
              <div key={`c${k}`} className="row" style={{ gap: 6, marginLeft: 12, alignItems: 'baseline' }}>
                <span>{cn.title}</span><Chip status={cn.status} />
              </div>
            ))}
          </div>
        ))}
      </div>

      {needOrder && (
        <label className="row" style={{ gap: 6, marginTop: 6, alignItems: 'baseline' }}>
          <input type="checkbox" checked={confirmOrder} onChange={e => setConfirmOrder(e.target.checked)} />
          <span className="ui-meta">新章節的順序無法自動判定，我確認直接附在最後。</span>
        </label>
      )}
      {needDup && (
        <label className="row" style={{ gap: 6, marginTop: 6, alignItems: 'baseline' }}>
          <input type="checkbox" checked={confirmDup} onChange={e => setConfirmDup(e.target.checked)} />
          <span className="ui-meta">有疑似重複的章節／內容，我確認要另建為新的（不覆寫既有）。</span>
        </label>
      )}
      {applyErr && <div className="mt-err" role="alert" style={{ marginTop: 8 }}>{applyErr}</div>}

      <div className="am-foot" style={{ gap: 8 }}>
        <Button variant="primary" disabled={!canApply || busy} onClick={apply}>{busy ? '合併中…' : '確認合併'}</Button>
        <Button variant="tertiary" onClick={onCancel} disabled={busy}>取消</Button>
      </div>
    </div>
  );
}
