import { useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { usePlans, md } from './plans';
import { Button, IconButton, PageHeader, SurfaceCard, ProgressBar, ListRow, BottomSheet, EmptyState } from './ui';

// 「計畫」＝計畫管理：回答「我要完成什麼計畫」。
//
// UI-R2 起改用 Design System v1：Plan 本身是主角，管理功能收進 secondary。
// 首頁只放「進行中」的卡片；已暫停／已結束／已完成／舊資料收成一行，點進去才展開——
// 不然 Plans 首頁很快就變成歷史資料庫。
//
// 資料來源在 ./plans.js：正式 Plan（後端 plans 表）＋ 還沒 migrate 的舊資料推導。
// 兩者並存，舊的標上「舊資料」而且不提供正式計畫才有的管理操作。

const STATUS_LABEL = { draft: '草稿', paused: '已暫停', completed: '已完成', ended: '已結束' };

// 科目只用小圓點識別，不整張卡染色
function Subjects({ subjects }) {
  if (!subjects.length) return null;
  return (
    <div className="row" style={{ gap: 'var(--sp-2)', fontSize: 13, color: 'var(--text-2)' }}>
      {subjects.slice(0, 3).map((s, i) => (
        <span key={String(s.id)} className="row" style={{ gap: 5 }}>
          <span className="dot" style={{ width: 7, height: 7, background: s.color }} />
          {s.name}{i < Math.min(subjects.length, 3) - 1 ? '' : ''}
        </span>
      ))}
      {subjects.length > 3 && <span>＋{subjects.length - 3}</span>}
    </div>
  );
}

function PlanCard({ p, onOpen }) {
  const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
  // 只在真的需要時說一句話，不要一排 chip
  const note = p.total === 0 ? '還沒有任務'
    : p.overdue > 0 ? '進度需要調整'
      : p.unplaced.length > 0 ? `尚未安排 ${p.unplaced.length} 項`
        : '';
  return (
    <SurfaceCard className="plan-card" style={{ marginTop: 'var(--sp-3)', cursor: 'pointer' }}
      role="button" tabIndex={0} onClick={() => onOpen(p.key)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p.key); } }}>
      {/* 長中文計畫名要能換行、日期靠右不被擠掉。
          用 grid 而不是 flex：flex 的收縮在中文長字串上不夠可靠，
          實測 375px 時標題會直接壓到日期上面。 */}
      <div className="plan-card-head">
        <div className="plan-card-title">
          <b style={{ fontSize: 17 }}>{p.name}</b>
          {p.isLegacy && <span className="chip">舊資料</span>}
          {!p.isLegacy && STATUS_LABEL[p.status] && <span className="chip">{STATUS_LABEL[p.status]}</span>}
        </div>
        {p.end && <span className="ui-meta plan-card-date">{md(p.end)}</span>}
      </div>
      <div className="row" style={{ marginTop: 'var(--sp-3)', alignItems: 'center', gap: 'var(--sp-3)' }}>
        <span style={{ fontSize: 15, fontWeight: 650, minWidth: 44 }}>{pct}%</span>
        <span style={{ flex: 1 }}>
          <ProgressBar value={p.done} max={p.total} label={`${p.name}：${p.total} 項中已完成 ${p.done} 項`} />
        </span>
      </div>
      <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
        <Subjects subjects={p.subjects} />
        {note && <span className="ui-meta" style={{ marginLeft: 'auto' }}>{note}</span>}
      </div>
    </SurfaceCard>
  );
}

// 次要區塊（已暫停／已結束／已完成／舊資料）：先收成一行，點了才展開
function SectionRow({ label, count, open, onToggle }) {
  return (
    <button className="plan-section-row" aria-expanded={open} onClick={onToggle}>
      <span>{label}</span>
      <span className="ui-meta">{count}</span>
      <Icon name="chevron" size={16} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--motion-fast) var(--ease)' }} />
    </button>
  );
}

export default function PlansView({ tasks, lists, apiPlans = [], openPlan, goWizard, reload }) {
  const plans = usePlans(tasks, lists, apiPlans);
  const [creating, setCreating] = useState(false);
  const [blankName, setBlankName] = useState('');
  const [showBlank, setShowBlank] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState({});           // 哪幾個次要區塊被展開

  const real = plans.filter(p => !p.isLegacy);
  // 封存功能已移除。一般分類只有四種：進行中／已暫停／已完成／已結束。
  // 既有 archived 舊資料維持 read compatibility，依 archived_from_status 投影：
  //   completed → 已完成、ended → 已結束；其他來源不猜，落到「其他」（唯讀可見）。
  const cat = p => {
    if (p.status !== 'archived') return p.status;
    if (p.archived_from_status === 'completed') return 'completed';
    if (p.archived_from_status === 'ended') return 'ended';
    return 'other';
  };
  const live = real.filter(p => cat(p) === 'active' || cat(p) === 'draft');
  // 暫停的計畫必須看得見——它是「先不排時間」，不是不見了。
  const paused = real.filter(p => cat(p) === 'paused');
  // 已結束＝保留進度但不再繼續，是正式的一種結果，必須有自己的區塊。
  const ended = real.filter(p => cat(p) === 'ended');
  const done = real.filter(p => cat(p) === 'completed');
  // 落到「其他」的只剩：無法歸類的 archived 舊資料，或未來新增又漏接的狀態。
  // 沒有這一段的話，這些計畫會從畫面上安靜消失。
  const KNOWN = ['active', 'draft', 'paused', 'ended', 'completed'];
  const other = real.filter(p => !KNOWN.includes(cat(p)));
  const legacy = plans.filter(p => p.isLegacy);

  const closeSheet = () => { setCreating(false); setShowBlank(false); setErr(''); };

  async function createBlank() {
    const name = blankName.trim() || '新的計畫';
    setBusy(true); setErr('');
    try {
      const plan = await api('/plans', { method: 'POST', body: { name, status: 'active', source: 'manual' } });
      closeSheet(); setBlankName('');
      await reload();              // 讓新計畫進到清單，明細才讀得到
      openPlan(`plan:${plan.id}`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  const toggle = k => setOpen(o => ({ ...o, [k]: !o[k] }));

  return (
    <div className="main">
      <PageHeader
        title="計畫"
        subtitle={live.length ? `${live.length} 個進行中` : ''}
        actions={<IconButton label="建立計畫" onClick={() => setCreating(true)}><Icon name="plus" size={20} /></IconButton>}
      />
      <div className="main-body">
        {plans.length === 0 && (
          <EmptyState
            title="還沒有計畫"
            description="建立一個讀書計畫，讓 AI 幫你把內容安排到每天。"
            action={<Button variant="primary" size="lg" onClick={() => setCreating(true)}>建立計畫</Button>}
          />
        )}

        {live.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}

        {/* 次要區塊：預設收合，視覺權重明顯低於進行中 */}
        <div style={{ marginTop: 'var(--section-gap)' }}>
          {paused.length > 0 && (
            <>
              <SectionRow label="已暫停" count={paused.length} open={!!open.paused} onToggle={() => toggle('paused')} />
              {open.paused && paused.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}
            </>
          )}
          {ended.length > 0 && (
            <>
              <SectionRow label="已結束" count={ended.length} open={!!open.ended} onToggle={() => toggle('ended')} />
              {open.ended && ended.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}
            </>
          )}
          {done.length > 0 && (
            <>
              <SectionRow label="已完成" count={done.length} open={!!open.done} onToggle={() => toggle('done')} />
              {open.done && done.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}
            </>
          )}
          {other.length > 0 && (
            <>
              <SectionRow label="其他" count={other.length} open={!!open.other} onToggle={() => toggle('other')} />
              {open.other && other.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}
            </>
          )}
          {legacy.length > 0 && (
            <>
              <SectionRow label="舊資料" count={legacy.length} open={!!open.legacy} onToggle={() => toggle('legacy')} />
              {open.legacy && <>
                <div className="ui-meta" style={{ padding: '0 0 var(--sp-1)' }}>還沒轉成正式計畫，只能查看</div>
                {legacy.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}
              </>}
            </>
          )}
        </div>
      </div>

      {creating && (
        <BottomSheet onClose={closeSheet} label="建立計畫">
          <div className="row">
            <b style={{ fontSize: 17 }}>建立計畫</b>
            <IconButton label="關閉" style={{ marginLeft: 'auto' }} onClick={closeSheet}><Icon name="x" size={16} /></IconButton>
          </div>
          {!showBlank ? (
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <Button variant="primary" size="lg" block onClick={goWizard}>
                <Icon name="wizard" size={18} />AI 幫我安排
              </Button>
              <div className="ui-meta" style={{ margin: 'var(--sp-2) 0 var(--sp-5)', textAlign: 'center' }}>
                拍教材或選內容，由 AI 建立安排
              </div>
              <ListRow
                title="建立空白計畫" subtitle="先建立，再自己加入任務"
                trailing={<Icon name="chevron" size={16} />}
                role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                onClick={() => setShowBlank(true)}
                onKeyDown={e => { if (e.key === 'Enter') setShowBlank(true); }}
              />
            </div>
          ) : (
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <label className="ui-meta" htmlFor="blank-plan-name">計畫名稱</label>
              <input id="blank-plan-name" aria-label="計畫名稱" value={blankName} autoFocus
                onChange={e => setBlankName(e.target.value)} placeholder="例如：第二次段考準備"
                style={{ width: '100%', marginTop: 'var(--sp-1)' }}
                onKeyDown={e => e.key === 'Enter' && createBlank()} />
              <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
                <Button onClick={() => setShowBlank(false)}>返回</Button>
                <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={createBlank}>
                  {busy ? '建立中…' : '建立'}
                </Button>
              </div>
            </div>
          )}
          {err && <div className="error" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
        </BottomSheet>
      )}
    </div>
  );
}
