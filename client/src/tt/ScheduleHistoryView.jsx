import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { BottomSheet, Button, EmptyState, PageHeader, SurfaceCard } from './ui';

const SOURCE = { bootstrap: '初始轉換', initial: '建立排程', ai_replan: '重新排程', manual: '手動調整', restore: '恢復版本' };
const REASON = {
  past: '安排時間已過去', deadline: '目前期限已早於原安排日期',
  fixed_event: '與目前的固定行程衝突', schedule_collision: '版本內有重疊時段',
};
const fmt = v => v ? String(v).replace('T', ' ').slice(0, 16) : '';
const placement = blocks => (blocks || []).map(b => `${b.date}${b.start_time ? ` ${b.start_time}${b.end_time ? `–${b.end_time}` : ''}` : ''}`).join('、');

function VersionDiff({ diff }) {
  if (!diff) return null;
  if (diff.is_initial) return <SurfaceCard style={{ marginTop: 'var(--sp-3)' }}>
    <b>初次建立排程</b><div className="ui-meta" style={{ marginTop: 4 }}>此版本建立了 {diff.summary.added} 個安排。</div>
  </SurfaceCard>;
  const items = diff.items.filter(item => item.type !== 'unchanged');
  const label = { moved: '時間有調整', added: '新安排', removed: '移出目前安排' };
  return <SurfaceCard style={{ marginTop: 'var(--sp-3)' }}>
    <b>這次改了什麼</b>
    {!items.length && <div className="ui-meta" style={{ marginTop: 6 }}>排程位置沒有變動。</div>}
    <div style={{ marginTop: 'var(--sp-3)', display: 'grid', gap: 8 }}>
      {items.map(item => <div key={item.task_id}>
        <div className="row"><span>{item.task_title_snapshot || `任務 #${item.task_id}`}</span><span className="chip" style={{ marginLeft: 'auto' }}>{label[item.type] || item.type}</span></div>
        <div className="ui-meta" style={{ marginTop: 3 }}>
          {item.type === 'moved' && `${placement(item.before_blocks)} → ${placement(item.after_blocks)}`}
          {item.type === 'added' && `新增到 ${placement(item.after_blocks)}`}
          {item.type === 'removed' && `從 ${placement(item.before_blocks)} 移出排程`}
        </div>
      </div>)}
    </div>
  </SurfaceCard>;
}

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
  const [diff, setDiff] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detailLoadingId, setDetailLoadingId] = useState(null);
  const [detailErrorId, setDetailErrorId] = useState(null);
  const [listError, setListError] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [restoreError, setRestoreError] = useState('');
  const [committedRestore, setCommittedRestore] = useState(null);
  const applyBusy = useRef(false);
  const listBusy = useRef(false);
  const detailRequest = useRef(0);
  const detailBusyId = useRef(null);
  const load = async () => {
    if (listBusy.current) return;
    listBusy.current = true;
    setListLoading(true); setListError('');
    try { setVersions(await api('/schedule/versions')); }
    catch (e) { setListError(e.message || '無法載入排程紀錄'); }
    finally { listBusy.current = false; setListLoading(false); }
  };
  useEffect(() => { load(); }, []);
  async function openVersion(id) {
    if (detailBusyId.current === id) return;
    detailBusyId.current = id;
    const request = ++detailRequest.current;
    setError(''); setDetailErrorId(null); setDetailLoadingId(id);
    setSelected(null); setDiff(null);
    try {
      const [version, versionDiff] = await Promise.all([
        api(`/schedule/versions/${id}`), api(`/schedule/versions/${id}/diff?include_unchanged=0`),
      ]);
      if (request !== detailRequest.current) return;
      setSelected(version); setDiff(versionDiff);
    } catch (e) {
      if (request === detailRequest.current) {
        setError(e.message || '無法載入版本詳情');
        setDetailErrorId(id);
      }
    } finally {
      if (request === detailRequest.current) {
        detailBusyId.current = null;
        setDetailLoadingId(null);
      }
    }
  }
  async function openRestore() {
    if (!selected || busy) return;
    setBusy(true); setError('');
    setRestoreError('');
    try { setPreview(await api(`/schedule/versions/${selected.version.id}/restore-preview`)); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function applyRestore() {
    if (!preview || busy || applyBusy.current) return;
    applyBusy.current = true;
    setBusy(true); setError('');
    setRestoreError('');
    try {
      const r = await api(`/schedule/versions/${preview.source_version.id}/restore`, {
        method: 'POST', body: { base_version_id: preview.base_version_id, confirm_partial: preview.status === 'partial' },
      });
      if (r.applied) {
        setCommittedRestore(r);
        // 寫入已完成；後續只負責更新投影。先交還鎖，讓 finishRestore
        // 取得自己的同步鎖，避免把成功寫入誤當成可以再次 POST。
        applyBusy.current = false;
        await finishRestore(r);
      }
    } catch (e) {
      if (e.status === 409 && e.payload?.code === 'STALE_SCHEDULE_PREVIEW') {
        setPreview(null);
        setError('排程已更新，請重新預覽後再恢復。');
      } else {
        // 一般網路/API 失敗保留使用者確認中的 preview；錯誤要出現在 sheet 內，
        // 才不會被 modal 遮住，並且能直接重試同一份尚未過期的提案。
        setRestoreError(e.message);
      }
    }
    applyBusy.current = false;
    setBusy(false);
  }
  async function finishRestore(result = committedRestore) {
    if (!result || applyBusy.current) return;
    applyBusy.current = true;
    setBusy(true); setRestoreError('');
    try {
      const nextVersions = await api('/schedule/versions');
      await onRestored?.();
      const id = result.version.version_id;
      const [version, versionDiff] = await Promise.all([
        api(`/schedule/versions/${id}`), api(`/schedule/versions/${id}/diff?include_unchanged=0`),
      ]);
      setVersions(nextVersions); setSelected(version); setDiff(versionDiff);
      setCommittedRestore(null); setPreview(null);
    } catch (e) {
      setRestoreError(`排程已恢復，但畫面暫時無法更新：${e.message || '請再試一次'}`);
    } finally {
      applyBusy.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="main">
      <PageHeader title="排程紀錄" subtitle="查看舊版安排，必要時恢復可行的部分" />
      <div className="main-body">
        {listError && <SurfaceCard tone="warning" style={{ marginBottom: 'var(--sp-3)' }}>
          <div role="alert"><b>暫時無法載入排程紀錄</b><div className="ui-meta" style={{ marginTop: 4 }}>{listError}</div></div>
          <Button variant="secondary" size="sm" style={{ marginTop: 'var(--sp-3)' }} disabled={listLoading} onClick={load}>
            {listLoading ? '重新載入中…' : '重新載入紀錄'}
          </Button>
        </SurfaceCard>}
        {error && <div role="alert"><SurfaceCard tone="warning" style={{ marginBottom: 'var(--sp-3)' }}>
          <div>{error}</div>
          {detailErrorId != null && <Button variant="secondary" size="sm" style={{ marginTop: 8 }} onClick={() => openVersion(detailErrorId)}>重新載入版本</Button>}
        </SurfaceCard></div>}
        {listLoading && <p aria-live="polite">載入排程紀錄中…</p>}
        {!listLoading && !listError && !versions.length && <EmptyState title="還沒有排程紀錄" description="建立第一份正式排程後，版本會出現在這裡。" />}
        {versions.map(v => <SurfaceCard key={v.id} style={{ marginBottom: 'var(--sp-2)', cursor: 'pointer' }}
          role="button" tabIndex={0} onClick={() => openVersion(v.id)} onKeyDown={e => e.key === 'Enter' && openVersion(v.id)}>
          <div className="row"><b>V{v.version_no}</b>{v.id === selected?.version.id && <span className="chip">查看中</span>}{v.id === detailLoadingId && <span className="chip">載入中…</span>}<span className="ui-meta" style={{ marginLeft: 'auto' }}>{SOURCE[v.source] || v.source}</span></div>
          <div className="ui-meta" style={{ marginTop: 5 }}>{v.reason || '未填寫說明'} · {v.block_count} 個安排 · {fmt(v.created_at)}</div>
        </SurfaceCard>)}
        <VersionBlocks version={selected} />
        <VersionDiff diff={diff} />
        {selected && <Button variant="primary" block size="lg" style={{ marginTop: 'var(--sp-4)' }} onClick={openRestore} disabled={busy}>恢復這個版本</Button>}
      </div>
      {preview && <BottomSheet onClose={(busy || committedRestore) ? undefined : () => { setPreview(null); setRestoreError(''); }} label="恢復排程版本">
        <div className="row"><b style={{ fontSize: 17 }}>恢復 V{preview.source_version.version_no}</b><button className="icon-btn" style={{ marginLeft: 'auto' }} disabled={busy || Boolean(committedRestore)} onClick={() => { setPreview(null); setRestoreError(''); }} aria-label="關閉">×</button></div>
        <p className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>
          {preview.status === 'full' ? '所有仍有效的安排都可以恢復。'
            : preview.status === 'partial' ? '部分安排無法恢復；其餘安排可以套用。'
              : preview.status === 'impossible' ? '沒有可恢復的安排。' : '這個版本沒有仍需恢復的安排。'}
        </p>
        {preview.conflicts.map((c, i) => <SurfaceCard key={`${c.task_id}-${i}`} tone="warning" style={{ marginTop: 8 }}>
          <b>{c.block?.task_title_snapshot || `任務 #${c.task_id}`}</b><div className="ui-meta">{c.message || REASON[c.type] || c.type}</div>
        </SurfaceCard>)}
        {preview.unplaced_task_ids.length > 0 && <div className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>套用後將有 {preview.unplaced_task_ids.length} 項任務尚未安排。</div>}
        {restoreError && <div role="alert" className="error" style={{ marginTop: 'var(--sp-3)' }}>{restoreError}</div>}
        {committedRestore
          ? <Button variant="primary" block size="lg" style={{ marginTop: 'var(--sp-4)' }} disabled={busy} onClick={() => finishRestore()}>
              {busy ? '重新載入中…' : '重新載入結果'}
            </Button>
          : (preview.status === 'full' || preview.status === 'partial') && <Button variant="primary" block size="lg" style={{ marginTop: 'var(--sp-4)' }} disabled={busy} onClick={applyRestore}>
          {busy ? '恢復中…' : preview.status === 'partial' ? '恢復可行的部分' : '確認恢復'}
        </Button>}
      </BottomSheet>}
    </div>
  );
}
