import { useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { today } from './helpers';
import { usePlans, bookOf, shortTitle, md, byLesson } from './plans';
import { usePlanScheduleHealth } from './planHealth';
import { useActiveSchedule, blocksForTask } from './scheduleAdjust';
import AdjustBlockSheet from './AdjustBlockSheet';
import ReplanSheet from './ReplanSheet';
import ConstraintSheet from './ConstraintSheet';
import { Button, IconButton, PageHeader, SurfaceCard, ProgressBar, ListRow, BottomSheet, EmptyState } from './ui';

// 單一計畫的內容。
//
// UI-R2 起改用 Design System v1：Plan 本身是主角，管理動作收進右上「•••」。
// 分組主軸仍然是「科目」而不是「書」——一個 Plan 可以跨科，書只是標題裡的一段，
// 不是 Plan 的身分。同一科底下有多本書時才再用書名分小段。
//
// 正式 Plan（有 planId）才有改名／改期限／完成／封存；
// 舊資料沒有 plan id，這些操作對它沒有意義，一律不顯示。

const STATUS_LABEL = { draft: '草稿', active: '進行中', completed: '已完成', archived: '已封存' };

// 「調整計畫」的入口：先問要調整哪一段，再深連結到排程精靈對應的位置。
// 一次只調一件事，不用每次都從頭走一遍精靈。
const ADJUST = [
  ['content', '學習內容', '加、減或換讀的範圍'],
  ['deadline', '完成期限', '改開始日、目標日與分配方式'],
  ['time', '可用時間', '看目前的行程與作息（要改請到行事曆）'],
  ['cond', '排程條件', '題型、順序、每天幾項'],
  ['all', '全部設定', '從頭走一次精靈'],
];

export default function PlanDetailView({ planKey, tasks, lists, apiPlans = [], reload, onBack, goWizard, adjustPlan, goLocks }) {
  const plan = usePlans(tasks, lists, apiPlans).find(p => p.key === planKey);
  const [showDone, setShowDone] = useState(false);
  const [sheet, setSheet] = useState(null);   // manage | edit | add | adjust | confirmComplete
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [replan, setReplan] = useState(false);
  const [unresolved, setUnresolved] = useState(0);
  const [nt, setNt] = useState({ title: '', list_id: '', deadline_date: '' });
  const [edit, setEdit] = useState(null);     // 編輯計畫資訊的暫存（按儲存才送出）
  const [adjustBlock, setAdjustBlock] = useState(null);   // { block, task }
  const [legacyPreview, setLegacyPreview] = useState(null);
  // 排定時間的真相在 ScheduledBlock；要讓使用者自己改，就得知道是哪一格。
  const sched = useActiveSchedule();
  // 必須在早退前呼叫，避免資料刷新瞬間找不到 Plan 時違反 React Hook 順序。
  const health = usePlanScheduleHealth(plan, apiPlans.find(p => p.id === plan?.planId));

  if (!plan) {
    return (
      <div className="main">
        <PageHeader title="計畫" />
        <div className="main-body">
          <Button onClick={onBack}>← 回計畫列表</Button>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-5)' }}>找不到這個計畫（可能已經全部刪除了）</div>
        </div>
      </div>
    );
  }

  const isReal = !plan.isLegacy && plan.planId != null;
  const raw = apiPlans.find(p => p.id === plan.planId);
  const showAdjust = isReal && plan.status !== 'archived' && !!adjustPlan;
  const pct = plan.total ? Math.round(plan.done / plan.total * 100) : 0;

  const close = () => { setSheet(null); setErr(''); };

  // 完成任務走既有的 PATCH /tasks/:id，沒有第二套完成邏輯
  const toggle = t =>
    api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: !t.completed } })
      .then(() => reload('tasks')).catch(() => reload('tasks'));

  // 以下全部走 Phase 2A 已有的 /plans API，前端不另外存一份計畫狀態
  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await reload(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const archive = () => run(async () => {
    await api(`/plans/${plan.planId}/archive`, { method: 'POST', body: {} }); close();
  });
  const restore = () => run(async () => {
    await api(`/plans/${plan.planId}/restore`, { method: 'POST', body: {} }); close();
  });
  const restart = () => run(async () => {
    await api(`/plans/${plan.planId}`, { method: 'PATCH', body: { status: 'active' } }); close();
  });

  // 走既有的 POST /tasks，自動帶上目前的 plan_id——使用者不用再選一次計畫。
  // 不給 due_date：加進計畫不等於已經排好時間，所以它會出現在「尚未安排」。
  const addTask = () => run(async () => {
    const title = nt.title.trim();
    if (!title) return;
    await api('/tasks', {
      method: 'POST',
      body: {
        title,
        plan_id: plan.planId,
        list_id: nt.list_id ? Number(nt.list_id) : null,
        deadline_date: nt.deadline_date || null,
      },
    });
    setNt({ title: '', list_id: nt.list_id, deadline_date: '' });   // 科目留著，連續加同一科比較順
    close();
  });

  // 後端會先回未解決的任務讓使用者確認，force 才真的完成。
  // 用 BottomSheet 問，不用 window.confirm——backend 語意完全不變。
  const complete = () => run(async () => {
    const r = await api(`/plans/${plan.planId}/complete`, { method: 'POST', body: {} });
    if (r.needs_confirm) { setUnresolved(r.unresolved.length); setSheet('confirmComplete'); return; }
    close();
  });
  const completeForce = () => run(async () => {
    await api(`/plans/${plan.planId}/complete`, { method: 'POST', body: { force: true } });
    close();
  });

  const saveInfo = () => run(async () => {
    const body = {};
    const name = (edit.name || '').trim();
    if (name && name !== plan.name) body.name = name;
    if ((edit.start_date || null) !== (raw?.start_date || null)) body.start_date = edit.start_date || null;
    if ((edit.target_date || null) !== (raw?.target_date || null)) body.target_date = edit.target_date || null;
    if ((edit.description || '') !== (raw?.description || '')) body.description = edit.description || '';
    if (Object.keys(body).length) await api(`/plans/${plan.planId}`, { method: 'PATCH', body });
    close();
  });

  // 依科目分組；同一科有多本書時再分小段。
  // 尚未安排的已經有自己的區塊，這裡要排除掉，否則同一筆會出現兩次。
  const unplacedIds = new Set(plan.unplaced.map(t => t.id));
  const placed = plan.items.filter(t => !unplacedIds.has(t.id));
  const groups = plan.subjects.length
    ? plan.subjects.map(s => ({
        subject: s,
        items: placed.filter(t => String(t.list_id ?? '') === String(s.id ?? '')),
      }))
    : [{ subject: null, items: placed }];

  const visible = list => list.filter(t => showDone || !t.completed).sort((a, b) => byLesson(a.title, b.title));

  const Row = t => {
    const late = !t.completed && t.due_date && t.due_date < today();
    // 已完成的不給調整：它已經退出未來排程，日期是歷史紀錄。
    const block = t.completed ? null : blocksForTask(sched.blocks, t.id)[0];
    return (
      <ListRow key={t.id} muted={!!t.completed}
        leading={<input type="checkbox" aria-label={t.title} checked={!!t.completed} onChange={() => toggle(t)} />}
        title={shortTitle(t.title)}
        trailing={t.due_date
          ? (block
            ? <button className="row-adjust" aria-label={`調整「${shortTitle(t.title)}」的時間`}
                style={late ? { color: 'var(--danger)' } : undefined}
                onClick={() => setAdjustBlock({ block, task: t })}>{md(t.due_date)}</button>
            : <span style={late ? { color: 'var(--danger)' } : undefined}>{md(t.due_date)}</span>)
          : <span className="ui-meta">尚未安排</span>}
      />
    );
  };

  return (
    <div className="main">
      <PageHeader
        back={<button className="page-back" onClick={onBack}>← 計畫列表</button>}
        title={plan.name}
        subtitle={plan.start ? `${md(plan.start)} – ${md(plan.end)}` : ''}
        actions={<>
          {isReal && (
            <IconButton label="計畫選項" onClick={() => setSheet('manage')}><Icon name="more" size={20} /></IconButton>
          )}
        </>}
      />
      <div className="main-body">
        <div className="row">
          {!isReal && (
            <Button size="sm" style={{ marginLeft: 'auto' }} onClick={goWizard}>
              <Icon name="wizard" size={14} /> 重新安排
            </Button>
          )}
          {isReal && plan.status !== 'active' && (
            <span className="chip" style={{ marginLeft: 'auto' }}>{STATUS_LABEL[plan.status] || plan.status}</span>
          )}
        </div>

        {/* 首屏：進度就是主角，不做成儀表板 */}
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.03em' }}>{pct}%</span>
            <span className="ui-meta">{plan.done} / {plan.total} 已完成</span>
          </div>
          <div style={{ marginTop: 'var(--sp-2)' }}>
            <ProgressBar value={plan.done} max={plan.total} label={`${plan.name}：${plan.total} 項中已完成 ${plan.done} 項`} />
          </div>
          <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
            {plan.end && <span className="ui-meta">目標 {md(plan.end)}</span>}
            {plan.subjects.length > 1 && <span className="ui-meta">{plan.subjects.length} 個科目</span>}
            {plan.overdue > 0 && <span className="ui-meta" style={{ color: 'var(--danger)' }}>逾期 {plan.overdue} 項</span>}
          </div>
        </div>

        {/* 需要調整時才出現；跟 Today 用同一套 accent 語意，不是紅色警告 */}
        {health?.needsAdjustment && (
          <SurfaceCard tone="accent" style={{ marginTop: 'var(--sp-5)' }}>
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <Icon name="wizard" size={15} style={{ color: 'var(--accent)' }} />
              <b>目前安排需要調整</b>
            </div>
            <div className="ui-meta" style={{ marginTop: 2 }}>{health.reasons[0].message}。</div>
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <Button variant="primary" size="sm" onClick={() => setReplan(true)}>讓 AI 重新安排</Button>
            </div>
          </SurfaceCard>
        )}

        {/* 調整計畫：contextual CTA。需要調整時，上面那張卡的「讓 AI 重新安排」
            才是主要動作，這裡再放一顆同樣重的實心鈕會變成兩個主要動作互搶 */}
        {showAdjust && (
          <Button variant={health?.needsAdjustment ? 'secondary' : 'primary'} size="md" block
            style={{ marginTop: 'var(--sp-4)' }} onClick={() => setSheet('adjust')}>
            <Icon name="wizard" size={16} /> 調整計畫
          </Button>
        )}

        {plan.isLegacy && (
          <SurfaceCard style={{ marginTop: 'var(--sp-4)' }}>
            <b>舊資料</b>
            <div className="ui-meta" style={{ marginTop: 2 }}>
              這份計畫尚未轉成正式計畫，目前只能查看與完成任務。
            </div>
            <Button size="sm" style={{ marginTop: 10 }} onClick={async () => { try { setLegacyPreview(await api('/legacy-migration/preview')); setSheet('legacy'); } catch (e) { setErr(e.message); } }}>查看安全轉換方式</Button>
          </SurfaceCard>
        )}

        {/* 尚未安排：在計畫裡 ≠ 已經排到日期，這是正式狀態 */}
        {plan.unplaced.length > 0 && (
          <section className="ui-section">
            <div className="row" style={{ marginBottom: 'var(--sp-1)' }}>
              <div className="ui-section-title" style={{ marginBottom: 0 }}>尚未安排</div>
              <span className="ui-meta">{plan.unplaced.length} 項</span>
            </div>
            <div className="ui-meta" style={{ marginBottom: 'var(--sp-2)' }}>這些還沒排進行事曆</div>
            {plan.unplaced.sort((a, b) => byLesson(a.title, b.title)).map(Row)}
          </section>
        )}

        {plan.total === 0 && (
          <EmptyState
            title="這個計畫還沒有任務"
            description={isReal && plan.status !== 'archived' ? '加入第一個任務，之後可以讓 AI 幫你安排到每一天。' : ''}
            action={isReal && plan.status !== 'archived'
              ? <Button variant="primary" size="lg" onClick={() => setSheet('add')}>新增第一個任務</Button>
              : null}
          />
        )}

        {/* 主分組＝科目。同一科有多本書時，才再用書名分小段 */}
        {groups.map(({ subject, items }) => {
          const list = visible(items);
          if (!list.length) return null;
          const undone = items.filter(t => !t.completed).length;
          const books = [...new Set(list.map(t => bookOf(t.title)))];
          return (
            <section key={String(subject?.id ?? 'none')} className="ui-section">
              <div className="row" style={{ marginBottom: 'var(--sp-1)' }}>
                {subject && <span className="dot" style={{ width: 8, height: 8, background: subject.color }} />}
                <div className="ui-section-title" style={{ marginBottom: 0 }}>{subject?.name || '未分科目'}</div>
                <span className="ui-meta" style={{ marginLeft: 'auto' }}>{items.length - undone} / {items.length}</span>
              </div>
              {books.length > 1
                ? books.map(b => (
                    <div key={b}>
                      <div className="ui-meta" style={{ padding: 'var(--sp-2) 0 0' }}>{b}</div>
                      {list.filter(t => bookOf(t.title) === b).map(Row)}
                    </div>
                  ))
                : list.map(Row)}
            </section>
          );
        })}

        {plan.total > 0 && isReal && plan.status !== 'archived' && (
          <Button block style={{ marginTop: 'var(--sp-4)' }} onClick={() => setSheet('add')}>
            <Icon name="plus" size={16} /> 新增任務
          </Button>
        )}

        {plan.done > 0 && (
          <button className="plan-section-row" aria-expanded={showDone} onClick={() => setShowDone(s => !s)}>
            <span>已完成</span>
            <span className="ui-meta">{plan.done}</span>
            <Icon name="chevron" size={16} style={{ transform: showDone ? 'rotate(90deg)' : 'none' }} />
          </button>
        )}
      </div>

      {/* ---------- 管理：右上 ••• ---------- */}
      {sheet === 'manage' && (
        <BottomSheet onClose={close} label="計畫選項">
          <b style={{ fontSize: 17 }}>計畫選項</b>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <ListRow title="編輯計畫資訊" subtitle="名稱、說明、開始日、目標日"
              trailing={<Icon name="chevron" size={16} />} role="button" tabIndex={0} style={{ cursor: 'pointer' }}
              onClick={() => { setEdit({ name: plan.name, description: raw?.description || '', start_date: raw?.start_date || '', target_date: raw?.target_date || '' }); setSheet('edit'); }} />
            <ListRow title="AI 排程條件" subtitle="先確認 AI 解讀，再交給排程器"
              role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setSheet('constraints')} />
            {plan.status === 'completed' && <ListRow title="重新開始" subtitle="回到進行中，保留全部任務"
              role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={restart} />}
            {plan.status !== 'completed' && plan.status !== 'archived' && (
              <ListRow title="標記完成" subtitle="整個計畫做完了"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={complete} />
            )}
            {plan.status !== 'archived'
              ? <ListRow title="封存" subtitle="收起來，不會刪掉任何任務"
                  role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={archive} />
              : <ListRow title="恢復計畫" subtitle="放回進行中"
                  role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={restore} />}
          </div>
          {err && <div className="error" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
        </BottomSheet>
      )}

      {/* ---------- 編輯計畫資訊：按儲存才送出，不做離焦即更新 ---------- */}
      {sheet === 'edit' && edit && (
        <BottomSheet onClose={close} label="編輯計畫資訊">
          <b style={{ fontSize: 17 }}>編輯計畫資訊</b>
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <label className="ui-meta" htmlFor="plan-name">計畫名稱</label>
            <input id="plan-name" aria-label="計畫名稱" value={edit.name} style={{ width: '100%', marginTop: 'var(--sp-1)' }}
              onChange={e => setEdit(v => ({ ...v, name: e.target.value }))} />
            <label className="ui-meta" htmlFor="plan-description" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>計畫說明</label>
            <textarea id="plan-description" aria-label="計畫說明" value={edit.description} rows="3" style={{ width: '100%', marginTop: 'var(--sp-1)' }}
              onChange={e => setEdit(v => ({ ...v, description: e.target.value }))} />
            <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
              <span style={{ flex: 1 }}>
                <label className="ui-meta" htmlFor="plan-start">開始日期</label>
                <input id="plan-start" type="date" aria-label="開始日期" value={edit.start_date}
                  style={{ width: '100%', marginTop: 'var(--sp-1)' }}
                  onChange={e => setEdit(v => ({ ...v, start_date: e.target.value }))} />
              </span>
              <span style={{ flex: 1 }}>
                <label className="ui-meta" htmlFor="plan-target">目標日期</label>
                <input id="plan-target" type="date" aria-label="目標日期" value={edit.target_date}
                  style={{ width: '100%', marginTop: 'var(--sp-1)' }}
                  onChange={e => setEdit(v => ({ ...v, target_date: e.target.value }))} />
              </span>
            </div>
          </div>
          {err && <div className="error" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={saveInfo}>儲存</Button>
          </div>
        </BottomSheet>
      )}
      {sheet === 'constraints' && <ConstraintSheet planId={plan.planId} onClose={close} />}
      {sheet === 'legacy' && <BottomSheet onClose={close} label="轉成正式計畫"><b>安全轉成正式計畫</b><div className="ui-meta" style={{ marginTop: 8 }}>{legacyPreview?.warning}</div><div className="ui-meta" style={{ marginTop: 8 }}>找到 {legacyPreview?.candidates?.length || 0} 項可人工確認的舊任務。系統不會猜分群，也不會直接搬動資料。</div><div className="row" style={{ marginTop: 16 }}><Button onClick={close}>取消</Button><Button variant="primary" style={{ marginLeft: 'auto' }} onClick={async () => { await api('/plans', { method: 'POST', body: { name: `${plan.name}（正式計畫）`, description: '由舊資料手動轉換；請逐筆確認任務歸屬。', source: 'legacy_migration' } }); await reload(); close(); onBack(); }}>建立正式計畫草稿</Button></div></BottomSheet>}

      {/* ---------- 完成確認：後端 needs_confirm 語意完全不變 ---------- */}
      {sheet === 'confirmComplete' && (
        <BottomSheet onClose={close} label="完成這個計畫">
          <b style={{ fontSize: 17 }}>完成這個計畫？</b>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
            還有 {unresolved} 項尚未完成。仍要把整個計畫標記為完成嗎？
          </div>
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={completeForce}>仍然完成</Button>
          </div>
        </BottomSheet>
      )}

      {/* ---------- 新增任務 ---------- */}
      {sheet === 'add' && (
        <BottomSheet onClose={close} label="新增任務">
          <b style={{ fontSize: 17 }}>新增任務到這個計畫</b>
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <label className="ui-meta" htmlFor="nt-title">要做什麼？</label>
            <input id="nt-title" aria-label="任務名稱" autoFocus value={nt.title} placeholder="例如：整理第一章筆記"
              style={{ width: '100%', marginTop: 'var(--sp-1)' }}
              onChange={e => setNt({ ...nt, title: e.target.value })}
              onKeyDown={e => e.key === 'Enter' && addTask()} />
            <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
              <span style={{ flex: 1 }}>
                <label className="ui-meta" htmlFor="nt-subject">科目</label>
                <select id="nt-subject" aria-label="科目" value={nt.list_id} style={{ width: '100%', marginTop: 'var(--sp-1)' }}
                  onChange={e => setNt({ ...nt, list_id: e.target.value })}>
                  <option value="">未分科目</option>
                  {lists.filter(l => !l.shared_in).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </span>
              <span style={{ flex: 1 }}>
                <label className="ui-meta" htmlFor="nt-deadline">截止日</label>
                <input id="nt-deadline" type="date" aria-label="截止日" value={nt.deadline_date}
                  style={{ width: '100%', marginTop: 'var(--sp-1)' }}
                  onChange={e => setNt({ ...nt, deadline_date: e.target.value })} />
              </span>
            </div>
          </div>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-3)' }}>加進來的任務會先放在「尚未安排」</div>
          {err && <div className="error" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
          <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={busy || !nt.title.trim()} onClick={addTask}>
              {busy ? '新增中…' : '新增'}
            </Button>
          </div>
        </BottomSheet>
      )}

      {/* ---------- 調整計畫：深連結到精靈對應的位置 ---------- */}
      {sheet === 'adjust' && (
        <BottomSheet onClose={close} label="調整計畫">
          <b style={{ fontSize: 17 }}>想調整什麼？</b>
          <div className="ui-meta" style={{ marginTop: 2 }}>調整的是「{plan.name}」，不會建立新的計畫</div>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            {ADJUST.map(([sec, label, hint]) => (
              <ListRow key={sec} title={label} subtitle={hint}
                trailing={<Icon name="chevron" size={16} />} role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                onClick={() => { close(); adjustPlan(plan.planId, sec); }}
                onKeyDown={e => { if (e.key === 'Enter') { close(); adjustPlan(plan.planId, sec); } }} />
            ))}
            <ListRow title="排程鎖定" subtitle="鎖住任務、時段或整天後，重排不會改動它們"
              trailing={<Icon name="chevron" size={16} />} role="button" tabIndex={0} style={{ cursor: 'pointer' }}
              onClick={() => { close(); goLocks?.(); }} />
          </div>
        </BottomSheet>
      )}

      {replan && health && (
        <ReplanSheet plan={plan} health={health} raw={raw} lists={lists} reload={reload}
          onClose={() => setReplan(false)}
          onEditConditions={sec => { setReplan(false); adjustPlan?.(plan.planId, sec); }} />
      )}

      {/* 「讓 AI 重新安排」是整份重排；這一支是使用者自己動某一格。
          兩者都走 2C persistence，只是決策者不同。 */}
      {adjustBlock && (
        <AdjustBlockSheet block={adjustBlock.block} task={adjustBlock.task} lists={lists}
          versionId={sched.version?.id}
          reload={async () => { await reload(); await sched.reload(); }}
          onClose={() => setAdjustBlock(null)} />
      )}
    </div>
  );
}
