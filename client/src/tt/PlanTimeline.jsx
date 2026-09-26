import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { md } from './plans';
import { SurfaceCard, Button, EmptyState } from './ui';

// 段考進度時間軸：讀後端 projection（/schedule/timeline/:planId），把「日期區間 → 應完成內容」
// 直接呈現給學生，不必再開 Calendar。預設按日期區間排列、同區間按科目分組；點開才看每日安排。
// 完全不自己重算排程，也不冒充完成——一切以後端投影的 CURRENT world 為準。

const RANGE_LABEL = (a, b) => (a === b ? md(a) : `${md(a)}–${md(b)}`);
const dueLabel = it => (it.deadline_time ? `${md(it.deadline_date)} ${it.deadline_time} 前` : `${md(it.deadline_date)} 前`);

// 一個 item 的顯示標題：Material 用「教材末節 · 內容」，其餘用 task title。
function itemTitle(it) {
  if (it.material && (it.material.item_title || (it.material.path || []).length)) {
    const leaf = (it.material.path || []).slice(-1)[0]?.title;
    return [leaf, it.material.item_title].filter(Boolean).join(' · ') || it.title;
  }
  return it.title;
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
        {it.locked && <span className="ui-meta" title="已鎖定">🔒</span>}
        {it.warnings?.includes('past_due') && <span className="ui-meta" style={{ color: 'var(--warning, #b7791f)' }}>已過期限</span>}
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

export default function PlanTimeline({ plan, onAddContent, onAdjust }) {
  const planId = plan?.planId;
  const [state, setState] = useState({ loading: true, data: null });
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (planId == null) { setState({ loading: false, data: null }); return; }
    try {
      const d = await api(`/schedule/timeline/${planId}`);
      // 只認得出 timeline 形狀（有 segments 陣列）才顯示；否則不擋畫面、不顯示。
      setState({ loading: false, data: d && Array.isArray(d.segments) ? d : null });
    } catch { setState({ loading: false, data: null }); }
  }, [planId]);
  useEffect(() => { load(); }, [load]);

  if (state.loading || !state.data) return null;
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
        <b>段考進度</b>
        <div style={{ marginTop: 8 }}>
          <EmptyState
            title={t.no_active_schedule ? '這個計畫還沒有安排' : '目前沒有可顯示的進度'}
            description="加入教材或作業，並排一次進度後，這裡會顯示每段日期要完成什麼。"
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
      <div className="row" style={{ alignItems: 'baseline' }}>
        <b>段考進度</b>
        <span className="ui-meta">從哪天到哪天、要讀完什麼</span>
        <Button size="sm" style={{ marginLeft: 'auto' }} onClick={() => setExpanded(v => !v)}>
          {expanded ? '收合每日安排' : '展開每日安排'}
        </Button>
      </div>

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
              {it.warnings?.includes('deadline_violation') && <span className="ui-meta">排在期限之後</span>}
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
              {it.warnings?.includes('missing_estimate') && <span className="ui-meta" style={{ color: 'var(--warning, #b7791f)' }}>缺預估時間</span>}
            </div>
          ))}
          {onAdjust && <Button size="sm" style={{ marginTop: 8 }} onClick={onAdjust}>安排這些內容</Button>}
        </div>
      )}
    </SurfaceCard>
  );
}
