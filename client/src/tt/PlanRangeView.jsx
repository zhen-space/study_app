import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { md } from './plans';
import { today } from './helpers';
import { SurfaceCard, Button, EmptyState } from './ui';

// 段考計畫 Plan Detail 的「首屏」——白話回答學生真正想知道的：
//   1. 每一科考試哪一天（各科可不同；整個段考最後一天＝plan.target_date）
//   2. 要讀完哪些範圍：科目 → 教材 → 課/章/單元（含完成勾記）＋ 老師指定範圍
//   3. 若選了每天要做的／具體時段，才在下面列出「每天要做的」
// 資料來自 GET /plans/:id/exam（各科考試日 + 教材路徑 + 手動 scope）與 timeline。
// 不先顯示抽象「段考進度／排程摘要」或百分比儀表板；不做平均分段。手機優先。

const daysLeft = end => {
  if (!end) return null;
  const a = new Date(today() + 'T00:00:00Z'), b = new Date(end + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
};
const Mark = ({ done }) => (done
  ? <span title="已完成" style={{ color: 'var(--success, #2f855a)' }}>✓</span>
  : <span title="尚未完成" style={{ color: 'var(--muted, #a0aec0)' }}>○</span>);

export default function PlanRangeView({ plan, lists = [], onAddRange, onArrange, onAdjust, onAddManual }) {
  const planId = plan?.planId;
  const editable = plan?.status === 'active' || plan?.status === 'draft';
  const [exam, setExam] = useState(null);
  const [timeline, setTimeline] = useState(null);

  const load = useCallback(async () => {
    if (planId == null) return;
    const [ex, tl] = await Promise.all([
      api(`/plans/${planId}/exam`).catch(() => null),
      api(`/schedule/timeline/${planId}`).catch(() => null),
    ]);
    setExam(ex && Array.isArray(ex.subjects) ? ex : { subjects: [], material: [], manual_scope: [], plan: {} });
    setTimeline(tl && Array.isArray(tl.segments) ? tl : null);
  }, [planId]);
  useEffect(() => { load(); }, [load]);

  if (planId == null || exam == null) return null;

  const subjects = exam.subjects || [];
  const material = exam.material || [];
  const manual = exam.manual_scope || [];
  const total = material.length + manual.length;
  const done = material.filter(r => r.material_completed).length;
  const overallEnd = exam.plan?.target_date || plan.end;
  const dl = daysLeft(overallEnd);
  const hasDaily = !!(timeline && (timeline.segments.length || (timeline.unscheduled || []).length));

  // 依科目分組（科目→教材→章）＋該科手動 scope。
  const rowsBySubject = new Map();
  for (const s of subjects) rowsBySubject.set(Number(s.subject_list_id), { subject: s, books: new Map(), manual: [] });
  const bucket = sid => {
    const k = Number(sid);
    if (!rowsBySubject.has(k)) rowsBySubject.set(k, { subject: { subject_list_id: k, subject_name: lists.find(l => Number(l.id) === k)?.name, exam_date: overallEnd }, books: new Map(), manual: [] });
    return rowsBySubject.get(k);
  };
  for (const r of material) {
    const b = bucket(r.subject_list_id);
    if (!b.books.has(r.book_id)) b.books.set(r.book_id, { title: r.book_title || '教材', chapters: new Map() });
    const chs = b.books.get(r.book_id).chapters;
    const ck = r.chapter_title || '';
    if (!chs.has(ck)) chs.set(ck, []);
    chs.get(ck).push(r);
  }
  for (const m of manual) bucket(m.subject_list_id).manual.push(m);

  return (
    <div style={{ marginTop: 'var(--sp-4)' }}>
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700 }}>{overallEnd ? `段考到 ${md(overallEnd)}` : '尚未設定考試日期'}</span>
        {dl != null && <span className="ui-meta">{dl > 0 ? `剩 ${dl} 天` : dl === 0 ? '就是今天' : '已過'}</span>}
        {total > 0 && <span className="ui-meta" style={{ marginLeft: 'auto' }}>範圍已完成 {done}／{total}</span>}
      </div>

      {total === 0 ? (
        <SurfaceCard style={{ marginTop: 'var(--sp-3)' }}>
          <EmptyState title="還沒加入要考的範圍"
            description={editable ? '一科一科加入這次要考的教材與課／章。' : '這個計畫沒有加入範圍。'}
            action={editable && onAddRange ? <Button size="sm" variant="primary" onClick={onAddRange}>加入要考的範圍</Button> : null} />
        </SurfaceCard>
      ) : (
        <SurfaceCard style={{ marginTop: 'var(--sp-3)' }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <b>要讀完的範圍</b>
            {editable && onAddRange && <Button size="sm" style={{ marginLeft: 'auto' }} onClick={onAddRange}>加入／修改範圍</Button>}
          </div>
          {[...rowsBySubject.values()].filter(g => g.books.size || g.manual.length).map((g, gi) => (
            <div key={gi} style={{ marginTop: 12 }}>
              <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600 }}>{g.subject.subject_name || '未分科目'}</span>
                {g.subject.exam_date && <span className="ui-meta">考試 {md(g.subject.exam_date)}</span>}
              </div>
              {[...g.books.values()].map((book, bi) => (
                <div key={bi} style={{ marginTop: 4, marginLeft: 6 }}>
                  <div className="ui-meta">{book.title}</div>
                  {[...book.chapters.entries()].map(([ch, rows], ci) => (
                    <div key={ci} style={{ marginLeft: 6, marginTop: 2 }}>
                      <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                        <Mark done={rows.every(r => r.material_completed)} />
                        <span style={{ fontWeight: 500 }}>{ch || '（未分章）'}</span>
                      </div>
                      {rows.map(r => (
                        <div key={r.content_item_id} className="row" style={{ gap: 6, marginLeft: 16, alignItems: 'baseline' }}>
                          <Mark done={r.material_completed} />
                          <span className="ui-meta" style={{ textDecoration: r.material_completed ? 'line-through' : 'none' }}>{r.title}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
              {g.manual.map(m => (
                <div key={`m${m.id}`} className="row" style={{ gap: 6, marginLeft: 6, marginTop: 2, alignItems: 'baseline' }}>
                  <span>📝 {m.label}</span><span className="ui-meta">老師指定</span>
                </div>
              ))}
            </div>
          ))}
          {editable && onAddManual && (
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="ghost" onClick={onAddManual}>＋ 老師指定、教材庫沒有的範圍</Button>
            </div>
          )}
          {editable && !hasDaily && onArrange && (
            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <Button size="sm" variant="primary" onClick={onArrange}>要不要幫你排出每天要做的？</Button>
            </div>
          )}
        </SurfaceCard>
      )}

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
