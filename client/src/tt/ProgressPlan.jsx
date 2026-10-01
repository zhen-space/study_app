import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api';
import { md } from './plans';
import { SurfaceCard, Button, ProgressBar, EmptyState, BottomSheet } from './ui';

// 段考「進度安排」（A 層）。回答的是「哪一段日期以前，要讀完哪些教材範圍」
// （例：9/28–10/2 數學第一課～第二課），不是每日精確排程（那是 B 層＝確切安排）。
//
// 這一層可以在完全沒有 ScheduledBlock 的情況下獨立存在、被讀、被改。完成度不存
// 在 segment 裡——投影時才把 material_progress 的 CURRENT 完成事實疊上去，算出
// 已完成幾項、落後或超前。這裡完全不排程、不冒充完成。

const STATUS = {
  done: ['完成', 'var(--success, #2f855a)'],
  behind: ['落後', 'var(--warning, #b7791f)'],
  ahead: ['超前', 'var(--accent, #3182ce)'],
  on_track: ['進行中', 'var(--muted, #718096)'],
  upcoming: ['尚未開始', 'var(--muted, #a0aec0)'],
};
const KIND_LABEL = { study: '進度', review: '複習', exam: '模考' };

// 日期區間標籤：有頭有尾用「9/28–10/2」，只有結束日用「10/2 前」。
function rangeLabel(seg) {
  if (seg.start_date && seg.end_date) return `${md(seg.start_date)}–${md(seg.end_date)}`;
  if (seg.end_date) return `${md(seg.end_date)} 前`;
  return '';
}

function StatusChip({ status }) {
  const [label, color] = STATUS[status] || STATUS.on_track;
  return <span className="ui-meta" style={{ color, fontWeight: 600 }}>{label}</span>;
}

// 一段進度的卡片。
function SegmentRow({ seg, editable, onEdit, onDelete }) {
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, #edf2f7)' }}>
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 600 }}>{rangeLabel(seg)}</span>
        {seg.subject_name && <span className="ui-meta">{seg.subject_name}</span>}
        {seg.kind && seg.kind !== 'study' && <span className="ui-meta">· {KIND_LABEL[seg.kind] || seg.kind}</span>}
        <span style={{ marginLeft: 'auto' }}><StatusChip status={seg.status} /></span>
      </div>
      <div style={{ marginTop: 4 }}>{seg.title}</div>
      {seg.total > 0 && (
        <div style={{ marginTop: 6 }}>
          <ProgressBar value={seg.completed_count} max={seg.total}
            label={`${seg.title}：${seg.total} 項中已完成 ${seg.completed_count} 項`} />
          <div className="ui-meta" style={{ marginTop: 2 }}>
            {seg.completed_count} / {seg.total} 範圍已完成（{seg.percent}%）
            {seg.expected_percent != null && `，依配速應約 ${seg.expected_percent}%`}
          </div>
        </div>
      )}
      {seg.total === 0 && <div className="ui-meta" style={{ marginTop: 4 }}>尚未指定教材範圍</div>}
      {editable && (
        <div className="row" style={{ marginTop: 6, gap: 8 }}>
          <Button size="sm" onClick={() => onEdit(seg)}>編輯</Button>
          <Button size="sm" variant="ghost" onClick={() => onDelete(seg)}>刪除</Button>
        </div>
      )}
    </div>
  );
}

// 新增／編輯一段的表單。scope 從這個計畫已選的教材內容挑（不必重新匯入）。
export function SegmentSheet({ planId, lists, selection, initial, onClose, onSaved }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [start, setStart] = useState(initial?.start_date || '');
  const [end, setEnd] = useState(initial?.end_date || '');
  const [subject, setSubject] = useState(initial?.subject_list_id ?? '');
  const [kind, setKind] = useState(initial?.kind || 'study');
  const [scope, setScope] = useState(new Set((initial?.scope || []).map(Number)));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(null);
  // state 更新不是同步的；ref 才能擋住同一個 event turn 的快速重入。
  const saveBusy = useRef(false);

  const toggle = id => setScope(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const save = async () => {
    if (saveBusy.current || committed) return;
    saveBusy.current = true;
    setErr('');
    if (!title.trim()) { saveBusy.current = false; return setErr('請輸入這一段的名稱'); }
    if (!end) { saveBusy.current = false; return setErr('請選結束日期'); }
    setBusy(true);
    try {
      const body = {
        title: title.trim(), start_date: start || null, end_date: end,
        subject_list_id: subject === '' ? null : Number(subject), kind,
        scope: [...scope],
      };
      const path = `/plans/${planId}/progress-segments${initial?.id ? '/' + initial.id : ''}`;
      const data = await api(path, { method: initial?.id ? 'PATCH' : 'POST', body });
      // 從這裡起寫入已成立，不可因父層刷新失敗再次 POST/PATCH。
      setCommitted(data);
      try {
        await onSaved(data);
        setBusy(false);
        saveBusy.current = false;
      } catch (e) {
        setErr(e.message || '重新載入失敗');
        setBusy(false);
        saveBusy.current = false;
      }
    } catch (e) {
      setErr(e.message || '儲存失敗');
      setBusy(false);
      saveBusy.current = false;
    }
  };

  const retrySaved = async () => {
    if (saveBusy.current || !committed) return;
    saveBusy.current = true;
    setBusy(true); setErr('');
    try {
      await onSaved(committed);
      setBusy(false);
      saveBusy.current = false;
    } catch (e) {
      setErr(e.message || '重新載入失敗');
      setBusy(false);
      saveBusy.current = false;
    }
  };

  // 只列尚未完成或已在 scope 內的選取項；已完成的仍顯示但標記，方便理解範圍。
  const items = (selection || []).filter(r => r.selected || scope.has(Number(r.content_item_id)));
  const byBook = new Map();
  for (const r of items) {
    const k = r.book_id ?? 0;
    if (!byBook.has(k)) byBook.set(k, []);
    byBook.get(k).push(r);
  }

  return (
    <BottomSheet onClose={busy ? undefined : onClose} label={initial?.id ? '編輯進度段' : '新增進度段'}>
      {committed ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <b>進度安排已儲存</b>
          <div className="ui-meta">畫面尚未更新，請勿再次儲存。你可以只重試載入最新資料。</div>
          {err && <div role="alert" className="ui-meta" style={{ color: 'var(--danger, #c53030)' }}>
            進度安排已儲存，但畫面暫時無法更新。{err}
          </div>}
          <div className="row" style={{ gap: 8 }}>
            <Button variant="ghost" disabled={busy} onClick={onClose}>先關閉</Button>
            <Button variant="primary" disabled={busy} onClick={retrySaved}>{busy ? '載入中…' : '重新載入'}</Button>
          </div>
        </div>
      ) : (
      <div style={{ display: 'grid', gap: 10 }}>
        <b>{initial?.id ? '編輯這一段進度' : '新增一段進度'}</b>
        <label className="ui-field">
          <span className="ui-meta">這一段要讀完什麼（名稱）</span>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="例：數學第一課～第二課" />
        </label>
        <div className="row" style={{ gap: 8 }}>
          <label className="ui-field" style={{ flex: 1 }}>
            <span className="ui-meta">開始日期（可留空）</span>
            <input type="date" value={start || ''} onChange={e => setStart(e.target.value)} />
          </label>
          <label className="ui-field" style={{ flex: 1 }}>
            <span className="ui-meta">在這天以前讀完</span>
            <input type="date" value={end || ''} onChange={e => setEnd(e.target.value)} />
          </label>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <label className="ui-field" style={{ flex: 1 }}>
            <span className="ui-meta">科目（可留空）</span>
            <select value={subject} onChange={e => setSubject(e.target.value)}>
              <option value="">不指定</option>
              {(lists || []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label className="ui-field" style={{ flex: 1 }}>
            <span className="ui-meta">類型</span>
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="study">進度</option>
              <option value="review">複習</option>
              <option value="exam">模考</option>
            </select>
          </label>
        </div>
        <div>
          <span className="ui-meta">教材範圍（從這個計畫已選的內容挑，不必重新匯入）</span>
          {items.length === 0 && <div className="ui-meta" style={{ marginTop: 4 }}>這個計畫還沒有已選的教材內容。</div>}
          <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 4 }}>
            {[...byBook.values()].map((rows, bi) => (
              <div key={bi} style={{ marginTop: bi ? 8 : 0 }}>
                {rows.map(r => {
                  const id = Number(r.content_item_id);
                  return (
                    <label key={id} className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                      <input type="checkbox" checked={scope.has(id)} onChange={() => toggle(id)} />
                      <span style={{ textDecoration: r.material_completed ? 'line-through' : 'none' }}>{r.title}</span>
                      {r.material_completed && <span className="ui-meta">已完成</span>}
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {err && <div className="ui-meta" style={{ color: 'var(--danger, #c53030)' }}>{err}</div>}
        <div className="row" style={{ gap: 8 }}>
          <Button variant="primary" disabled={busy} onClick={save}>{busy ? '儲存中…' : '儲存'}</Button>
          <Button variant="ghost" disabled={busy} onClick={busy ? undefined : onClose}>取消</Button>
        </div>
      </div>
      )}
    </BottomSheet>
  );
}

export default function ProgressPlan({ plan, lists }) {
  const planId = plan?.planId;
  const editable = plan?.status === 'active' || plan?.status === 'draft';
  const [state, setState] = useState({ loading: true, data: null });
  const [selection, setSelection] = useState([]);
  const [sheet, setSheet] = useState(null); // null | {} (new) | seg (edit)
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const load = useCallback(async () => {
    if (planId == null) { setState({ loading: false, data: null }); return; }
    try {
      const d = await api(`/plans/${planId}/progress-segments`);
      setState({ loading: false, data: d && Array.isArray(d.segments) ? d : null });
    } catch { setState({ loading: false, data: null }); }
  }, [planId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (planId == null || !editable) return;
    api(`/plans/${planId}/material-items`).then(rows => setSelection(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [planId, editable]);

  if (planId == null) return null;
  if (state.loading) return null;
  const data = state.data || { segments: [], summary: {}, empty: true };
  const segments = data.segments || [];

  const openDelete = seg => { setDeleteTarget(seg); setDeleteError(''); };
  const closeDelete = () => {
    if (deleteBusy) return;
    setDeleteTarget(null); setDeleteError('');
  };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true); setDeleteError('');
    try {
      const d = await api(`/plans/${planId}/progress-segments/${deleteTarget.id}`, { method: 'DELETE' });
      setState({ loading: false, data: d });
      setDeleteTarget(null);
    } catch (e) {
      // 保留確認 sheet 與原投影；網路／stale 失敗後可直接重試，不假裝已刪除。
      setDeleteError(e.message || '刪除失敗，請再試一次');
    } finally { setDeleteBusy(false); }
  };

  return (
    <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <b>段考進度</b>
        <span className="ui-meta">哪一段日期以前，要讀完哪些教材範圍</span>
        {editable && (
          <Button size="sm" variant="primary" style={{ marginLeft: 'auto' }} onClick={() => setSheet({})}>新增一段</Button>
        )}
      </div>

      {data.summary?.needs_attention && (
        <div className="ui-meta" style={{ marginTop: 6, color: 'var(--warning, #b7791f)' }}>
          有 {data.summary.behind_count} 段進度落後，考慮調整範圍或期限。
        </div>
      )}

      {segments.length === 0 ? (
        <div style={{ marginTop: 8 }}>
          <EmptyState
            title="還沒有安排段考進度"
            description={editable
              ? '把段考範圍切成幾段（哪天以前讀完哪些內容），這裡就會顯示每段的完成與落後情況——不必先排每日時間。'
              : '這個計畫沒有進度安排。'}
            action={editable ? <Button size="sm" variant="primary" onClick={() => setSheet({})}>安排進度</Button> : null}
          />
        </div>
      ) : (
        segments.map(seg => (
          <SegmentRow key={seg.id} seg={seg} editable={editable} onEdit={s => setSheet(s)} onDelete={openDelete} />
        ))
      )}

      {sheet && (
        <SegmentSheet
          planId={planId} lists={lists} selection={selection}
          initial={sheet.id ? sheet : null}
          onClose={() => setSheet(null)}
          onSaved={d => { setState({ loading: false, data: d }); setSheet(null); }}
        />
      )}
      {deleteTarget && (
        <BottomSheet onClose={closeDelete} label="刪除進度段">
          <b>刪除「{deleteTarget.title}」？</b>
          <div className="ui-meta" style={{ marginTop: 8 }}>
            只會刪除這一段日期與範圍目標；教材完成度與讀書紀錄不會受影響。
          </div>
          {deleteError && <div role="alert" style={{ color: 'var(--danger, #c53030)', marginTop: 8 }}>{deleteError}</div>}
          <div className="row" style={{ marginTop: 16, gap: 8 }}>
            <Button variant="tertiary" disabled={deleteBusy} onClick={closeDelete}>取消</Button>
            <Button variant="primary" disabled={deleteBusy} style={{ marginLeft: 'auto' }} onClick={confirmDelete}>
              {deleteBusy ? '刪除中…' : '確認刪除'}
            </Button>
          </div>
        </BottomSheet>
      )}
    </SurfaceCard>
  );
}
