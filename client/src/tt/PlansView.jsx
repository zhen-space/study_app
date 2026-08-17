import { useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { usePlans, md } from './plans';

// 「計畫」＝計畫管理：回答「我要完成什麼計畫」。
//
// 資料來源在 ./plans.js：正式 Plan（後端 plans 表，走 /api/plans）
// ＋ 還沒 migrate 的舊資料推導。兩者並存，舊的會標上「舊資料」而且
// 不提供正式計畫才有的管理操作——它們沒有 plan id，改不動也封存不了。

const STATUS_LABEL = { draft: '草稿', active: '進行中', completed: '已完成', archived: '已封存' };

const Bar = ({ done, total, color }) => (
  <div style={{ height: 6, borderRadius: 3, background: 'var(--fill-strong)', overflow: 'hidden' }}>
    <div style={{ width: `${total ? Math.round(done / total * 100) : 0}%`, height: '100%', background: color, transition: 'width .3s' }} />
  </div>
);

// 跨科摘要：一個 Plan 可以同時有好幾科的任務
const Subjects = ({ subjects }) => (
  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
    {subjects.slice(0, 4).map(s => (
      <span key={String(s.id)} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Icon name={s.icon} size={12} style={{ color: s.color }} />{s.name}
        <span className="muted">{s.count}</span>
      </span>
    ))}
    {subjects.length > 4 && <span className="muted" style={{ fontSize: 12 }}>＋{subjects.length - 4} 科</span>}
  </div>
);

function PlanCard({ p, onOpen }) {
  return (
    <div className="tile" style={{ marginTop: 10, padding: '12px 14px', cursor: 'pointer' }} onClick={() => onOpen(p.key)}>
      <div className="row">
        <Icon name={p.icon} size={18} style={{ color: p.color }} />
        <b style={{ fontSize: 16 }}>{p.name}</b>
        {p.isLegacy && <span className="chip" title="還沒轉成正式計畫的舊資料">舊資料</span>}
        {!p.isLegacy && p.status !== 'active' && <span className="chip">{STATUS_LABEL[p.status] || p.status}</span>}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>{p.done}／{p.total}</span>
      </div>
      <div style={{ marginTop: 8 }}><Bar done={p.done} total={p.total} color={p.color} /></div>
      <div className="row" style={{ marginTop: 6, fontSize: 12 }}>
        {p.end && <span className="muted">目標 {md(p.end)}</span>}
        {p.overdue > 0 && <span style={{ color: 'var(--red)' }}>逾期 {p.overdue} 項</span>}
        {p.unplaced.length > 0 && <span className="muted">尚未安排 {p.unplaced.length} 項</span>}
      </div>
      {p.subjects.length > 0 && <div style={{ marginTop: 6 }}><Subjects subjects={p.subjects} /></div>}
    </div>
  );
}

export default function PlansView({ tasks, lists, apiPlans = [], openPlan, goWizard, reload }) {
  const plans = usePlans(tasks, lists, apiPlans);
  const [creating, setCreating] = useState(false);   // 打開「建立計畫」的選擇
  const [blankName, setBlankName] = useState('');    // 空白計畫的名稱（null＝還沒選這條）
  const [showBlank, setShowBlank] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const real = plans.filter(p => !p.isLegacy);
  const live = real.filter(p => p.status === 'active' || p.status === 'draft');
  const done = real.filter(p => p.status === 'completed');
  const archived = real.filter(p => p.status === 'archived');
  const legacy = plans.filter(p => p.isLegacy);

  async function createBlank() {
    const name = blankName.trim() || '新的計畫';
    setBusy(true); setErr('');
    try {
      const plan = await api('/plans', { method: 'POST', body: { name, status: 'active', source: 'manual' } });
      setCreating(false); setShowBlank(false); setBlankName('');
      await reload();              // 讓新計畫進到清單，明細才讀得到
      openPlan(`plan:${plan.id}`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="main">
      <div className="main-head">
        <h2>計畫</h2>
        <span className="muted">{live.length} 個進行中</span>
      </div>
      <div className="main-body">
        {!creating
          ? <button className="btn" style={{ width: '100%', padding: '11px 0', fontSize: 16 }} onClick={() => setCreating(true)}>
              <Icon name="plus" size={18} style={{ verticalAlign: '-3px', marginRight: 6 }} />建立計畫
            </button>
          : (
            <div className="tile" style={{ padding: '12px 14px', background: 'var(--fill)' }}>
              <div className="row"><b>要怎麼建立？</b>
                <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => { setCreating(false); setShowBlank(false); setErr(''); }}>
                  <Icon name="x" size={14} />
                </button>
              </div>
              {!showBlank ? (
                <>
                  <button className="btn" style={{ width: '100%', marginTop: 10 }} onClick={goWizard}>
                    <Icon name="wizard" size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />AI 幫我安排
                  </button>
                  <div className="muted" style={{ fontSize: 12, margin: '4px 0 10px' }}>拍課本目錄，自動排進每一天</div>
                  <button className="btn ghost" style={{ width: '100%' }} onClick={() => setShowBlank(true)}>建立空白計畫</button>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>先建立計畫，之後再加任務</div>
                </>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>計畫名稱</div>
                  <input value={blankName} onChange={e => setBlankName(e.target.value)} placeholder="例如：第二次段考準備"
                    style={{ width: '100%' }} onKeyDown={e => e.key === 'Enter' && createBlank()} />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn sm ghost" onClick={() => setShowBlank(false)}>返回</button>
                    <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={createBlank}>
                      {busy ? '建立中…' : '建立'}
                    </button>
                  </div>
                </div>
              )}
              {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
            </div>
          )}

        {plans.length === 0 && (
          <div className="muted" style={{ marginTop: 30, textAlign: 'center' }}>
            還沒有計畫——用上面的「建立計畫」開始吧
          </div>
        )}

        {live.length > 0 && <div className="side-sec" style={{ marginTop: 14 }}>進行中</div>}
        {live.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}

        {done.length > 0 && <div className="side-sec" style={{ marginTop: 18 }}>已完成</div>}
        {done.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}

        {legacy.length > 0 && (
          <>
            <div className="side-sec" style={{ marginTop: 18 }}>舊資料</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>
              還沒轉成正式計畫，只能看，不能改名或封存
            </div>
            {legacy.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}
          </>
        )}

        {archived.length > 0 && (
          <>
            <button className="btn sm ghost" style={{ marginTop: 18 }} onClick={() => setShowArchived(v => !v)}>
              {showArchived ? '隱藏已封存' : `顯示已封存（${archived.length}）`}
            </button>
            {showArchived && archived.map(p => <PlanCard key={p.key} p={p} onOpen={openPlan} />)}
          </>
        )}
      </div>
    </div>
  );
}
