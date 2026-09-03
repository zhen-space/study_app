import { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { today } from './helpers';
import { usePlans, bookOf, shortTitle, md, byLesson } from './plans';
import { listBooks } from './material';
import { usePlanScheduleHealth } from './planHealth';
import { useActiveSchedule, blocksForTask } from './scheduleAdjust';
import AdjustBlockSheet from './AdjustBlockSheet';
import ReplanSheet from './ReplanSheet';
import ConstraintSheet from './ConstraintSheet';
import ExplainSheet from './ExplainSheet';
import { Button, IconButton, PageHeader, SurfaceCard, ProgressBar, ListRow, BottomSheet, EmptyState } from './ui';

// 單一計畫的內容。
//
// UI-R2 起改用 Design System v1：Plan 本身是主角，管理動作收進右上「•••」。
// 分組主軸仍然是「科目」而不是「書」——一個 Plan 可以跨科，書只是標題裡的一段，
// 不是 Plan 的身分。同一科底下有多本書時才再用書名分小段。
//
// 正式 Plan（有 planId）才有改名／改期限／完成／封存；
// 舊資料沒有 plan id，這些操作對它沒有意義，一律不顯示。

const STATUS_LABEL = { draft: '草稿', active: '進行中', paused: '已暫停', completed: '已完成', ended: '已結束', archived: '已封存' };

// 暫停／刪除都必須明確選「未完成的任務怎麼辦」。刻意不給預設值：
// 猜錯的兩個方向都很痛（以為留著結果被刪、以為清掉結果還在），
// 所以選項未選之前送出鍵是停用的。文案一律講後果，不講欄位名稱。
// 只有「暫停」還需要問未完成任務怎麼辦。
// 「刪除」已改為整個計畫連同所有任務一起移除，沒有保留選項——想留進度但不再繼續
// 的正確操作是「結束計畫」。
const RETAIN_CHOICES = {
  pause: [
    [true, '保留未完成的任務', '任務留在這個計畫裡，只是先不排時間。恢復計畫後可以重新安排。'],
    [false, '不保留未完成的任務', '未完成的任務會移到垃圾桶。恢復計畫也不會自己回來。'],
  ],
};

// 「調整計畫」的入口：先問要調整哪一段，再深連結到排程精靈對應的位置。
// 一次只調一件事，不用每次都從頭走一遍精靈。
const ADJUST = [
  ['content', '學習內容', '加、減或換讀的範圍'],
  ['deadline', '完成期限', '改開始日、目標日與分配方式'],
  ['time', '可用時間', '看目前的行程與作息（要改請到行事曆）'],
  ['cond', '排程條件', '題型、順序、每天幾項'],
  ['all', '全部設定', '從頭走一次精靈'],
];

// 未完成任務怎麼辦。用 radio 而不是勾選框：兩個選項都是明確的決定，
// 沒有哪一個是「預設不動作」，所以不能有預設選取。
function RetainPicker({ kind, value, onChange }) {
  return (
    <div role="radiogroup" aria-label="未完成的任務怎麼辦" style={{ marginTop: 'var(--sp-4)' }}>
      <div className="ui-meta" style={{ marginBottom: 'var(--sp-2)' }}>未完成的任務怎麼辦？</div>
      {RETAIN_CHOICES[kind].map(([v, title, desc]) => (
        <label key={String(v)} className="row"
          style={{ alignItems: 'flex-start', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)', cursor: 'pointer' }}>
          <input type="radio" name={`retain-${kind}`} aria-label={title}
            checked={value === v} onChange={() => onChange(v)} style={{ marginTop: 3 }} />
          <span>
            <b>{title}</b>
            <div className="ui-meta">{desc}</div>
          </span>
        </label>
      ))}
    </div>
  );
}

export default function PlanDetailView({ planKey, tasks, lists, apiPlans = [], reload, onBack, goWizard, adjustPlan, goLocks }) {
  const plan = usePlans(tasks, lists, apiPlans).find(p => p.key === planKey);
  const [showDone, setShowDone] = useState(false);
  // 教材脈絡只用來顯示；identity 一律是 task.material_book_id，不從標題猜。
  const [matBooks, setMatBooks] = useState(() => new Map());
  useEffect(() => {
    listBooks().then(bs => setMatBooks(new Map(bs.map(b => [b.id, b])))).catch(() => {});
  }, []);
  const [sheet, setSheet] = useState(null);   // manage | edit | add | adjust | cannotComplete | confirmEnd
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [replan, setReplan] = useState(false);
  const [unresolved, setUnresolved] = useState(0);
  const [nt, setNt] = useState({ title: '', list_id: '', deadline_date: '', estimated_minutes: '' });
  const [edit, setEdit] = useState(null);     // 編輯計畫資訊的暫存（按儲存才送出）
  // null＝還沒選。暫停／刪除都必須明確選一個，不給預設值。
  const [retain, setRetain] = useState(null);
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
  // 暫停的計畫跟封存一樣不接受新任務、也不排程——後端 checkPlan 本來就會擋，
  // UI 不要留一個按下去必定失敗的入口。
  const workable = isReal && ['draft', 'active'].includes(plan.status);
  const showAdjust = workable && !!adjustPlan;
  // 已結束的計畫是歷史／唯讀：可以查看原任務與實際進度，但不提供新增、排程、調整，
  // 也不能直接勾選未完成任務——要重新動它，得先「重新開始」回到進行中。
  const readOnly = plan.status === 'ended';
  const pct = plan.total ? Math.round(plan.done / plan.total * 100) : 0;

  const close = () => { setSheet(null); setErr(''); setRetain(null); };

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
  // 重新開始走正式 lifecycle endpoint。以前是 PATCH /plans/:id { status:'active' }，
  // 但 PATCH 的白名單根本不含 status，所以那個請求其實什麼都沒改——畫面看起來
  // 成功了，計畫還停在 completed。lifecycle 轉換必須走專用端點，才會一併處理
  // 允許的狀態轉換、新的 ScheduleVersion 與 lock。
  const restart = () => run(async () => {
    await api(`/plans/${plan.planId}/restart`, { method: 'POST', body: {} }); close();
  });

  // 暫停／刪除：retain 沒選之前不會送出，後端也會再擋一次（缺 boolean 一律 400）。
  const pausePlan = () => run(async () => {
    await api(`/plans/${plan.planId}/pause`, { method: 'POST', body: { retain_incomplete_tasks: retain } });
    close();
  });
  const resumePlan = () => run(async () => {
    await api(`/plans/${plan.planId}/resume`, { method: 'POST', body: {} }); close();
  });
  const deletePlan = () => run(async () => {
    await api(`/plans/${plan.planId}/delete`, { method: 'POST', body: {} });
    close(); onBack();
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
        estimated_minutes: nt.estimated_minutes ? Number(nt.estimated_minutes) : null,
      },
    });
    setNt({ title: '', list_id: nt.list_id, deadline_date: '', estimated_minutes: '' });   // 科目留著，連續加同一科比較順
    close();
  });

  // 完成＝所有任務都已經有結果（做完或取消）。**沒有** force。
  //
  // 以前這裡等一個 needs_confirm 的成功回應、然後送 { force: true } 再打一次——
  // 後端兩者都不存在：未完成時它回 409 unresolved_tasks，而且沒有任何 force 路徑。
  // 所以那顆「仍然完成」按下去只會失敗。完成率是不能被繞過的東西：使用者若不再
  // 繼續，正確的出口是「結束計畫」，不是把沒做完的計畫標成完成。
  const complete = () => run(async () => {
    try {
      await api(`/plans/${plan.planId}/complete`, { method: 'POST', body: {} });
      close();
    } catch (e) {
      if (e.status === 409 && e.payload?.code === 'unresolved_tasks') {
        setUnresolved(e.payload.unresolved?.length ?? 0);
        setSheet('cannotComplete');
        return;                     // 這是預期中的結果，不是錯誤訊息
      }
      throw e;
    }
  });

  // 結束計畫：保留未完成任務，計畫退出排程，但不算完成。
  // 後端在有未完成任務時會先要求明確確認（409 end_confirmation_required）。
  const endPlan = (confirm = false) => run(async () => {
    try {
      await api(`/plans/${plan.planId}/end`, { method: 'POST', body: confirm ? { confirm: true } : {} });
      close();
    } catch (e) {
      if (!confirm && e.status === 409 && e.payload?.code === 'end_confirmation_required') {
        setUnresolved(e.payload.unresolved?.length ?? 0);
        setSheet('confirmEnd');
        return;
      }
      throw e;
    }
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
  // 教材脈絡優先用**正式 linkage**（material_book_id），沒有 linkage 的才退回
  // 舊的標題前綴解析。Manual Task 完全沒有教材也是正常的，不強迫每個 Task 屬於某本書。
  const bookLabelOf = t => (t.material_book_id != null
    ? (matBooks.get(t.material_book_id)?.title || '教材')
    : bookOf(t.title));

  // 列上顯示的標題。書名已經是這一段的標頭，不用每一列再寫一次。
  //
  // 舊任務的標題是「科目｜書名｜…」，所以 shortTitle 砍前兩段。教材任務沒有
  // 科目那一段（「書名｜章｜節｜內容」），照砍兩段會把「章」一起砍掉——
  // 於是列上只剩「單元練習」，看不出是哪一章的單元練習。
  // 有正式 linkage 的就照 linkage 砍掉書名那一段，不用位置去猜。
  const rowTitle = t => {
    if (t.material_book_id == null) return shortTitle(t.title);
    const book = matBooks.get(t.material_book_id)?.title;
    const seg = String(t.title || '').split('｜');
    return book && seg[0] === book && seg.length > 1 ? seg.slice(1).join('｜') : t.title;
  };

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
    // 已結束計畫整個唯讀：勾選框停用、時間不給調整（只顯示歷史日期）。
    const block = t.completed || readOnly ? null : blocksForTask(sched.blocks, t.id)[0];
    return (
      <ListRow key={t.id} muted={!!t.completed}
        leading={<input type="checkbox" aria-label={t.title} checked={!!t.completed}
          disabled={readOnly} onChange={() => { if (!readOnly) toggle(t); }} />}
        title={rowTitle(t)}
        trailing={t.due_date
          ? (block
            ? <button className="row-adjust" aria-label={`調整「${rowTitle(t)}」的時間`}
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

        {/* 已結束：清楚標示歷史／唯讀，並給出唯一的回頭路 */}
        {readOnly && (
          <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
            <b>這個計畫已結束</b>
            <div className="ui-meta" style={{ marginTop: 2 }}>
              以下是結束當時的任務與進度，僅供查看。要繼續做這些任務，請從右上「•••」選「重新開始」。
            </div>
          </SurfaceCard>
        )}

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
            description={workable ? '加入第一個任務，之後可以讓 AI 幫你安排到每一天。' : ''}
            action={workable
              ? <Button variant="primary" size="lg" onClick={() => setSheet('add')}>新增第一個任務</Button>
              : null}
          />
        )}

        {/* 主分組＝科目。同一科有多本書時，才再用書名分小段 */}
        {groups.map(({ subject, items }) => {
          const list = visible(items);
          if (!list.length) return null;
          const undone = items.filter(t => !t.completed).length;
          const books = [...new Set(list.map(bookLabelOf))];
          return (
            <section key={String(subject?.id ?? 'none')} className="ui-section">
              <div className="row" style={{ marginBottom: 'var(--sp-1)' }}>
                {subject && <span className="dot" style={{ width: 8, height: 8, background: subject.color }} />}
                <div className="ui-section-title" style={{ marginBottom: 0 }}>{subject?.name || '未分科目'}</div>
                <span className="ui-meta" style={{ marginLeft: 'auto' }}>{items.length - undone} / {items.length}</span>
              </div>
              {/* 書名寫在段落標頭，一段只寫一次。只有一本書時也要寫——
                  列上的標題已經把書名拿掉了，這裡不寫就再也看不到是哪一本。
                  「其他」是沒有教材脈絡的任務（手動任務），不用假標頭。 */}
              {books.map(b => (
                <div key={b}>
                  {b !== '其他' && (
                    <div className="ui-meta" style={{ padding: 'var(--sp-2) 0 0' }}>{b}</div>
                  )}
                  {list.filter(t => bookLabelOf(t) === b).map(Row)}
                </div>
              ))}
            </section>
          );
        })}

        {plan.total > 0 && workable && (
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
            <ListRow title="為什麼這樣排" subtitle="看懂這份安排的依據，不會改動任何東西"
              role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setSheet('explain')} />
            {/* 已完成／已結束都可以重新開始，兩者都走正式 lifecycle endpoint。
                以前只有 completed 有這個入口，ended 的計畫等於沒有回頭路。 */}
            {['completed', 'ended'].includes(plan.status) && (
              <ListRow title="重新開始" subtitle="回到進行中，保留全部任務"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={restart} />
            )}
            {/* 只有進行中的計畫能標記完成——後端的轉換表就只允許 active → completed。
                以前 draft／paused／ended 也看得到這個入口，按下去一律失敗。 */}
            {plan.status === 'active' && (
              <ListRow title="標記完成" subtitle="整個計畫做完了"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={complete} />
            )}
            {/* 結束 ≠ 完成。沒做完但不再繼續，就走這裡；完成率不會被污染。 */}
            {['draft', 'active', 'paused'].includes(plan.status) && (
              <ListRow title="結束計畫" subtitle="不再繼續了，未完成的任務會保留"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => endPlan(false)} />
            )}
            {/* 暫停 ≠ 封存。封存是「收起來不看」，暫停是「這個計畫先不排時間」。
                兩者的確認畫面與對未完成任務的處理都不一樣，不能互相冒充。 */}
            {['draft', 'active'].includes(plan.status) && (
              <ListRow title="暫停計畫" subtitle="先不排時間，之後可以恢復"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                onClick={() => { setRetain(null); setSheet('confirmPause'); }} />
            )}
            {plan.status === 'paused' && (
              <ListRow title="繼續計畫" subtitle="回到進行中，重新開始安排時間"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={resumePlan} />
            )}
            {plan.status !== 'archived'
              ? <ListRow title="封存" subtitle="收起來，不會刪掉任何任務"
                  role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={archive} />
              : <ListRow title="恢復計畫" subtitle="放回進行中"
                  role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={restore} />}
            <ListRow title="刪除計畫" subtitle="從清單中移除，無法復原"
              role="button" tabIndex={0} style={{ cursor: 'pointer', color: 'var(--danger, #c0392b)' }}
              onClick={() => { setRetain(null); setSheet('confirmDelete'); }} />
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
      {sheet === 'explain' && <ExplainSheet onClose={close} />}
      {sheet === 'legacy' && <BottomSheet onClose={close} label="轉成正式計畫"><b>安全轉成正式計畫</b><div className="ui-meta" style={{ marginTop: 8 }}>{legacyPreview?.warning}</div><div className="ui-meta" style={{ marginTop: 8 }}>找到 {legacyPreview?.candidates?.length || 0} 項可人工確認的舊任務。系統不會猜分群，也不會直接搬動資料。</div><div className="row" style={{ marginTop: 16 }}><Button onClick={close}>取消</Button><Button variant="primary" style={{ marginLeft: 'auto' }} onClick={async () => { await api('/plans', { method: 'POST', body: { name: `${plan.name}（正式計畫）`, description: '由舊資料手動轉換；請逐筆確認任務歸屬。', source: 'legacy_migration' } }); await reload(); close(); onBack(); }}>建立正式計畫草稿</Button></div></BottomSheet>}

      {/* ---------- 暫停確認 ---------- */}
      {sheet === 'confirmPause' && (
        <BottomSheet onClose={close} label="暫停這個計畫">
          <b style={{ fontSize: 17 }}>暫停這個計畫？</b>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
            計畫會留著並標示為「已暫停」，但不會再排新的時間，也不會出現在今天要做的事裡。
            你隨時可以再繼續。
          </div>
          <RetainPicker kind="pause" value={retain} onChange={setRetain} />
          {err && <div className="error" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }}
              disabled={busy || retain === null} onClick={pausePlan}>暫停計畫</Button>
          </div>
        </BottomSheet>
      )}

      {/* ---------- 刪除確認：跟暫停是完全不同的畫面，而且要按兩次 ----------
          刪除沒有「保留任務」選項：整個計畫連同所有任務都會移除。想留進度但不再
          繼續，正確操作是「結束計畫」，不是刪除。 */}
      {sheet === 'confirmDelete' && (
        <BottomSheet onClose={close} label="刪除這個計畫">
          <b style={{ fontSize: 17, color: 'var(--danger, #c0392b)' }}>刪除這個計畫？</b>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
            這個計畫及其中<b>所有任務</b>都會從 App 中移除，<b>無法復原</b>。
            <br />
            如果只是不再繼續、但想留住目前的進度，請改用「結束計畫」。
          </div>
          {err && <div className="error" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button onClick={close}>取消</Button>
            <Button variant="destructive" style={{ marginLeft: 'auto' }}
              disabled={busy} onClick={() => setSheet('confirmDeleteFinal')}>下一步</Button>
          </div>
        </BottomSheet>
      )}
      {sheet === 'confirmDeleteFinal' && (
        <BottomSheet onClose={close} label="確定刪除">
          <b style={{ fontSize: 17, color: 'var(--danger, #c0392b)' }}>真的要刪除「{plan.name}」？</b>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
            這個動作沒有復原按鈕。計畫及其中所有任務都會從 App 中移除。
          </div>
          {err && <div className="error" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button onClick={() => setSheet('confirmDelete')}>返回</Button>
            <Button variant="destructive" style={{ marginLeft: 'auto' }}
              disabled={busy} onClick={deletePlan}>確定刪除</Button>
          </div>
        </BottomSheet>
      )}

      {/* ---------- 還有未完成任務：不能標記完成 ----------
          這裡沒有「仍然完成」。完成代表所有任務都有結果，那是完成率的意義；
          留一顆繞過去的按鈕就等於讓這個數字失去意義。不再繼續的出口是結束計畫。 */}
      {sheet === 'cannotComplete' && (
        <BottomSheet onClose={close} label="還不能標記為完成">
          <b style={{ fontSize: 17 }}>尚有未完成任務，不能標記為完成</b>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
            還有 {unresolved} 項沒有結果。請先把它們做完或取消。
            <br />
            如果這個計畫不再繼續了，可以改成「結束計畫」——未完成的任務會保留下來，
            而且不會被算成完成。
          </div>
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button onClick={close}>知道了</Button>
            <Button style={{ marginLeft: 'auto' }} disabled={busy}
              onClick={() => setSheet('confirmEnd')}>改成結束計畫</Button>
          </div>
        </BottomSheet>
      )}

      {/* ---------- 結束計畫的明確確認：走既有 POST /plans/:id/end ---------- */}
      {sheet === 'confirmEnd' && (
        <BottomSheet onClose={close} label="結束這個計畫">
          <b style={{ fontSize: 17 }}>結束這個計畫？</b>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
            {unresolved > 0 && <>還有 {unresolved} 項未完成，它們會被保留下來。<br /></>}
            計畫會標示為「已結束」並退出排程，<b>不會</b>被算成完成。之後仍可重新開始。
          </div>
          {err && <div className="error" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button onClick={close}>取消</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={busy}
              onClick={() => endPlan(true)}>結束計畫</Button>
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
              <span style={{ flex: 1 }}>
                <label className="ui-meta" htmlFor="nt-estimate">預估分鐘</label>
                <input id="nt-estimate" type="number" min="1" max="1440" inputMode="numeric" aria-label="預估分鐘" value={nt.estimated_minutes}
                  placeholder="例如 60" style={{ width: '100%', marginTop: 'var(--sp-1)' }}
                  onChange={e => setNt({ ...nt, estimated_minutes: e.target.value })} />
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
