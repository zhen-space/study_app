import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { today, addDays, overdueSince } from './helpers';
import { usePlans, bookOf, shortTitle, md, byLesson } from './plans';
import { listBooks, selectItems } from './material';
import { usePlanScheduleHealth } from './planHealth';
import { useActiveSchedule, blocksForTask, conflictText } from './scheduleAdjust';
import DatePickSheet from './DatePickSheet';
import { PICK_DATE, DRAG_HINT, dragHintStyle, dropZoneStyle, useLongPress, useTouchDrag } from './touchDrag';
import AdjustBlockSheet from './AdjustBlockSheet';
import ReplanSheet from './ReplanSheet';
import ConstraintSheet from './ConstraintSheet';
import ExplainSheet from './ExplainSheet';
import RollingExamSchedule from './RollingExamSchedule';
import PlanContentPicker from './PlanContentPicker';
import PlanRangeView from './PlanRangeView';
import PlanTimeline from './PlanTimeline';
import { Button, IconButton, PageHeader, SurfaceCard, ProgressBar, ListRow, BottomSheet, EmptyState, SegmentedControl } from './ui';

// 單一計畫的內容。
//
// UI-R2 起改用 Design System v1：Plan 本身是主角，管理動作收進右上「•••」。
// 分組主軸仍然是「科目」而不是「書」——一個 Plan 可以跨科，書只是標題裡的一段，
// 不是 Plan 的身分。同一科底下有多本書時才再用書名分小段。
//
// 正式 Plan（有 planId）才有改名／改期限／完成／封存；
// 舊資料沒有 plan id，這些操作對它沒有意義，一律不顯示。

// 計畫內容的一列外層：可拖曳時接上長按；拖曳中半透明並加虛線框。
function DraggableRow({ onLongPress, dragging, children }) {
  const { style, ...handlers } = useLongPress(onLongPress);
  return (
    <div {...handlers} aria-grabbed={onLongPress ? dragging : undefined}
      style={{ ...style, ...(dragging ? { opacity: 0.55, outline: '2px dashed var(--primary)', borderRadius: 10 } : {}) }}>
      {children}
    </div>
  );
}

const WD = '日一二三四五六';
const dayTitle = d => `${md(d)}（週${WD[new Date(d + 'T00:00:00').getDay()]}）`;

const STATUS_LABEL = { draft: '草稿', active: '進行中', paused: '已暫停', completed: '已完成', ended: '已結束', archived: '已封存' };
const EMPTY_ADDITIONS = [];
const NO_COMMIT = Symbol('no-commit');

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

// 「調整計畫」的入口：學習內容只能走「先預覽、再套用」的安全流程；
// 其餘排程設定才深連結到排程精靈。舊精靈的 Edit MaterialSelector 會在點選時
// 直接寫正式 selection，返回或預覽失敗可能留下半套狀態，所以不能再從這裡進入。
const ADJUST = [
  ['deadline', '完成期限', '改開始日、目標日與分配方式'],
  ['time', '可用時間', '看目前的行程與作息（要改請到行事曆）'],
  ['cond', '排程條件', '題型、順序、每天幾項'],
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

export default function PlanDetailView({ planKey, tasks, lists, apiPlans = [], reload, onBack, goWizard, adjustPlan, goLocks, goScheduleHistory }) {
  const plan = usePlans(tasks, lists, apiPlans).find(p => p.key === planKey);
  const [showDone, setShowDone] = useState(false);
  // 計畫內容的分區：依科目（原本的呈現）或依日期，記在這台裝置上。
  const [contentMode, setContentMode] = useState(() => {
    try { return localStorage.getItem('planContentGroup') === 'date' ? 'date' : 'subject'; } catch { return 'subject'; }
  });
  const pickContentMode = v => { setContentMode(v); try { localStorage.setItem('planContentGroup', v); } catch {} };
  // 長按拖曳改期（計畫任務走 ScheduleVersion manual transaction，不碰 due_date）：
  // planMoves：寫入中先顯示在新日期（id → date）；moveState：每列的進行中／錯誤／未知。
  const [planMoves, setPlanMoves] = useState({});
  const [moveState, setMoveState] = useState({});
  const moveBusyRef = useRef(new Set());
  const moveUnknownRef = useRef(new Set());
  const pendingSyncRef = useRef(new Set());
  // 拖曳的 overlay 只是視覺；狀態另外用這個 live region 宣告給 VoiceOver。
  const [announce, setAnnounce] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [pickFor, setPickFor] = useState(null);
  const movePlanTaskRef = useRef(null);
  const { drag, start: startDrag, justEnded } = useTouchDrag((t, target) => movePlanTaskRef.current?.(t, target));
  // 伺服器資料（due_date mirror）已是新日期才放掉樂觀位置，舊資料晚到不會拉回。
  useEffect(() => {
    setPlanMoves(m => {
      const ids = Object.keys(m);
      if (!ids.length) return m;
      const keep = ids.filter(id => (tasks.find(t => String(t.id) === id)?.due_date || null) !== m[id]);
      return keep.length === ids.length ? m : Object.fromEntries(keep.map(id => [id, m[id]]));
    });
  }, [tasks]);
  // 教材脈絡只用來顯示；identity 一律是 task.material_book_id，不從標題猜。
  const [matBooks, setMatBooks] = useState(() => new Map());
  useEffect(() => {
    listBooks().then(bs => setMatBooks(new Map(bs.map(b => [b.id, b])))).catch(() => {});
  }, []);
  const [sheet, setSheet] = useState(null);   // manage | edit | add | adjust | cannotComplete | confirmEnd
  const [showRolling, setShowRolling] = useState(false);   // 段考滾動重排
  const [rollingAdditions, setRollingAdditions] = useState(null);
  const [newSubject, setNewSubject] = useState({ subject_list_id: '', exam_date: '' });
  const [examSubjectIds, setExamSubjectIds] = useState(() => new Set());
  const [examSubjectsLoad, setExamSubjectsLoad] = useState({ loading: true, error: '' });
  // plan 切換與套用後 strict refresh 可能交錯；只讓最後一次科目投影寫入。
  const examSubjectsRequestRef = useRef(0);
  const [examRefreshKey, setExamRefreshKey] = useState(0);
  const [editSubject, setEditSubject] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [refreshStale, setRefreshStale] = useState(false);
  const [refreshUnknown, setRefreshUnknown] = useState(false);
  const mutationBusy = useRef(false);
  // lifecycle 請求期間底部導覽仍可切走；刪除完成後只能刷新全域資料，不能讓已卸載
  // 的明細頁再執行 onBack，把使用者從較新的目的地拉回計畫列表。
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const taskToggleBusyRef = useRef(false);
  const [taskToggleState, setTaskToggleState] = useState(null); // { taskId, committed, unknown, error }
  const [replan, setReplan] = useState(false);
  const [unresolved, setUnresolved] = useState(0);
  const [nt, setNt] = useState({ title: '', list_id: '', deadline_date: '', estimated_minutes: '' });
  const pendingTaskCreate = useRef(null); // POST 回應與讀回都失敗時，下一次先確認再決定是否重送
  const [edit, setEdit] = useState(null);     // 編輯計畫資訊的暫存（按儲存才送出）
  // null＝還沒選。暫停／刪除都必須明確選一個，不給預設值。
  const [retain, setRetain] = useState(null);
  const [adjustBlock, setAdjustBlock] = useState(null);   // { block, task }
  const [legacyPreview, setLegacyPreview] = useState(null);
  // 排定時間的真相在 ScheduledBlock；要讓使用者自己改，就得知道是哪一格。
  const sched = useActiveSchedule();
  // 必須在早退前呼叫，避免資料刷新瞬間找不到 Plan 時違反 React Hook 順序。
  const health = usePlanScheduleHealth(plan, apiPlans.find(p => p.id === plan?.planId));
  const refreshExamSubjects = async (planId, strict = false) => {
    if (planId == null) return;
    const requestId = ++examSubjectsRequestRef.current;
    setExamSubjectsLoad({ loading: true, error: '' });
    try {
      const projection = await api(`/plans/${planId}/exam`);
      if (!Array.isArray(projection?.subjects)) throw new Error('段考科目資料不完整');
      if (requestId !== examSubjectsRequestRef.current) return;
      setExamSubjectIds(new Set((projection.subjects || []).map(s => Number(s.subject_list_id))));
      setExamSubjectsLoad({ loading: false, error: '' });
    } catch (e) {
      if (requestId !== examSubjectsRequestRef.current) return;
      // 不知道現有科目時不能把所有科目都當成可加入，否則離線／API 失敗會把學生
      // 帶進必定失敗的重複科目流程。套用成功後刷新失敗也要交給既有 committed
      // recovery，不能關掉提示後讓畫面假裝已同步。
      const message = e.message || '暫時無法載入段考科目';
      setExamSubjectsLoad({ loading: false, error: message });
      if (strict) throw e;
    }
  };
  useEffect(() => { refreshExamSubjects(plan?.planId); }, [plan?.planId]);

  const retryRefresh = async () => {
    if (mutationBusy.current) return;
    mutationBusy.current = true;
    setBusy(true); setErr('');
    try {
      await reload();
      setRefreshStale(false);
      setRefreshUnknown(false);
    } catch (e) {
      setErr(e.message || '仍然無法重新載入，請稍後再試。');
    } finally {
      mutationBusy.current = false;
      setBusy(false);
    }
  };

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

  if (refreshStale) {
    return (
      <div className="main">
        <PageHeader back={<button className="page-back" onClick={onBack}>← 計畫列表</button>} title={plan.name} />
        <div className="main-body">
          <SurfaceCard tone="accent">
            <div role="alert"><b>{refreshUnknown ? '暫時無法確認變更結果' : '變更已儲存，但畫面暫時無法更新'}</b></div>
            <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
              {refreshUnknown
                ? '連線中斷後無法確認伺服器是否已完成操作。為避免重送，請先重新載入最新資料。'
                : '為避免重複新增任務或重送計畫動作，請先重新載入最新資料。'}
            </div>
            {err && <div className="error" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
            <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
              <Button onClick={onBack}>回計畫列表</Button>
              <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={retryRefresh}>
                {busy ? '重新載入中…' : '重新載入'}
              </Button>
            </div>
          </SurfaceCard>
        </div>
      </div>
    );
  }

  const isReal = !plan.isLegacy && plan.planId != null;
  const raw = apiPlans.find(p => p.id === plan.planId);
  const ownSubjects = lists.filter(l => !l.shared_in);
  const availableExamSubjects = ownSubjects.filter(l => !examSubjectIds.has(Number(l.id)));
  // 暫停的計畫跟封存一樣不接受新任務、也不排程——後端 checkPlan 本來就會擋，
  // UI 不要留一個按下去必定失敗的入口。
  const workable = isReal && ['draft', 'active'].includes(plan.status);
  const showAdjust = workable && !!adjustPlan;
  // 已結束的計畫是歷史／唯讀：可以查看原任務與實際進度，但不提供新增、排程、調整，
  // 也不能直接勾選未完成任務——要重新動它，得先「重新開始」回到進行中。
  // 既有 archived 舊資料同樣視為唯讀歷史（封存功能已移除，不再有恢復入口）。
  const readOnly = plan.status === 'ended' || plan.status === 'archived';
  // 顯示用的狀態標籤：archived 舊資料依 archived_from_status 投影回已完成／已結束，
  // 其他來源（active/paused/… 或空）不猜，照實顯示為已封存。
  const statusLabel = plan.status === 'archived'
    ? (STATUS_LABEL[plan.archived_from_status] && ['completed', 'ended'].includes(plan.archived_from_status)
        ? STATUS_LABEL[plan.archived_from_status] : '已封存')
    : (STATUS_LABEL[plan.status] || plan.status);
  const pct = plan.total ? Math.round(plan.done / plan.total * 100) : 0;

  const close = () => { setSheet(null); setErr(''); setRetain(null); };
  const openAddSubject = () => {
    if (examSubjectsLoad.loading || examSubjectsLoad.error || !availableExamSubjects.length) return;
    // 每次開啟都是一份新的表單；不能沿用上次取消或已套用的科目，否則隱藏的舊值
    // 會讓按鈕看似可送出，最後卻撞到重複科目。考試日預設沿用整個段考最後一天。
    setNewSubject({ subject_list_id: '', exam_date: raw?.target_date || '' });
    setErr('');
    setSheet('addSubject');
  };
  // lifecycle 寫入尚未回來時不能讓 backdrop／Escape 把確認畫面藏起來。
  // 否則請求稍後失敗，錯誤會留在已關閉的 sheet，手機上看起來就像什麼都沒發生。
  // 用同步 ref 判斷，不只靠 busy render；點送出到 React 重繪間也不能被 Escape 關掉。
  const lifecycleClose = () => { if (!mutationBusy.current) close(); };
  const manageAction = action => {
    if (mutationBusy.current) return;
    action();
  };
  const previewSubject = () => {
    const selected = lists.find(l => Number(l.id) === Number(newSubject.subject_list_id));
    if (!selected || !newSubject.exam_date) return;
    close();
    setRollingAdditions({ examSubject: { subject_list_id: Number(selected.id), subject_name: selected.name, exam_date: newSubject.exam_date } });
    setShowRolling(true);
  };
  const previewSubjectDate = () => {
    if (!editSubject?.exam_date) return;
    close();
    setRollingAdditions({ examSubject: { subject_list_id: Number(editSubject.subject_list_id), subject_name: editSubject.subject_name,
      exam_date: editSubject.exam_date, operation: 'update' } });
    setShowRolling(true);
  };

  // 完成任務走既有的 PATCH /tasks/:id，沒有第二套完成邏輯。
  // PATCH 成功後就已經提交；若只是父層資料刷新失敗，重試只能刷新，不能再反轉一次。
  const refreshCommittedTaskToggle = async taskId => {
    if (taskToggleBusyRef.current) return;
    taskToggleBusyRef.current = true;
    setTaskToggleState({ taskId, committed: true, error: '' });
    try {
      await reload('tasks');
      setTaskToggleState(null);
    } catch (e) {
      setTaskToggleState({ taskId, committed: true, error: e.message || '重新載入失敗，請稍後再試。' });
    } finally {
      taskToggleBusyRef.current = false;
    }
  };
  // ── 長按拖曳改期 ───────────────────────────────────────────
  // 計畫任務的日期屬於 ScheduledBlock／ScheduleVersion；due_date 只是 mirror，
  // generic PATCH 會被伺服器拒絕。所以一律走 /schedule/manual（stale gate、衝突、
  // 唯一性、mirror 都在同一筆交易）：
  //   ・今天以後已有一段安排 → 以 block_id 搬動那一段（保留原時段）
  //   ・沒有今天以後的安排（尚未安排、或過去的安排已成歷史的逾期任務）→ 以 task_id 重新加入
  //   ・分成多段的任務不支援拖曳（不知道要搬哪一段），請用日期按鈕逐段調整
  const todayStr = today();
  const futureBlocksOf = t => blocksForTask(sched.blocks, t.id).filter(b => b.date >= todayStr);
  // 寫入後權威資料（任務 mirror 與 active 版本）還沒成功重新載入、或結果無法確認時，
  // 手上的 base_version 可能已過期：整個計畫都不能再移動，直到重新載入成功。
  const syncBlocked = () => pendingSyncRef.current.size > 0 || moveUnknownRef.current.size > 0;
  const canMovePlanTask = (t, selectedBlock = null) => workable && !readOnly && sched.active && sched.version?.id != null
    && !t.completed && (selectedBlock || futureBlocksOf(t).length <= 1)
    && !moveBusyRef.current.has(t.id) && !syncBlocked();
  const clearPlanMove = id => setPlanMoves(m => { const next = { ...m }; delete next[id]; return next; });
  const clearMoveState = ids => setMoveState(st => Object.fromEntries(Object.entries(st).filter(([k]) => !ids.has(String(k)))));
  // 兩邊都嘗試（任務＋active 版本），只有兩邊都成功才算同步完成。
  const syncAuthoritative = async () => {
    const results = await Promise.allSettled([reload(), sched.reload({ strict: true })]);
    const failed = results.find(r => r.status === 'rejected');
    return failed ? { ok: false, error: failed.reason?.message || '' } : { ok: true };
  };
  async function movePlanTask(payload, target) {
    const t = payload?.task || payload;
    const selectedBlock = payload?.block || null;
    if (!t) return;
    if (target === PICK_DATE) { if (canMovePlanTask(t, selectedBlock)) setPickFor({ task: t, block: selectedBlock }); return; }
    const date = target;
    if (!date || date < todayStr || !canMovePlanTask(t, selectedBlock)) return;
    const base = sched.version.id;
    // 首屏日期安排知道使用者正在操作哪一個 ScheduledBlock；多段任務必須搬該段，
    // 不能退回「永遠取第一段」。頁底舊內容列沒有精確 block 時才沿用單段規則。
    const selectedId = selectedBlock?.id ?? selectedBlock?.block_id;
    const block = selectedBlock
      ? (blocksForTask(sched.blocks, t.id).find(b => Number(b.id ?? b.block_id) === Number(selectedId)) || selectedBlock)
      : (futureBlocksOf(t)[0] || null);
    if (block ? block.date === date : t.due_date === date) return;
    const blockId = block?.id ?? block?.block_id;
    const move = block
      ? { block_id: blockId, date, ...(block.start_time && block.end_time ? { start_time: block.start_time, end_time: block.end_time } : {}) }
      : { task_id: t.id, date };
    moveBusyRef.current.add(t.id);
    setMoveState(st => ({ ...st, [t.id]: { busy: true } }));
    setPlanMoves(m => ({ ...m, [t.id]: date }));
    setAnnounce(`正在把「${rowTitle(t)}」移到 ${md(date)}`);
    const fail = message => {
      clearPlanMove(t.id);
      moveBusyRef.current.delete(t.id);
      setMoveState(st => ({ ...st, [t.id]: { error: message } }));
      setAnnounce(message);
    };
    try {
      await api('/schedule/manual', { method: 'POST', body: { base_version_id: base, moves: [move] } });
    } catch (e) {
      if (e.status >= 400 && e.status < 500) {
        if (e.status === 409 && !e.conflicts?.length) {
          // stale：別處已更新排程。只讀回最新 active 版本，使用者再拖一次才會以新版本送出；
          // 讀不到就鎖住，不能拿舊 base 再送。
          fail('排程已在別處更新，已載入最新安排，請再拖一次。');
          try { await sched.reload({ strict: true }); } catch {
            pendingSyncRef.current.add(t.id);
            setMoveState(st => ({ ...st, [t.id]: { sync: true, error: '排程已在別處更新，但最新安排暫時無法載入；重新載入成功前不能再移動。' } }));
          }
          return;
        }
        fail(e.conflicts?.length ? e.conflicts.map(conflictText).join('；') : (e.message || '這一天放不下'));
        return;
      }
      // 回應遺失：讀回 active 版本核對，絕不重送同一筆 manual transaction。
      let latest = null;
      try { latest = await api('/schedule/active'); } catch { /* 下面當成無法確認 */ }
      const committed = latest?.version?.id != null && latest.version.id !== base
        && blocksForTask(latest.blocks, t.id).some(b => b.date === date);
      if (!committed) {
        if (latest?.version?.id === base) { fail(e.message || '日期沒有更新，已移回原位。'); return; }
        clearPlanMove(t.id);
        moveBusyRef.current.delete(t.id);
        moveUnknownRef.current.add(t.id);
        setMoveState(st => ({ ...st, [t.id]: { unknown: true, error: '無法確認日期是否已更新，請重新載入；確認前請勿再次移動。' } }));
        setAnnounce('無法確認日期是否已更新，請重新載入。');
        return;
      }
    }
    // 已寫入：任務與 active 版本都要重新載入成功，才放掉樂觀位置與鎖定。
    const synced = await syncAuthoritative();
    moveBusyRef.current.delete(t.id);
    if (synced.ok) {
      clearPlanMove(t.id);
      clearMoveState(new Set([String(t.id)]));
      // 日期安排投影自己讀 /schedule/timeline；移動成功後也要立即刷新首屏卡片。
      setExamRefreshKey(k => k + 1);
      setAnnounce(`已把「${rowTitle(t)}」移到 ${md(date)}`);
    } else {
      pendingSyncRef.current.add(t.id);
      // 列上只說這一列的狀態；怎麼處理寫在上方的重新載入卡片，不重複整段說明。
      setMoveState(st => ({ ...st, [t.id]: { sync: true, error: '已移到新日期，等待重新載入確認。' } }));
      setAnnounce('日期已更新，但最新安排暫時無法載入，請重新載入。');
    }
  }
  movePlanTaskRef.current = movePlanTask;
  const moveUnknown = Object.values(moveState).some(st => st.unknown);
  const moveSyncPending = Object.values(moveState).some(st => st.sync);
  // 重試權威刷新（結果未知與刷新失敗共用）：兩邊都成功才解鎖並放掉樂觀位置。
  const retrySync = async () => {
    if (syncBusy) return;
    setSyncBusy(true); setSyncError('');
    const r = await syncAuthoritative();
    setSyncBusy(false);
    if (!r.ok) { setSyncError(r.error || '仍然無法重新載入，請稍後再試。'); return; }
    const ids = new Set([...pendingSyncRef.current, ...moveUnknownRef.current].map(String));
    pendingSyncRef.current.clear();
    moveUnknownRef.current.clear();
    setPlanMoves(m => Object.fromEntries(Object.entries(m).filter(([k]) => !ids.has(k))));
    clearMoveState(ids);
    setAnnounce('已載入最新安排');
  };

  const toggle = async t => {
    if (taskToggleBusyRef.current || taskToggleState?.committed) return;
    taskToggleBusyRef.current = true;
    setTaskToggleState({ taskId: t.id, committed: false, error: '' });
    const completed = !t.completed;
    try {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed } });
    } catch (e) {
      // PATCH 回應遺失時先讀回確認，避免重按後把已提交的完成狀態反轉。
      try {
        const latest = await api('/tasks');
        const saved = Array.isArray(latest) && latest.find(item => Number(item.id) === Number(t.id));
        if (!saved || Boolean(saved.completed) !== completed) {
          setTaskToggleState({ taskId: t.id, committed: false, error: e.message || '更新完成狀態失敗，請稍後再試。' });
          taskToggleBusyRef.current = false;
          return;
        }
      } catch {
        setTaskToggleState({ taskId: t.id, committed: true, unknown: true,
          error: '無法確認完成狀態是否已更新，請重新載入；確認前請勿再次切換。' });
        taskToggleBusyRef.current = false;
        return;
      }
    }
    taskToggleBusyRef.current = false;
    await refreshCommittedTaskToggle(t.id);
  };

  // 以下全部走 Phase 2A 已有的 /plans API，前端不另外存一份計畫狀態
  const run = async (fn, afterReload) => {
    if (mutationBusy.current) return;
    mutationBusy.current = true;
    setBusy(true); setErr('');
    let result;
    try {
      result = await fn();
    } catch (e) {
      setErr(e.message);
      mutationBusy.current = false;
      setBusy(false);
      return;
    }
    if (result === NO_COMMIT) {
      mutationBusy.current = false;
      setBusy(false);
      return;
    }
    try {
      await reload();
      afterReload?.();
    } catch (e) {
      setRefreshStale(true);
      setErr(e.message || '重新載入失敗');
    } finally {
      mutationBusy.current = false;
      setBusy(false);
    }
  };
  // lifecycle POST 可能已在伺服器提交，只是行動網路把回應弄丟。這種 5xx／網路錯誤
  // 不能直接鼓勵重送：先用唯讀 Plan detail 核對 CURRENT 狀態。已達成就只刷新；
  // 明確仍是舊狀態才保留原錯誤供重試。4xx 是明確業務拒絕，不做額外猜測。
  const runLifecycle = async (fn, expectedStatus, afterReload, { deleted = false } = {}) => {
    if (mutationBusy.current) return;
    mutationBusy.current = true;
    setBusy(true); setErr('');
    let result;
    try {
      result = await fn();
    } catch (e) {
      if (e.status >= 400 && e.status < 500) {
        setErr(e.message);
        mutationBusy.current = false;
        setBusy(false);
        return;
      }
      let committed = false;
      try {
        const current = await api(`/plans/${plan.planId}`);
        committed = !deleted && current?.plan?.status === expectedStatus;
        if (!committed) {
          setErr(e.message || '操作失敗，請稍後再試。');
          mutationBusy.current = false;
          setBusy(false);
          return;
        }
      } catch (checkError) {
        committed = deleted && checkError.status === 404;
        if (!committed) {
          setRefreshUnknown(true);
          setRefreshStale(true);
          setErr(checkError.message || '目前無法確認最新狀態');
          mutationBusy.current = false;
          setBusy(false);
          return;
        }
      }
    }
    if (result === NO_COMMIT) {
      mutationBusy.current = false;
      setBusy(false);
      return;
    }
    try {
      await reload();
      if (mounted.current) afterReload?.();
    } catch (e) {
      setRefreshUnknown(false);
      setRefreshStale(true);
      setErr(e.message || '重新載入失敗');
    } finally {
      mutationBusy.current = false;
      setBusy(false);
    }
  };
  const hasPending = tasks.some(t => Number(t.plan_id) === Number(plan.planId)
    && !t.completed && !t.cancelled && !t.deleted);
  // 封存功能已從產品移除——沒有 archive／restore 動作。既有 archived 舊資料仍
  // 讀得到（唯讀），依 archived_from_status 投影回已完成／已結束。
  // 重新開始走正式 lifecycle endpoint。以前是 PATCH /plans/:id { status:'active' }，
  // 但 PATCH 的白名單根本不含 status，所以那個請求其實什麼都沒改——畫面看起來
  // 成功了，計畫還停在 completed。lifecycle 轉換必須走專用端點，才會一併處理
  // 允許的狀態轉換、新的 ScheduleVersion 與 lock。
  const restart = () => runLifecycle(async () => {
    await api(`/plans/${plan.planId}/restart`, { method: 'POST', body: {} });
  }, 'active', close);

  // §C：以此（已結束／完成）計畫建立一個新計畫，並複製「未完成」的教材內容。
  // 不 reopen／不 mutate 舊計畫：讀舊計畫未完成任務的 material_content_item_id →
  // 建新計畫 → 用既有 bulk selectItems 寫進新計畫的選取 → 進精靈（在新計畫上）設定時間並套用。
  // 全程用既有 API 組合，非 backend clone 端點。
  const createFromThisPlan = () => run(async () => {
    const itemIds = [...new Set((tasks || [])
      .filter(t => Number(t.plan_id) === Number(plan.planId) && !t.completed && !t.deleted && t.material_content_item_id != null)
      .map(t => t.material_content_item_id))];
    // 沒有可複製的教材內容（例如純手動計畫）就走一般建立流程，不建立空的草稿計畫。
    if (!itemIds.length || !adjustPlan) { close(); goWizard?.(); return NO_COMMIT; }
    const np = await api('/plans', { method: 'POST', body: { name: `${plan.name}（新一輪）`, status: 'draft', source: 'manual' } });
    await selectItems(np.id, itemIds, true).catch(() => {});
    close();
    // 進精靈（在新計畫上、edit 模式讀回剛複製的選取）設定時間並套用產生任務。
    adjustPlan(np.id, '', undefined, false);
  });

  // 暫停／刪除：retain 沒選之前不會送出，後端也會再擋一次（缺 boolean 一律 400）。
  const pausePlan = () => runLifecycle(async () => {
    await api(`/plans/${plan.planId}/pause`, { method: 'POST', body: { retain_incomplete_tasks: retain } });
  }, 'paused', close);
  const resumePlan = () => runLifecycle(async () => {
    await api(`/plans/${plan.planId}/resume`, { method: 'POST', body: {} });
  }, 'active', () => { close(); if (hasPending) setReplan(true); });
  const deletePlan = () => runLifecycle(async () => {
    await api(`/plans/${plan.planId}/delete`, { method: 'POST', body: {} });
  }, 'deleted', () => { close(); onBack(); }, { deleted: true });

  // 走既有的 POST /tasks，自動帶上目前的 plan_id——使用者不用再選一次計畫。
  // 不給 due_date：加進計畫不等於已經排好時間，所以它會出現在「尚未安排」。
  const addTask = () => run(async () => {
    const title = nt.title.trim();
    if (!title) return;
    const body = {
      title,
      plan_id: plan.planId,
      list_id: nt.list_id ? Number(nt.list_id) : null,
      deadline_date: nt.deadline_date || null,
      estimated_minutes: nt.estimated_minutes ? Number(nt.estimated_minutes) : null,
    };
    const nullableNumber = value => value == null || value === '' ? null : Number(value);
    const matches = (candidate, pending) => !pending.beforeIds.includes(String(candidate.id))
      && candidate.title === pending.body.title
      && Number(candidate.plan_id) === Number(pending.body.plan_id)
      && nullableNumber(candidate.list_id) === nullableNumber(pending.body.list_id)
      && (candidate.deadline_date || null) === pending.body.deadline_date
      && nullableNumber(candidate.estimated_minutes) === nullableNumber(pending.body.estimated_minutes);
    const confirm = async pending => {
      const latest = await api('/tasks');
      return Array.isArray(latest) && latest.some(candidate => matches(candidate, pending));
    };
    // 上次連讀回也失敗時不能直接再 POST；先確認是否已建立，避免同一任務出現兩筆。
    if (pendingTaskCreate.current) {
      try {
        if (await confirm(pendingTaskCreate.current)) {
          pendingTaskCreate.current = null;
          return;
        }
        pendingTaskCreate.current = null;
      } catch {
        throw new Error('仍無法確認任務是否已新增，請稍後再確認；確認前不會重複送出。');
      }
    }
    const pending = { body, beforeIds: tasks.map(task => String(task.id)) };
    try {
      await api('/tasks', { method: 'POST', body });
    } catch (e) {
      if (e.status >= 400 && e.status < 500) throw e;
      try {
        if (await confirm(pending)) return;
        throw e;
      } catch (checkError) {
        if (checkError === e) throw e;
        pendingTaskCreate.current = pending;
        throw new Error('無法確認任務是否已新增，請稍後再確認；確認前不會重複送出。');
      }
    }
  }, () => {
    pendingTaskCreate.current = null;
    setNt({ title: '', list_id: nt.list_id, deadline_date: '', estimated_minutes: '' });   // 科目留著，連續加同一科比較順
    close();
  });

  // 完成＝所有任務都已經有結果（做完或取消）。**沒有** force。
  //
  // 以前這裡等一個 needs_confirm 的成功回應、然後送 { force: true } 再打一次——
  // 後端兩者都不存在：未完成時它回 409 unresolved_tasks，而且沒有任何 force 路徑。
  // 所以那顆「仍然完成」按下去只會失敗。完成率是不能被繞過的東西：使用者若不再
  // 繼續，正確的出口是「結束計畫」，不是把沒做完的計畫標成完成。
  const complete = () => runLifecycle(async () => {
    try {
      await api(`/plans/${plan.planId}/complete`, { method: 'POST', body: {} });
    } catch (e) {
      if (e.status === 409 && e.payload?.code === 'unresolved_tasks') {
        setUnresolved(e.payload.unresolved?.length ?? 0);
        setSheet('cannotComplete');
        return NO_COMMIT;           // 這是預期中的結果，不是錯誤訊息
      }
      throw e;
    }
  }, 'completed', close);

  // 結束計畫：保留未完成任務，計畫退出排程，但不算完成。
  // 後端在有未完成任務時會先要求明確確認（409 end_confirmation_required）。
  const endPlan = (confirm = false) => runLifecycle(async () => {
    try {
      await api(`/plans/${plan.planId}/end`, { method: 'POST', body: confirm ? { confirm: true } : {} });
    } catch (e) {
      if (!confirm && e.status === 409 && e.payload?.code === 'end_confirmation_required') {
        setUnresolved(e.payload.unresolved?.length ?? 0);
        setSheet('confirmEnd');
        return NO_COMMIT;
      }
      throw e;
    }
  }, 'ended', close);

  const saveInfo = () => run(async () => {
    const body = {};
    const name = (edit.name || '').trim();
    if (name && name !== plan.name) body.name = name;
    if ((edit.start_date || null) !== (raw?.start_date || null)) body.start_date = edit.start_date || null;
    if ((edit.target_date || null) !== (raw?.target_date || null)) body.target_date = edit.target_date || null;
    if ((edit.description || '') !== (raw?.description || '')) body.description = edit.description || '';
    if (!Object.keys(body).length) { close(); return NO_COMMIT; }
    try {
      await api(`/plans/${plan.planId}`, { method: 'PATCH', body });
    } catch (e) {
      // 行動網路可能只遺失 PATCH 回應；先讀回核對，避免其實已儲存卻留在表單中
      // 誘使用者重送。4xx 是明確拒絕，直接保留原錯誤與草稿供修正。
      if (e.status >= 400 && e.status < 500) throw e;
      let current;
      try {
        current = (await api(`/plans/${plan.planId}`))?.plan;
      } catch {
        throw new Error('無法確認計畫資訊是否已儲存，請稍後再試；草稿仍會保留。');
      }
      const saved = current && Object.entries(body).every(([key, value]) => (
        (current[key] ?? null) === (value ?? null)
      ));
      if (!saved) throw e;
    }
  }, close);

  // 每列的有效日期：拖曳寫入中先顯示在新日期。
  const effDate = t => planMoves[t.id] ?? t.due_date ?? null;
  const overdueOf = t => overdueSince({ ...t, due_date: effDate(t) }, todayStr);
  // 沒有日期的未完成任務分兩種，不能混為「尚未安排」：
  //   ・已逾期：過去排過（或截止已過）、active 版本已無安排——due_date mirror 因此是 NULL
  //   ・尚未安排：從沒排過、也沒有已過的截止日
  const overdueUndated = plan.items.filter(t => !t.completed && !effDate(t) && overdueOf(t));
  const neverPlaced = plan.items.filter(t => !t.completed && !effDate(t) && !overdueOf(t));
  // 依科目分組；同一科有多本書時再分小段。沒有日期的已有自己的區塊，這裡排除，避免重複。
  const placed = plan.items.filter(t => t.completed || effDate(t));
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
    const date = effDate(t);
    const od = overdueOf(t);
    // 已完成的不給調整：它已經退出未來排程，日期是歷史紀錄。
    // 已結束計畫整個唯讀：勾選框停用、時間不給調整（只顯示歷史日期）。
    const block = t.completed || readOnly || planMoves[t.id] ? null : blocksForTask(sched.blocks, t.id)[0];
    const movable = canMovePlanTask(t);
    const ms = moveState[t.id];
    // 375px：狀態、原定日期與「改日期／選日期」放在標題下方並可換行，不擠壓標題；
    // 右側只留既有的時間調整按鈕。每個可移動的任務都有不靠長按的改日期按鈕（鍵盤／VoiceOver）。
    const moveButton = movable && (
      <button type="button" className="row-move"
        aria-label={date ? `改「${rowTitle(t)}」的日期` : `替「${rowTitle(t)}」選擇日期`}
        onClick={() => { if (!justEnded()) setPickFor(t); }}>{date ? '改日期' : '選日期'}</button>
    );
    const meta = (od || !date || movable) && (
      <span className="row-meta">
        {od && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>已逾期</span>}
        {!date && (od
          ? <span>{od === t.deadline_date ? '截止' : '原定'} {md(od)}</span>
          : <span>尚未安排</span>)}
        {moveButton}
      </span>
    );
    const trailing = date
      ? (block && !syncBlocked()
          ? <button className="row-adjust" aria-label={`調整「${rowTitle(t)}」的時間`}
              style={od ? { color: 'var(--danger)' } : undefined}
              onClick={() => { if (!justEnded()) setAdjustBlock({ block, task: t }); }}>{md(date)}</button>
          : <span style={od ? { color: 'var(--danger)' } : undefined}>{md(date)}</span>)
      : null;
    return (
      <DraggableRow key={t.id} onLongPress={movable ? () => { startDrag(t); setAnnounce(`已拿起「${rowTitle(t)}」，拖到日期後放開`); } : undefined} dragging={drag?.id === t.id}>
        <ListRow muted={!!t.completed}
          leading={<input type="checkbox" aria-label={t.title} checked={!!t.completed}
            disabled={readOnly || !!taskToggleState?.committed || !!ms?.busy || !!ms?.unknown || !!ms?.sync
              || (taskToggleState?.taskId === t.id && taskToggleBusyRef.current)}
            onChange={() => { if (!readOnly) toggle(t); }} />}
          title={rowTitle(t)}
          subtitle={meta || null}
          trailing={trailing}
        />
        {ms?.error && <div role="alert" className="ui-error" style={{ margin: '4px 8px 0' }}>{ms.error}</div>}
      </DraggableRow>
    );
  };

  // 一個有標題的區塊；dropDate 有值時（拖曳中）可當放置目標。
  const sortRows = list => [...list].sort((a, b) =>
    (effDate(a) || '').localeCompare(effDate(b) || '') || byLesson(a.title, b.title) || Number(a.id) - Number(b.id));
  const sectionBox = (label, list, { note = '', dropDate, danger = false } = {}) => {
    const isZone = dropDate !== undefined && workable;
    const over = drag && isZone && drag.target === dropDate;
    return (
      <section key={label} className="ui-section" aria-label={label}
        data-drop-date={isZone ? dropDate : undefined} style={drag && isZone ? dropZoneStyle(over) : undefined}>
        <div className="row" style={{ marginBottom: 'var(--sp-1)' }}>
          <div className="ui-section-title" style={{ marginBottom: 0, ...(danger ? { color: 'var(--danger)' } : {}) }}>{label}</div>
          <span className="ui-meta">{list.length} 項</span>
        </div>
        {note && <div className="ui-meta" style={{ marginBottom: 'var(--sp-2)' }}>{note}</div>}
        {sortRows(list).map(Row)}
      </section>
    );
  };
  // 依日期：已逾期 → 今天 → 之後每一天。拖曳中「今天」「明天」即使沒有任務也出現。
  const dateSections = () => {
    const open = plan.items.filter(t => !t.completed);
    const overdueAll = open.filter(t => overdueOf(t));
    const byDay = new Map();
    for (const t of open) {
      if (overdueOf(t) || !effDate(t)) continue;
      if (!byDay.has(effDate(t))) byDay.set(effDate(t), []);
      byDay.get(effDate(t)).push(t);
    }
    if (drag) for (const d of [todayStr, addDays(todayStr, 1)]) if (!byDay.has(d)) byDay.set(d, []);
    return [
      overdueAll.length > 0 && sectionBox('已逾期', overdueAll, { danger: true }),
      ...[...byDay.keys()].sort().map(d => sectionBox(d === todayStr ? '今天' : dayTitle(d), byDay.get(d), { dropDate: d })),
    ];
  };

  return (
    <div className="main">
      <PageHeader
        back={<button className="page-back" disabled={busy}
          onClick={() => { if (!mutationBusy.current) onBack(); }}>← 計畫列表</button>}
        title={plan.name}
        subtitle={plan.start ? `${md(plan.start)} – ${md(plan.end)}` : ''}
        actions={<>
          {isReal && (
            <IconButton label="計畫選項" onClick={() => setSheet('manage')}><Icon name="more" size={20} /></IconButton>
          )}
        </>}
      />
      <div className="main-body">
        {taskToggleState?.error && (
          <SurfaceCard tone={taskToggleState.committed ? 'accent' : undefined}>
            <div role="alert">
              <b>{taskToggleState.unknown ? '無法確認完成狀態'
                : taskToggleState.committed ? '完成狀態已儲存，但畫面暫時無法更新' : '無法更新完成狀態'}</b>
              <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>{taskToggleState.error}</div>
            </div>
            {taskToggleState.committed && (
              <Button size="sm" variant="primary" style={{ marginTop: 'var(--sp-3)' }}
                disabled={taskToggleBusyRef.current}
                onClick={() => refreshCommittedTaskToggle(taskToggleState.taskId)}>
                {taskToggleBusyRef.current ? '重新載入中…' : '重新載入'}
              </Button>
            )}
          </SurfaceCard>
        )}
        <div className="row">
          {!isReal && (
            <Button size="sm" style={{ marginLeft: 'auto' }} onClick={goWizard}>
              <Icon name="wizard" size={14} /> 重新安排
            </Button>
          )}
          {isReal && plan.status !== 'active' && (
            <span className="chip" style={{ marginLeft: 'auto' }}>{statusLabel}</span>
          )}
        </div>
        {plan.status === 'active' && (
          <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
            <Button size="sm" variant="primary" onClick={() => setSheet('addContent')}>
              <Icon name="plus" size={14} /> 加入內容
            </Button>
            <Button size="sm" variant="secondary"
              disabled={examSubjectsLoad.loading || !!examSubjectsLoad.error || !availableExamSubjects.length}
              onClick={openAddSubject}>
              <Icon name="plus" size={14} /> 加入科目
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowRolling(true)}>
              <Icon name="calendar" size={14} /> 調整每天安排
            </Button>
            <span className="ui-meta" style={{ marginLeft: 'var(--sp-2)' }}>先預覽再套用；今天、明天不變動</span>
            {examSubjectsLoad.loading ? (
              <span className="ui-meta">正在讀取段考科目…</span>
            ) : examSubjectsLoad.error ? (
              <span className="row" role="alert" style={{ gap: 'var(--sp-2)' }}>
                <span className="ui-meta">科目資料未載入，暫時不能加入科目。</span>
                <Button size="sm" variant="tertiary" onClick={() => refreshExamSubjects(plan.planId)}>重試</Button>
              </span>
            ) : !availableExamSubjects.length ? (
              <span className="ui-meta" role="status">
                {ownSubjects.length ? '所有科目都已加入這次段考。' : '還沒有可用科目，請先到設定新增科目。'}
              </span>
            ) : null}
          </div>
        )}
        {showRolling && (
          <RollingExamSchedule planId={plan.planId}
            tasks={tasks}
            addTaskIds={rollingAdditions?.addTaskIds || EMPTY_ADDITIONS}
            materialSelections={rollingAdditions?.materialSelections || EMPTY_ADDITIONS}
            examSubject={rollingAdditions?.examSubject || null}
            onClose={() => { setShowRolling(false); setRollingAdditions(null); }}
            scheduleEnd={raw?.target_date
              || plan.items.reduce((m, t) => (t.deadline_date && t.deadline_date > m ? t.deadline_date : m), '')
              || null}
            onApplied={async () => { await reload(); await refreshExamSubjects(plan.planId, true); setExamRefreshKey(k => k + 1); }} />
        )}

        {/* 首屏：用白話直接回答「考試哪天、要讀完哪些範圍（哪科→哪本→哪課）、
            以及（若已安排）每天要做的」。不先顯示百分比儀表板或工程術語。 */}
        {isReal ? (
          <PlanRangeView
            plan={plan} lists={lists} refreshKey={examRefreshKey}
            onAddRange={plan.status === 'active' ? () => setSheet('addContent') : undefined}
            onArrange={plan.status === 'active' ? () => setSheet('arrange') : undefined}
            onAddManual={plan.status === 'active' ? () => setSheet('add') : undefined}
            onEditSubject={plan.status === 'active' ? s => { setEditSubject({ ...s }); setSheet('editSubjectDate'); } : undefined}
            afterSubjects={(
              <PlanTimeline
                plan={plan}
                tasks={tasks}
                lists={lists}
                reloadTasks={reload}
                refreshKey={examRefreshKey}
                groupMode={contentMode}
                onGroupModeChange={pickContentMode}
                canMoveTask={canMovePlanTask}
                draggingTaskId={drag?.id || null}
                moveState={moveState}
                onStartMove={(task, block, label) => {
                  startDrag({ id: task.id, task, block });
                  setAnnounce(`已拿起「${label}」，拖到日期後放開`);
                }}
                onPickDate={(task, block) => { if (!justEnded()) setPickFor({ task, block }); }}
                onAddContent={plan.status === 'active' ? () => setSheet('addContent') : undefined}
                onAdjust={plan.status === 'active' ? () => setShowRolling(true) : undefined}
              />
            )}
          />
        ) : (
          /* 舊資料／歷史計畫：沒有正式 planId，維持簡單進度呈現 */
          <div style={{ marginTop: 'var(--sp-5)' }}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.03em' }}>{pct}%</span>
              <span className="ui-meta">{plan.done} / {plan.total} 已完成</span>
            </div>
            <div style={{ marginTop: 'var(--sp-2)' }}>
              <ProgressBar value={plan.done} max={plan.total} label={`${plan.name}：${plan.total} 項中已完成 ${plan.done} 項`} />
            </div>
          </div>
        )}
        {isReal && goScheduleHistory && (
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <Button size="sm" variant="ghost" onClick={goScheduleHistory}>
              <Icon name="calendar" size={14} /> 排程紀錄（版本歷史）
            </Button>
          </div>
        )}

        {/* 已結束：清楚標示歷史／唯讀，並給出唯一的回頭路 */}
        {plan.status === 'ended' && (
          <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
            <b>這個計畫已結束</b>
            <div className="ui-meta" style={{ marginTop: 2 }}>
              以下是結束當時的任務與進度，僅供查看。要繼續做這些任務，請從右上「•••」選「重新開始」。
            </div>
          </SurfaceCard>
        )}
        {/* 既有 archived 舊資料：唯讀歷史。封存功能已移除，沒有恢復入口。 */}
        {plan.status === 'archived' && (
          <SurfaceCard style={{ marginTop: 'var(--sp-5)' }}>
            <b>這是一份封存的舊紀錄</b>
            <div className="ui-meta" style={{ marginTop: 2 }}>僅供查看。</div>
          </SurfaceCard>
        )}

        {/* 需要調整時才出現；跟 Today 用同一套 accent 語意，不是紅色警告 */}
        {health?.needsAdjustment && (
          <SurfaceCard tone="accent" style={{ marginTop: 'var(--sp-5)' }}>
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <Icon name="wizard" size={15} style={{ color: 'var(--accent)' }} />
              <b>目前安排需要調整</b>
            </div>
            {/* 已逾期與尚未安排是兩件事，都要寫出來，不能只顯示第一個原因。 */}
            <div className="ui-meta" style={{ marginTop: 2 }}>
              {(health.reasons.some(r => r.type === 'overdue' || r.type === 'unplaced')
                ? health.reasons.filter(r => r.type === 'overdue' || r.type === 'unplaced')
                : health.reasons.slice(0, 1)).map(r => r.message).join('、')}。
            </div>
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <Button variant="primary" size="sm" onClick={() => setReplan(true)}>讓 AI 重新安排</Button>
            </div>
          </SurfaceCard>
        )}

        {/* 調整計畫：contextual CTA。需要調整時，上面那張卡的「讓 AI 重新安排」
            才是主要動作，這裡再放一顆同樣重的實心鈕會變成兩個主要動作互搶 */}
        {showAdjust && (
          <Button variant={health?.needsAdjustment ? 'secondary' : 'primary'} size="md" block
            style={{ marginTop: 'var(--sp-4)' }} onClick={() => {
              // 段考的「調整計畫」直接回到與建立時相同的完整三步頁面；
              // 只有一般 Plan 才保留舊的分段調整選單。類型尚未確認時先進安全等待頁，
              // 不可把段考誤導到另一套精靈。
              if (!examSubjectsLoad.loading && !examSubjectsLoad.error && examSubjectIds.size > 0) {
                adjustPlan(plan.planId, '', undefined, true);
              } else {
                setSheet('adjust');
              }
            }}>
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

        {/* Plan 內容（第三區）：這個計畫選了哪些教材範圍、既有任務與學校作業。
            跟「段考進度」（範圍目標）、「確切安排」（每日排程）分開，不混為一談。
            分區切換放在這一區自己的標題列，不擠進頁首。 */}
        {plan.total > 0 && isReal && (
          <div className="row" style={{ marginTop: 'var(--sp-5)', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
            <div className="ui-section-title" style={{ marginBottom: 0 }}>Plan 內容</div>
            <div style={{ marginLeft: 'auto', maxWidth: '100%' }}>
              <SegmentedControl ariaLabel="Plan 內容分區" value={contentMode} onChange={pickContentMode}
                options={[{ value: 'date', label: '依日期' }, { value: 'subject', label: '依科目' }]} />
            </div>
          </div>
        )}
        {(moveUnknown || moveSyncPending) && (
          <SurfaceCard tone="accent" style={{ marginTop: 'var(--sp-3)' }}>
            <div role="alert"><b>{moveUnknown ? '無法確認日期是否已更新' : '日期已更新，但最新安排暫時無法載入'}</b></div>
            <div className="ui-meta" style={{ marginTop: 'var(--sp-1)' }}>
              {moveUnknown ? '為避免重複送出，請先重新載入最新安排。' : '重新載入成功前，暫時不能再移動任務。'}
            </div>
            {syncError && <div className="ui-error" style={{ marginTop: 'var(--sp-2)' }}>{syncError}</div>}
            <Button size="sm" style={{ marginTop: 'var(--sp-3)' }} disabled={syncBusy} onClick={retrySync}>
              {syncBusy ? '重新載入中…' : '重新載入確認'}
            </Button>
          </SurfaceCard>
        )}

        {/* 已逾期（沒有日期）：過去排過卻沒完成，不是「尚未安排」 */}
        {contentMode === 'subject' && overdueUndated.length > 0
          && sectionBox('已逾期', overdueUndated, { danger: true, note: '原本安排的日期已過、還沒完成；可長按拖到新的日期' })}
        {/* 尚未安排：在計畫裡 ≠ 已經排到日期，這是正式狀態 */}
        {contentMode === 'subject' && neverPlaced.length > 0
          && sectionBox('尚未安排', neverPlaced, { note: '這些還沒排進行事曆' })}

        {plan.total === 0 && (
          <EmptyState
            title="這個計畫還沒有任務"
            description={workable ? '加入第一個任務，之後可以讓 AI 幫你安排到每一天。' : ''}
            action={workable
              ? <Button variant="primary" size="lg" onClick={() => setSheet('add')}>新增第一個任務</Button>
              : null}
          />
        )}

        {contentMode === 'date' && dateSections()}
        {contentMode === 'date' && neverPlaced.length > 0
          && sectionBox('尚未安排', neverPlaced, { note: '這些還沒排進行事曆' })}
        {contentMode === 'date' && showDone && plan.done > 0
          && sectionBox('已完成', plan.items.filter(t => t.completed))}

        {/* 主分組＝科目。同一科有多本書時，才再用書名分小段 */}
        {contentMode === 'subject' && groups.map(({ subject, items }) => {
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
      {/* 要不要幫你排出每天要做的（範圍加好後才選）。各科考試日已是「哪天前讀完」的
          目標，所以這裡只提供每日/時段兩種；不做平均分段。 */}
      {sheet === 'arrange' && (
        <BottomSheet onClose={close} label="要幫你安排到什麼程度">
          <div style={{ display: 'grid', gap: 8 }}>
            <b style={{ fontSize: 16 }}>要幫你安排到什麼程度？</b>
            <ListRow
              title="排出每天要讀什麼" subtitle="列出每天要做哪些內容，但不綁幾點"
              trailing={<Icon name="chevron" size={16} />}
              role="button" tabIndex={0} style={{ cursor: 'pointer' }}
              onClick={() => { close(); adjustPlan?.(plan.planId, 'all', 'daily'); }}
              onKeyDown={e => { if (e.key === 'Enter') { close(); adjustPlan?.(plan.planId, 'all', 'daily'); } }} />
            <ListRow
              title="連每天的時段都排好" subtitle="依你的可用時間與行事曆，排到幾點到幾點"
              trailing={<Icon name="chevron" size={16} />}
              role="button" tabIndex={0} style={{ cursor: 'pointer' }}
              onClick={() => { close(); adjustPlan?.(plan.planId, 'all', 'timed'); }}
              onKeyDown={e => { if (e.key === 'Enter') { close(); adjustPlan?.(plan.planId, 'all', 'timed'); } }} />
            {err && <div className="error">{err}</div>}
          </div>
        </BottomSheet>
      )}

      {sheet === 'manage' && (
        <BottomSheet onClose={lifecycleClose} label="計畫選項" aria-busy={busy}>
          <b style={{ fontSize: 17 }}>計畫選項</b>
          <div aria-disabled={busy || undefined} style={{ marginTop: 'var(--sp-3)', opacity: busy ? 0.65 : 1 }}>
            <ListRow title="編輯計畫資訊" subtitle="名稱、說明、開始日、目標日"
              trailing={<Icon name="chevron" size={16} />} role="button" tabIndex={0} style={{ cursor: 'pointer' }}
              onClick={() => manageAction(() => { setEdit({ name: plan.name, description: raw?.description || '', start_date: raw?.start_date || '', target_date: raw?.target_date || '' }); setSheet('edit'); })} />
            <ListRow title="AI 排程條件" subtitle="先確認 AI 解讀，再交給排程器"
              role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => manageAction(() => setSheet('constraints'))} />
            <ListRow title="為什麼這樣排" subtitle="看懂這份安排的依據，不會改動任何東西"
              role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => manageAction(() => setSheet('explain'))} />
            {/* 已完成／已結束都可以重新開始，兩者都走正式 lifecycle endpoint。
                以前只有 completed 有這個入口，ended 的計畫等於沒有回頭路。 */}
            {['completed', 'ended'].includes(plan.status) && (
              <ListRow title="重新開始" subtitle="回到進行中，保留全部任務"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => manageAction(restart)} />
            )}
            {/* §C：結束／完成的計畫，除了「重新開始」原計畫，也能直接開一個新計畫
                （例如下一次段考）。這裡走既有建立計畫流程，用新的內容重新安排；
                不是複製任務（真正 clone 需 backend plan-clone 端點，未做假造）。 */}
            {['completed', 'ended'].includes(plan.status) && goWizard && (
              <ListRow title="以此計畫再建一個新計畫" subtitle="複製未完成的內容到新計畫，不動這個已結束的計畫"
                trailing={<Icon name="chevron" size={16} />} role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                onClick={() => manageAction(createFromThisPlan)} />
            )}
            {/* 只有進行中的計畫能標記完成——後端的轉換表就只允許 active → completed。
                以前 draft／paused／ended 也看得到這個入口，按下去一律失敗。 */}
            {plan.status === 'active' && (
              <ListRow title="標記完成" subtitle="整個計畫做完了"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => manageAction(complete)} />
            )}
            {/* 結束 ≠ 完成。沒做完但不再繼續，就走這裡；完成率不會被污染。 */}
            {['draft', 'active', 'paused'].includes(plan.status) && (
              <ListRow title="結束計畫" subtitle="不再繼續了，未完成的任務會保留"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => manageAction(() => endPlan(false))} />
            )}
            {/* 暫停：這個計畫先不排時間，之後可以繼續。封存已從產品移除。 */}
            {['draft', 'active'].includes(plan.status) && (
              <ListRow title="暫停計畫" subtitle="先不排時間，之後可以恢復"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                onClick={() => manageAction(() => { setRetain(null); setSheet('confirmPause'); })} />
            )}
            {plan.status === 'paused' && (
              <ListRow title="繼續計畫" subtitle="回到進行中，重新開始安排時間"
                role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => manageAction(resumePlan)} />
            )}
            <ListRow title="刪除計畫" subtitle="從清單中移除，無法復原"
              role="button" tabIndex={0} style={{ cursor: 'pointer', color: 'var(--danger, #c0392b)' }}
              onClick={() => manageAction(() => { setRetain(null); setSheet('confirmDelete'); })} />
          </div>
          {err && <div className="error" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
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
        <BottomSheet onClose={lifecycleClose} label="暫停這個計畫" aria-busy={busy}>
          <b style={{ fontSize: 17 }}>暫停這個計畫？</b>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
            計畫會留著並標示為「已暫停」，但不會再排新的時間，也不會出現在今天要做的事裡。
            你隨時可以再繼續。
          </div>
          <RetainPicker kind="pause" value={retain} onChange={setRetain} />
          {err && <div className="error" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button disabled={busy} onClick={lifecycleClose}>取消</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }}
              disabled={busy || retain === null} onClick={pausePlan}>{busy ? '暫停中…' : '暫停計畫'}</Button>
          </div>
        </BottomSheet>
      )}

      {/* ---------- 刪除確認：跟暫停是完全不同的畫面，而且要按兩次 ----------
          刪除沒有「保留任務」選項：整個計畫連同所有任務都會移除。想留進度但不再
          繼續，正確操作是「結束計畫」，不是刪除。 */}
      {sheet === 'confirmDelete' && (
        <BottomSheet onClose={lifecycleClose} label="刪除這個計畫">
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
        <BottomSheet onClose={lifecycleClose} label="確定刪除" aria-busy={busy}>
          <b style={{ fontSize: 17, color: 'var(--danger, #c0392b)' }}>真的要刪除「{plan.name}」？</b>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
            這個動作沒有復原按鈕。計畫及其中所有任務都會從 App 中移除。
          </div>
          {err && <div className="error" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button disabled={busy} onClick={() => { if (!mutationBusy.current) setSheet('confirmDelete'); }}>返回</Button>
            <Button variant="destructive" style={{ marginLeft: 'auto' }}
              disabled={busy} onClick={deletePlan}>{busy ? '刪除中…' : '確定刪除'}</Button>
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
        <BottomSheet onClose={lifecycleClose} label="結束這個計畫" aria-busy={busy}>
          <b style={{ fontSize: 17 }}>結束這個計畫？</b>
          <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
            {unresolved > 0 && <>還有 {unresolved} 項未完成，它們會被保留下來。<br /></>}
            計畫會標示為「已結束」並退出排程，<b>不會</b>被算成完成。之後仍可重新開始。
          </div>
          {err && <div className="error" role="alert" style={{ marginTop: 'var(--sp-3)' }}>{err}</div>}
          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <Button disabled={busy} onClick={lifecycleClose}>取消</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={busy}
              onClick={() => endPlan(true)}>{busy ? '結束中…' : '結束計畫'}</Button>
          </div>
        </BottomSheet>
      )}

      {/* ---------- 加入既有內容 ---------- */}
      {sheet === 'addContent' && (
        <PlanContentPicker planId={plan.planId} tasks={tasks} lists={lists} onClose={close}
          onPreview={additions => { close(); setRollingAdditions(additions); setShowRolling(true); }} />
      )}

      {sheet === 'addSubject' && (
        <BottomSheet onClose={close} label="加入科目">
          <b style={{ fontSize: 18 }}>加入段考科目</b>
          <div className="ui-meta" style={{ marginTop: 2 }}>先預覽新版安排；確認前不會加入科目或變更行事曆。</div>
          <label className="ui-meta" htmlFor="exam-new-subject" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>科目</label>
          <select id="exam-new-subject" value={newSubject.subject_list_id} style={{ width: '100%', marginTop: 'var(--sp-1)' }}
            onChange={e => setNewSubject(s => ({ ...s, subject_list_id: e.target.value }))}>
            <option value="">請選擇科目</option>
            {availableExamSubjects.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <label className="ui-meta" htmlFor="exam-new-date" style={{ display: 'block', marginTop: 'var(--sp-3)' }}>考試日期</label>
          <input id="exam-new-date" type="date" value={newSubject.exam_date} min={raw?.start_date || undefined} max={raw?.target_date || undefined}
            style={{ width: '100%', marginTop: 'var(--sp-1)' }} onChange={e => setNewSubject(s => ({ ...s, exam_date: e.target.value }))} />
          <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
            <Button variant="tertiary" onClick={close}>取消</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={!newSubject.subject_list_id || !newSubject.exam_date}
              onClick={previewSubject}>預覽安排</Button>
          </div>
        </BottomSheet>
      )}

      {sheet === 'editSubjectDate' && editSubject && (
        <BottomSheet onClose={close} label="修改科目考試日">
          <b style={{ fontSize: 18 }}>{editSubject.subject_name}的考試日</b>
          <div className="ui-meta" style={{ marginTop: 2 }}>先預覽新版安排；確認前不會改動日期或行事曆。</div>
          <label className="ui-meta" htmlFor="exam-edit-date" style={{ display: 'block', marginTop: 'var(--sp-4)' }}>考試日期</label>
          <input id="exam-edit-date" type="date" value={editSubject.exam_date || ''} min={raw?.start_date || undefined} max={raw?.target_date || undefined}
            style={{ width: '100%', marginTop: 'var(--sp-1)' }} onChange={e => setEditSubject(s => ({ ...s, exam_date: e.target.value }))} />
          <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
            <Button variant="tertiary" onClick={close}>取消</Button>
            <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={!editSubject.exam_date} onClick={previewSubjectDate}>預覽安排</Button>
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
          {examSubjectsLoad.loading && <div className="ui-card ui-card--warning" role="status" style={{ marginTop: 8 }}>正在確認這份計畫的類型…</div>}
          {examSubjectsLoad.error && <div className="ui-card ui-card--warning" role="alert" style={{ marginTop: 8 }}>
            暫時無法確認是否為段考計畫，為避免開錯調整流程，請重試。
            <Button size="sm" variant="secondary" onClick={() => refreshExamSubjects(plan.planId)} style={{ marginLeft: 8 }}>重試</Button>
          </div>}
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <ListRow title="新增學習內容" subtitle="選好後先預覽新的安排，再確認套用"
              trailing={<Icon name="chevron" size={16} />} role="button" tabIndex={0} style={{ cursor: 'pointer' }}
              onClick={() => setSheet('addContent')}
              onKeyDown={e => { if (e.key === 'Enter') setSheet('addContent'); }} />
            <div className="ui-meta" style={{ padding: 'var(--sp-2) var(--sp-3)' }}>
              要移除範圍，請回到本頁「要讀完的範圍」逐項操作；系統也會先預覽影響。
            </div>
            {ADJUST.map(([sec, label, hint]) => (
              <ListRow key={sec} title={label} subtitle={hint}
                trailing={<Icon name="chevron" size={16} />} role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                onClick={() => { if (examSubjectsLoad.loading || examSubjectsLoad.error) return; close(); adjustPlan(plan.planId, sec, undefined, examSubjectIds.size > 0); }}
                onKeyDown={e => { if (e.key === 'Enter' && !examSubjectsLoad.loading && !examSubjectsLoad.error) { close(); adjustPlan(plan.planId, sec, undefined, examSubjectIds.size > 0); } }}
                aria-disabled={examSubjectsLoad.loading || !!examSubjectsLoad.error}
                style={{ cursor: examSubjectsLoad.loading || examSubjectsLoad.error ? 'not-allowed' : 'pointer', opacity: examSubjectsLoad.loading || examSubjectsLoad.error ? .55 : 1 }} />
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
      {drag && (
        <div aria-hidden="true" style={dragHintStyle}>
          <div className="ui-meta">{DRAG_HINT}</div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            {[[todayStr, '今天'], [addDays(todayStr, 1), '明天'], [PICK_DATE, '其他日期…']].map(([d, label]) => (
              <div key={d} data-drop-date={d} style={{ flex: 1, padding: '10px 4px', textAlign: 'center', ...dropZoneStyle(drag.target === d) }}>{label}</div>
            ))}
          </div>
        </div>
      )}
      <div role="status" aria-live="polite" className="sr-only">{announce}</div>
      {pickFor && <DatePickSheet title={rowTitle(pickFor.task || pickFor)}
        initial={pickFor.block?.date || effDate(pickFor.task || pickFor) || ''}
        onClose={() => setPickFor(null)}
        onPick={d => { const payload = pickFor; setPickFor(null); movePlanTask(payload, d); }} />}
      {adjustBlock && (
        <AdjustBlockSheet block={adjustBlock.block} task={adjustBlock.task} lists={lists}
          versionId={sched.version?.id}
          reload={async () => { await reload(); await sched.reload(); }}
          onClose={() => setAdjustBlock(null)} />
      )}
    </div>
  );
}
