import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { md } from './plans';
import { SurfaceCard, Button, EmptyState } from './ui';

// 排程摘要（確切安排 B 層的唯讀摘要）：讀後端 projection（/schedule/timeline/:planId），
// 把「已排定的每日安排」按日期區間、科目分組直接呈現，不必再開 Calendar。
// 這是「確切安排」的摘要，不是「段考進度」——段考進度（哪天以前讀完哪些範圍）由
// ProgressPlan（plan_progress_segments）負責。這裡完全不自己重算排程，也不冒充
// 完成，一切以後端投影的 CURRENT world 為準；沒有 active 排程就顯示空狀態。

const RANGE_LABEL = (a, b) => (a === b ? md(a) : `${md(a)}–${md(b)}`);
const dueLabel = it => (it.deadline_time ? `${md(it.deadline_date)} ${it.deadline_time} 前` : `${md(it.deadline_date)} 前`);

// 一個 item 的顯示標題：Material 用「教材末節 · 內容」，其餘用 task title。
function itemTitle(it) {
  if (it.material && (it.material.item_title || (it.material.path || []).length)) {
    const leaf = (it.material.path || []).slice(-1)[0]?.title;
    return [it.material.book_title, leaf, it.material.item_title].filter(Boolean).join(' · ') || it.title;
  }
  return it.kind === 'manual' ? `老師指定：${it.title}` : it.title;
}

const STATUS_LABEL = {
  today: '今天', past_due: '已逾期', upcoming: '接下來', schedule_gap: '安排有缺口',
};
const REASON_LABEL = {
  missing_estimate: '尚未填預估時間',
  schedule_gap: '尚未排入目前生效的日期安排',
  deadline_violation: '目前安排超過期限',
};

function StatusLabel({ status }) {
  if (!STATUS_LABEL[status]) return null;
  const warning = status === 'past_due' || status === 'schedule_gap';
  return <span className="ui-meta" style={{ color: warning ? 'var(--warning, #b7791f)' : undefined }}>{STATUS_LABEL[status]}</span>;
}

function CompletionDot({ completion }) {
  if (completion === 'completed') return <span title="已完成" style={{ color: 'var(--success, #2f855a)' }}>✓</span>;
  if (completion === 'in_progress') return <span title="進行中" style={{ color: 'var(--accent, #3182ce)' }}>◐</span>;
  return <span title="尚未開始" style={{ color: 'var(--muted, #a0aec0)' }}>○</span>;
}

function ItemLine({ it, expanded }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
        <CompletionDot completion={it.completion} />
        <span style={{ textDecoration: it.completion === 'completed' ? 'line-through' : 'none' }}>{itemTitle(it)}</span>
        <StatusLabel status={it.time_status} />
        {it.locked && <span className="ui-meta" title="已鎖定">🔒</span>}
      </div>
      {expanded && it.day_blocks?.length > 0 && (
        <div className="ui-meta" style={{ marginLeft: 18, marginTop: 2 }}>
          {it.day_blocks.map(b => (
            <div key={b.block_id}>
              {md(b.date)}{b.start_time && b.end_time ? ` ${b.start_time}–${b.end_time}` : ''}
              {b.planned_minutes ? `（${b.planned_minutes} 分）` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PlanTimeline({ plan, onAddContent, onAdjust, refreshKey = 0 }) {
  const planId = plan?.planId;
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    void refreshKey;
    if (planId == null) { setState({ loading: false, data: null, error: '' }); return; }
    setState(s => ({ ...s, loading: true, error: '' }));
    try {
      const d = await api(`/schedule/timeline/${planId}`);
      if (!d || !Array.isArray(d.segments)) throw new Error('日期安排資料格式不正確');
      setState({ loading: false, data: d, error: '' });
    } catch (e) {
      setState(s => ({ loading: false, data: s.data, error: e.message || '無法載入日期安排' }));
    }
  }, [planId, refreshKey]);
  useEffect(() => { load(); }, [load]);

  if (state.loading && !state.data) return <div className="ui-meta" style={{ marginTop: 'var(--sp-5)' }}>正在載入日期安排…</div>;
  if (state.error && !state.data) return (
    <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
      <b>日期安排</b>
      <div role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{state.error}</div>
      <Button size="sm" style={{ marginTop: 10 }} onClick={load}>重試</Button>
    </SurfaceCard>
  );
  if (!state.data) return null;
  const t = {
    segments: [], deadlines: [], gaps: [], unscheduled: [], items: [],
    no_active_schedule: false, ...state.data,
  };
  const byId = new Map((t.items || []).map(i => [i.task_id, i]));
  const hasAnything = t.segments.length || t.deadlines.length || t.gaps.length || t.unscheduled.length;

  // 空狀態：沒有可呈現的計畫安排 → 引導「加入內容」或「調整計畫」。
  if (!hasAnything) {
    return (
      <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
        <b>日期安排</b>
        <div style={{ marginTop: 8 }}>
          <EmptyState
            title={t.no_active_schedule ? '這個計畫還沒有確切安排' : '目前沒有可顯示的排程'}
            description="加入教材或作業，並排一次確切安排後，這裡會顯示每天要做的具體項目。"
          />
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            {onAddContent && <Button size="sm" variant="primary" onClick={onAddContent}>加入內容</Button>}
            {onAdjust && <Button size="sm" onClick={onAdjust}>調整計畫</Button>}
          </div>
        </div>
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
      <div className="row" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <b>日期安排</b>
        <span className="ui-meta">目前生效的確切安排</span>
        <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => setExpanded(v => !v)}>
          {expanded ? '收合每日安排' : '展開每日安排'}
        </Button>
      </div>
      {state.error && <div role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{state.error} <Button size="sm" onClick={load}>重試</Button></div>}

      {/* 日期區間 → 應完成內容（同區間按科目分組）。 */}
      {t.segments.map((seg, si) => (
        <div key={`seg${si}`} style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600 }}>{RANGE_LABEL(seg.range_start, seg.range_end)}</div>
          {seg.groups.map((g, gi) => (
            <div key={`g${gi}`} style={{ marginTop: 4, marginLeft: 6 }}>
              {g.subject_name && <div className="ui-meta" style={{ fontWeight: 600 }}>{g.subject_name}</div>}
              {g.task_ids.map(id => byId.get(id)).filter(Boolean).map(it => (
                <ItemLine key={it.task_id} it={it} expanded={expanded} />
              ))}
            </div>
          ))}
        </div>
      ))}

      {/* 老師要求的繳交／完成期限（不與日期區間混列）。 */}
      {t.deadlines.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="ui-meta" style={{ fontWeight: 600 }}>要交／要完成</div>
          {t.deadlines.map(it => (
            <div key={it.task_id} className="row" style={{ gap: 6, marginTop: 4, alignItems: 'baseline' }}>
              <CompletionDot completion={it.completion} />
              <span>{dueLabel(it)}：{itemTitle(it)}</span>
              {it.subject_name && <span className="ui-meta">{it.subject_name}</span>}
              <StatusLabel status={it.time_status} />
            </div>
          ))}
        </div>
      )}

      {/* 排不下／期限衝突：明確標記，不假裝有完成區間。 */}
      {t.gaps.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="ui-meta" style={{ fontWeight: 600, color: 'var(--warning, #b7791f)' }}>需要調整（排不下或期限衝突）</div>
          {t.gaps.map(it => (
            <div key={it.task_id} className="row" style={{ gap: 6, marginTop: 4, alignItems: 'baseline' }}>
              <span aria-hidden="true">⚠️</span>
              <span>{itemTitle(it)}</span>
              <StatusLabel status="schedule_gap" />
              {it.warnings?.includes('deadline_violation') && <span className="ui-meta">{REASON_LABEL.deadline_violation}</span>}
            </div>
          ))}
          {onAdjust && <Button size="sm" style={{ marginTop: 8 }} onClick={onAdjust}>調整計畫</Button>}
        </div>
      )}

      {/* 尚未排入：另列，不混進正常時間軸。 */}
      {t.unscheduled.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="ui-meta" style={{ fontWeight: 600 }}>尚未排入（{t.unscheduled.length}）</div>
          {t.unscheduled.map(it => (
            <div key={it.task_id} className="row" style={{ gap: 6, marginTop: 4, alignItems: 'baseline' }}>
              <span className="ui-meta">•</span>
              <span>{itemTitle(it)}</span>
              <StatusLabel status={it.time_status || 'schedule_gap'} />
              <span className="ui-meta" style={{ color: 'var(--warning, #b7791f)' }}>
                {it.warnings?.map(w => REASON_LABEL[w]).filter(Boolean)[0] || REASON_LABEL.schedule_gap}
              </span>
            </div>
          ))}
          {onAdjust && <Button size="sm" style={{ marginTop: 8 }} onClick={onAdjust}>安排這些內容</Button>}
        </div>
      )}
    </SurfaceCard>
  );
}
