import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { md } from './plans';
import { today } from './helpers';
import { SurfaceCard, Button, EmptyState } from './ui';

// 段考計畫 Plan Detail 的「首屏」——直接用白話回答學生真正想知道的事：
//   1. 考試是哪一天、還剩幾天
//   2. 要讀完哪些範圍：哪一科 → 哪一本教材 → 哪一課／章／單元（含完成勾記）
//   3. 若有安排每天要做的／時段，才在下面列出「每天要做的」
//
// 刻意不先顯示抽象的「段考進度／排程摘要」等工程術語，也不做百分比儀表板當頭條。
// 資料組合自既有端點（material-items 已帶章節路徑、progress-segments、timeline），
// 不新增第二套資料。手機優先。

const daysLeft = end => {
  if (!end) return null;
  const a = new Date(today() + 'T00:00:00Z'), b = new Date(end + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
};

// 完成勾記
const Mark = ({ done }) => (done
  ? <span title="已完成" style={{ color: 'var(--success, #2f855a)' }}>✓</span>
  : <span title="尚未完成" style={{ color: 'var(--muted, #a0aec0)' }}>○</span>);

export default function PlanRangeView({ plan, lists = [], onAddRange, onArrange, onAdjust, onAddManual }) {
  const planId = plan?.planId;
  const editable = plan?.status === 'active' || plan?.status === 'draft';
  const [items, setItems] = useState(null);      // 已選教材內容（含章節路徑）
  const [segs, setSegs] = useState(null);        // 進度分段（哪天前讀完什麼）
  const [timeline, setTimeline] = useState(null); // 每日安排（有排程才有）

  const load = useCallback(async () => {
    if (planId == null) return;
    const [mi, sg, tl] = await Promise.all([
      api(`/plans/${planId}/material-items`).catch(() => []),
      api(`/plans/${planId}/progress-segments`).catch(() => null),
      api(`/schedule/timeline/${planId}`).catch(() => null),
    ]);
    setItems(Array.isArray(mi) ? mi.filter(r => r.selected) : []);
    setSegs(sg && Array.isArray(sg.segments) ? sg : null);
    setTimeline(tl && Array.isArray(tl.segments) ? tl : null);
  }, [planId]);
  useEffect(() => { load(); }, [load]);

  if (planId == null || items == null) return null;

  const subjName = id => (id != null ? (lists.find(l => l.id === id)?.name || null) : null);

  // 範圍分組：科目 → 教材 → 章 → 內容。
  const bySubject = new Map();
  for (const r of items) {
    const sid = r.subject_list_id ?? -1;
    if (!bySubject.has(sid)) bySubject.set(sid, new Map());
    const books = bySubject.get(sid);
    if (!books.has(r.book_id)) books.set(r.book_id, { title: r.book_title || '教材', chapters: new Map() });
    const chs = books.get(r.book_id).chapters;
    const ck = r.chapter_title || '';
    if (!chs.has(ck)) chs.set(ck, []);
    chs.get(ck).push(r);
  }

  // 每個內容的「哪天前」：以進度分段的 scope 對應 end_date（level 1 才有）。
  const dueByItem = new Map();
  for (const s of (segs?.segments || [])) {
    for (const id of (s.scope || [])) if (!dueByItem.has(id)) dueByItem.set(id, s.end_date);
  }

  const total = items.length;
  const done = items.filter(r => r.material_completed).length;
  const dl = daysLeft(plan.end);
  const hasDaily = !!(timeline && (timeline.segments.length || (timeline.unscheduled || []).length));

  return (
    <div style={{ marginTop: 'var(--sp-4)' }}>
      {/* 1. 考試是哪天、剩幾天 */}
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700 }}>
          {plan.end ? `考試 ${md(plan.end)}` : '尚未設定考試日期'}
        </span>
        {dl != null && <span className="ui-meta">{dl > 0 ? `剩 ${dl} 天` : dl === 0 ? '就是今天' : '已過'}</span>}
        {total > 0 && <span className="ui-meta" style={{ marginLeft: 'auto' }}>範圍已完成 {done}／{total}</span>}
      </div>

      {/* 2. 要讀完的範圍：科目 → 教材 → 課／章 */}
      {total === 0 ? (
        <SurfaceCard style={{ marginTop: 'var(--sp-3)' }}>
          <EmptyState
            title="還沒加入要考的範圍"
            description={editable ? '一科一科加入這次要考的教材與課／章，之後可以選要幫你安排到什麼程度。' : '這個計畫沒有加入範圍。'}
            action={editable && onAddRange ? <Button size="sm" variant="primary" onClick={onAddRange}>加入要考的範圍</Button> : null}
          />
        </SurfaceCard>
      ) : (
        <SurfaceCard style={{ marginTop: 'var(--sp-3)' }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <b>要讀完的範圍</b>
            {editable && onAddRange && <Button size="sm" style={{ marginLeft: 'auto' }} onClick={onAddRange}>加入／修改範圍</Button>}
          </div>
          {[...bySubject.entries()].map(([sid, books]) => (
            <div key={sid} style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600 }}>{subjName(sid === -1 ? null : sid) || '未分科目'}</div>
              {[...books.values()].map((book, bi) => (
                <div key={bi} style={{ marginTop: 4, marginLeft: 6 }}>
                  <div className="ui-meta">{book.title}</div>
                  {[...book.chapters.entries()].map(([ch, rows], ci) => {
                    const due = rows.map(r => dueByItem.get(r.content_item_id)).filter(Boolean).sort()[0];
                    const cdone = rows.every(r => r.material_completed);
                    return (
                      <div key={ci} style={{ marginLeft: 6, marginTop: 2 }}>
                        <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                          <Mark done={cdone} />
                          <span style={{ fontWeight: 500 }}>{ch || '（未分章）'}</span>
                          {due && <span className="ui-meta">· {md(due)} 前</span>}
                        </div>
                        {rows.map(r => (
                          <div key={r.content_item_id} className="row" style={{ gap: 6, marginLeft: 16, alignItems: 'baseline' }}>
                            <Mark done={r.material_completed} />
                            <span className="ui-meta" style={{ textDecoration: r.material_completed ? 'line-through' : 'none' }}>{r.title}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
          {/* 老師另外指定、教材庫沒有的範圍：手動補一項（成為這個計畫的任務）。 */}
          {editable && onAddManual && (
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="ghost" onClick={onAddManual}>＋ 老師指定、教材庫沒有的範圍</Button>
            </div>
          )}
          {/* 尚未選擇安排層級（沒有分段、也沒有每日安排）→ 引導選層級 */}
          {editable && !segs?.segments?.length && !hasDaily && onArrange && (
            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <Button size="sm" variant="primary" onClick={onArrange}>選擇要幫你安排到什麼程度</Button>
            </div>
          )}
        </SurfaceCard>
      )}

      {/* 3. 每天要做的（只有排了每日／時段才顯示） */}
      {hasDaily && (
        <SurfaceCard style={{ marginTop: 'var(--sp-4)' }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <b>每天要做的</b>
            {editable && onAdjust && <Button size="sm" style={{ marginLeft: 'auto' }} onClick={onAdjust}>調整</Button>}
          </div>
          <DailyList timeline={timeline} />
        </SurfaceCard>
      )}
    </div>
  );
}

// 每日安排：把 timeline 投影的 segments（同日期區間的內容）攤成「日期 → 內容」。
function DailyList({ timeline }) {
  const byId = new Map((timeline.items || []).map(i => [i.task_id, i]));
  const label = it => {
    if (it?.material && (it.material.item_title || (it.material.path || []).length)) {
      const leaf = (it.material.path || []).slice(-1)[0]?.title;
      return [leaf, it.material.item_title].filter(Boolean).join(' · ') || it.title;
    }
    return it?.title || '';
  };
  return (
    <div>
      {timeline.segments.map((seg, si) => (
        <div key={si} style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600 }}>
            {seg.range_start === seg.range_end ? md(seg.range_start) : `${md(seg.range_start)}–${md(seg.range_end)}`}
          </div>
          {(seg.groups || []).map((g, gi) => (
            <div key={gi} style={{ marginLeft: 6, marginTop: 2 }}>
              {g.subject_name && <span className="ui-meta">{g.subject_name}：</span>}
              {(g.task_ids || []).map(id => byId.get(id)).filter(Boolean).map(it => (
                <span key={it.task_id} style={{ marginRight: 8 }}>{label(it)}</span>
              ))}
            </div>
          ))}
        </div>
      ))}
      {(timeline.unscheduled || []).length > 0 && (
        <div className="ui-meta" style={{ marginTop: 8 }}>還沒排入：{timeline.unscheduled.length} 項</div>
      )}
    </div>
  );
}
