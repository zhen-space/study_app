import { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { BottomSheet, Button, EmptyState, PageHeader, SurfaceCard } from './ui';

const SOURCE = { bootstrap: '初始轉換', initial: '建立排程', ai_replan: '重新排程', manual: '手動調整', restore: '恢復版本' };
const REASON = {
  past: '安排時間已過去', deadline: '目前期限已早於原安排日期',
  fixed_event: '與目前的固定行程衝突', schedule_collision: '版本內有重疊時段',
};
const fmt = v => v ? String(v).replace('T', ' ').slice(0, 16) : '';

function VersionBlocks({ version }) {
  if (!version) return null;
  return (
    <SurfaceCard style={{ marginTop: 'var(--sp-3)' }}>
      <b>V{version.version.version_no}</b>
      <div className="ui-meta" style={{ marginTop: 4 }}>{version.blocks.length} 個安排</div>
      <div style={{ marginTop: 'var(--sp-3)', display: 'grid', gap: 8 }}>
        {version.blocks.map(b => <div key={b.id} className="row" style={{ gap: 8 }}>
          <Icon name="calendar" size={15} style={{ opacity: .65 }} />
          <span>{b.date}{b.start_time ? ` ${b.start_time}${b.end_time ? `–${b.end_time}` : ''}` : ''}</span>
          <span className="ui-meta" style={{ marginLeft: 'auto' }}>{b.task_title_snapshot || `任務 #${b.task_id}`}</span>
        </div>)}
      </div>
    </SurfaceCard>
  );
}

export default function ScheduleHistoryView({ onRestored }) {
  const [versions, setVersions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    try { setVersions(await api('/schedule/versions')); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);
  async function openVersion(id) {
    setError('');
    try { setSelected(await api(`/schedule/versions/${id}`)); } catch (e) { setError(e.message); }
  }
  async function openRestore() {
    if (!selected) return;
    setBusy(true); setError('');
    try { setPreview(await api(`/schedule/versions/${selected.version.id}/restore-preview`)); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function applyRestore() {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const r = await api(`/schedule/versions/${preview.source_version.id}/restore`, {
        method: 'POST', body: { base_version_id: preview.base_version_id, confirm_partial: preview.status === 'partial' },
      });
      if (r.applied) { setPreview(null); await load(); await onRestored?.(); await openVersion(r.version.version_id); }
    } catch (e) { setError(e.message); }
    setBusy(false);
  }
  return (
    <div className="main">
      <PageHeader title="排程紀錄" subtitle="查看舊版安排，必要時恢復可行的部分" />
      <div className="main-body">
        {error && <SurfaceCard tone="warning" style={{ marginBottom: 'var(--sp-3)' }}>{error}</SurfaceCard>}
        {!versions.length && <EmptyState title="還沒有排程紀錄" description="建立第一份正式排程後，版本會出現在這裡。" />}
        {versions.map(v => <SurfaceCard key={v.id} style={{ marginBottom: 'var(--sp-2)', cursor: 'pointer' }}
          role="button" tabIndex={0} onClick={() => openVersion(v.id)} onKeyDown={e => e.key === 'Enter' && openVersion(v.id)}>
          <div className="row"><b>V{v.version_no}</b>{v.id === selected?.version.id && <span className="chip">查看中</span>}<span className="ui-meta" style={{ marginLeft: 'auto' }}>{SOURCE[v.source] || v.source}</span></div>
          <div className="ui-meta" style={{ marginTop: 5 }}>{v.reason || '未填寫說明'} · {v.block_count} 個安排 · {fmt(v.created_at)}</div>
        </SurfaceCard>)}
        <VersionBlocks version={selected} />
        {selected && <Button variant="primary" block size="lg" style={{ marginTop: 'var(--sp-4)' }} onClick={openRestore} disabled={busy}>恢復這個版本</Button>}
      </div>
      {preview && <BottomSheet onClose={() => setPreview(null)} label="恢復排程版本">
        <div className="row"><b style={{ fontSize: 17 }}>恢復 V{preview.source_version.version_no}</b><button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setPreview(null)} aria-label="關閉">×</button></div>
        <p className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>
          {preview.status === 'full' ? '所有仍有效的安排都可以恢復。'
            : preview.status === 'partial' ? '部分安排無法恢復；其餘安排可以套用。'
              : preview.status === 'impossible' ? '沒有可恢復的安排。' : '這個版本沒有仍需恢復的安排。'}
        </p>
        {preview.conflicts.map((c, i) => <SurfaceCard key={`${c.task_id}-${i}`} tone="warning" style={{ marginTop: 8 }}>
          <b>{c.block?.task_title_snapshot || `任務 #${c.task_id}`}</b><div className="ui-meta">{c.message || REASON[c.type] || c.type}</div>
        </SurfaceCard>)}
        {preview.unplaced_task_ids.length > 0 && <div className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>套用後將有 {preview.unplaced_task_ids.length} 項任務尚未安排。</div>}
        {(preview.status === 'full' || preview.status === 'partial') && <Button variant="primary" block size="lg" style={{ marginTop: 'var(--sp-4)' }} disabled={busy} onClick={applyRestore}>
          {preview.status === 'partial' ? '恢復可行的部分' : '確認恢復'}
        </Button>}
      </BottomSheet>}
    </div>
  );
}
