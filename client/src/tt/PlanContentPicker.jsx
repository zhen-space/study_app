import { useEffect, useMemo, useState } from 'react';
import { getBookTree, listShelf, flattenItems } from './material';
import { BottomSheet, Button, EmptyState } from './ui';

// Active Plan 的「＋加入內容」。這裡只收集 intent；不 PATCH task.plan_id、不寫
// plan_material_items。真正的 attach / selection / ScheduleVersion 一律在 rolling apply
// 的同一個 transaction 內完成。
export default function PlanContentPicker({ planId, tasks = [], lists = [], onClose, onPreview }) {
  const [tab, setTab] = useState('tasks');
  const [taskIds, setTaskIds] = useState(new Set());
  const [materialIds, setMaterialIds] = useState(new Set());
  const [books, setBooks] = useState([]);
  const [bookId, setBookId] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const standalone = useMemo(() => tasks.filter(t => t.plan_id == null && !t.deleted && !t.completed && !t.cancelled), [tasks]);
  const shownTasks = standalone.filter(t => tab === 'school' ? t.task_kind === 'school_assignment' : t.task_kind !== 'school_assignment');
  const listOf = id => lists.find(l => Number(l.id) === Number(id));

  useEffect(() => {
    if (tab !== 'materials' || books.length) return;
    setLoading(true);
    listShelf({ planId }).then(r => setBooks((r.books || []).filter(b => b.material_book_id != null)))
      .catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [tab, planId, books.length]);

  const openBook = async id => {
    setBookId(id); setLoading(true); setError('');
    try {
      const tree = await getBookTree(id, { planId });
      setItems(flattenItems(tree).filter(i => !i.completed && !i.selected));
    } catch (e) { setError(e.message); }
    setLoading(false);
  };
  const toggle = (setter, id) => setter(s => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const count = taskIds.size + materialIds.size;
  const submit = () => onPreview({
    addTaskIds: [...taskIds],
    materialSelections: [...materialIds].map(id => ({ content_item_id: id, client_key: `mat-${id}` })),
  });

  return (
    <BottomSheet onClose={onClose} label="加入內容">
      <b style={{ fontSize: 18 }}>加入這次段考</b>
      <div className="ui-meta" style={{ marginTop: 2 }}>先預覽新版安排；確認前不會改動任務或行事曆。</div>
      <div className="row" role="tablist" style={{ marginTop: 'var(--sp-3)', gap: 'var(--sp-2)' }}>
        {[['tasks', '既有任務'], ['school', '學校作業'], ['materials', '教材範圍']].map(([v, label]) => (
          <Button key={v} size="sm" variant={tab === v ? 'primary' : 'secondary'} onClick={() => setTab(v)}>{label}</Button>
        ))}
      </div>
      {error && <div className="error" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{error}</div>}
      <div style={{ marginTop: 'var(--sp-3)', maxHeight: '52vh', overflow: 'auto' }}>
        {(tab === 'tasks' || tab === 'school') && (shownTasks.length ? shownTasks.map(t => (
          <label key={t.id} className="ui-row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={taskIds.has(t.id)} onChange={() => toggle(setTaskIds, t.id)} />
            <span className="ui-row-main"><b>{t.title}</b><span className="ui-meta">{listOf(t.list_id)?.name || '未分科目'}{t.deadline_date ? ` · 截止 ${t.deadline_date}${t.deadline_time ? ' ' + t.deadline_time : ''}` : ''}</span></span>
          </label>
        )) : <EmptyState title={tab === 'school' ? '沒有可加入的學校作業' : '沒有可加入的既有任務'} />)}
        {tab === 'materials' && !bookId && (loading ? <div className="ui-meta">讀取教材中…</div>
          : books.length ? books.map(b => <button key={b.material_book_id} className="plan-section-row" onClick={() => openBook(b.material_book_id)}><span>{b.title}</span><span>›</span></button>)
            : <EmptyState title="沒有可用教材" description="請先到教材庫加入教材。" />)}
        {tab === 'materials' && bookId && (
          <>
            <button className="page-back" onClick={() => { setBookId(null); setItems([]); }}>← 選其他教材</button>
            {loading ? <div className="ui-meta">讀取內容中…</div> : items.length ? items.map(i => (
              <label key={i.id} className="ui-row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={materialIds.has(i.id)} onChange={() => toggle(setMaterialIds, i.id)} />
                <span className="ui-row-main"><b>{i.title}</b><span className="ui-meta">{(i.path || []).join(' › ')} · {i.estimated_minutes || '未填'} 分鐘</span></span>
              </label>
            )) : <EmptyState title="這本教材沒有可加入的內容" />}
          </>
        )}
      </div>
      <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
        <Button variant="tertiary" onClick={onClose}>取消</Button>
        <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={!count} onClick={submit}>預覽安排（{count}）</Button>
      </div>
    </BottomSheet>
  );
}
