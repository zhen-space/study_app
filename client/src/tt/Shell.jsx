import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { matchView, today } from './helpers';
import Tasks from './Tasks';
import TodayView from './TodayView';
import PlansView from './PlansView';
import PlanDetailView from './PlanDetailView';
import StudyView from './StudyView';
import CalendarView from './CalendarView';
import MatrixView from './MatrixView';
import HabitsView from './HabitsView';
import StatsView from './StatsView';
import PetView from './PetView';
import WizardView from './WizardView';
import ExamCreateWizard from './ExamCreateWizard';
import VocabView from './VocabView';
import MemoView from './MemoView';
import ScheduleHistoryView from './ScheduleHistoryView';
import LocksView from './LocksView';
import RoutinesView from './RoutinesView';
import GoalsView from './GoalsView';
import MaterialLibraryView from './MaterialLibraryView';
import SettingsView from './SettingsView';
import SchoolAssignmentView from './SchoolAssignmentView';
import Companion from './Companion';
import GlobalAdd from './GlobalAdd';
import Icon from './Icons';
import { dueNotifications, notify } from './notify';

export default function Shell({ onLogout }) {
  // 資訊架構：今天（執行）｜計畫（計畫管理）｜讀書（主要動作）｜任務（任務管理）｜行事曆（時間管理）
  // 其餘既有功能（習慣、寵物、統計、矩陣、單字、備忘錄、精靈）移到側邊「更多」，功能都還在。
  // 「任務」這一格要涵蓋所有任務類視圖（清單、標籤、篩選、搜尋…）
  const TASK_VIEWS = ['tasks', 'week', 'inbox', 'all', 'completed', 'trash', 'list', 'tag', 'filter', 'search', 'school'];
  const [view, setViewRaw] = useState({ type: 'today' });
  const [side, setSide] = useState(false);
  const setView = v => { setViewRaw(v); setSide(false); };
  const [searchQ, setSearchQ] = useState('');
  const [tasks, setTasks] = useState([]);
  const [lists, setLists] = useState([]);
  const [filters, setFilters] = useState([]);
  const [habits, setHabits] = useState([]);
  const [petData, setPetData] = useState(null);
  const [apiPlans, setApiPlans] = useState([]);   // 正式 Plan（Phase 2A）
  const plansReloadRequest = useRef(0);

  // 改一筆任務不需要把清單／篩選／習慣整包重抓——之前每個動作都打 5 支 API，
  // 手機上就是每按一下等好幾百毫秒。scope='tasks' 只抓真正會變的（任務＋金幣）。
  // 回傳 Promise：建立計畫之後要等清單真的更新，才能開它的明細
  //
  // 回傳語義（callers 的「已寫入但刷新失敗」recovery 依賴這個契約）：
  //   ・/tasks 是主資料，失敗一定 reject——不能讓 caller 把舊畫面當成已同步
  //   ・/plans 只在「這次仍是最新一次 reload」時 reject（見下方）
  //   ・/pet、/lists、/filters、/habits 是可選資料，失敗安靜保留最後已知值
  // 一律等全部請求落定才 settle（allSettled），失敗時其他成功的資料仍會套用，
  // 也避免 caller 已顯示錯誤／重試時，上一輪請求還在背景覆寫狀態。
  const reload = async (scope) => {
    const planRequest = ++plansReloadRequest.current;
    const jobs = [
      api('/tasks').then(setTasks),
      api('/pet').then(setPetData).catch(() => {}),   // 完成任務會加金幣
      // 帶 includeArchived：計畫頁要能顯示（並恢復）已封存的計畫。
      // 較舊 reload 晚回來時不能覆蓋 CURRENT 狀態；CURRENT 讀取失敗也不能把
      // 最後已知的正式 Plan 清空。錯誤往上交給 lifecycle committed recovery，
      // 初次載入則由 effect 安靜保留空陣列，仍可走 legacy 推導。
      api('/plans?includeArchived=1').then(value => {
        if (planRequest === plansReloadRequest.current) setApiPlans(value);
      }).catch(error => {
        if (planRequest === plansReloadRequest.current) throw error;
      }),
    ];
    if (scope !== 'tasks') jobs.push(
      api('/lists').then(setLists).catch(() => {}),
      api('/filters').then(setFilters).catch(() => {}),
      api('/habits').then(setHabits).catch(() => {}),
    );
    const results = await Promise.allSettled(jobs);
    // jobs 順序固定 /tasks 在最前：兩者都失敗時優先回報任務刷新失敗
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  };
  useEffect(() => { reload().catch(() => {}); }, []);
  useEffect(() => { api('/pet').then(setPetData).catch(() => {}); }, [view.type]);
  // 通知權限改成使用者自己到「設定」按才要。一進 App 就跳系統對話框，
  // 大部分人會直接按拒絕——之後就再也問不到了。
  // Siri 捷徑/小工具替代：開 https://…/?add=買牛奶 就直接建一筆今天的任務
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get('add');
    if (t?.trim()) {
      api('/tasks', { method: 'POST', body: { title: t.trim(), due_date: today() } })
        // 回傳 reload 讓下面的 catch 接住刷新失敗；網址已清掉，不會重送建立
        .then(() => { window.history.replaceState({}, '', window.location.pathname); return reload(); })
        .catch(() => {});
    }
    const go = p.get('go'); // App 圖示快速選單（manifest shortcuts）
    if (go && ['wizard', 'vocab', 'memo', 'calendar', 'pomo', 'habits', 'pet', 'stats', 'today', 'plans', 'study', 'tasks', 'settings'].includes(go)) {
      setViewRaw({ type: go });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // 提醒（只在 App 開著時）：到期、快要開始讀書、逾期。
  // 每一種都可以在「設定」關掉；送過的記在 sentRef，同一則不會每 30 秒再響一次。
  const sentRef = useRef(new Set());
  const [blocks, setBlocks] = useState([]);
  useEffect(() => { api('/schedule/active').then(v => setBlocks(v?.blocks || [])).catch(() => {}); }, [view.type]);
  useEffect(() => {
    const tick = () => {
      for (const n of dueNotifications({ tasks, blocks, today: today(), sent: sentRef.current })) {
        if (notify(n.kind, n.title, n.body)) sentRef.current.add(n.key);
        else sentRef.current.add(n.key);   // 沒權限也記下來，不要每 30 秒重試一次
      }
    };
    tick();
    const iv = setInterval(tick, 30000);
    return () => clearInterval(iv);
  }, [tasks, blocks]);

  // §K：自訂標籤／清單／篩選器的管理已移出側欄——標籤/篩選器不再是學生 IA；
  // 科目（清單）改在「設定」管理。這裡只留主導航計數與 Global Add 意圖狀態。
  const [saReminderTime, setSaReminderTime] = useState('18:00');
  const [calAddIntent, setCalAddIntent] = useState(null);   // Global Add → 行事曆（'event'|'anniversary'）
  const [planCreateIntent, setPlanCreateIntent] = useState(false); // Global Add → 計畫（開建立計畫兩條路 sheet）
  useEffect(() => { api('/settings').then(s => { if (s.school_assignment_default_reminder_time) setSaReminderTime(s.school_assignment_default_reminder_time); }).catch(() => {}); }, []);
  const count = v => tasks.filter(t => matchView(t, v, { filters })).length;

  // 任務頁底下的清單分頁名稱（titleOf 用；智慧清單本身已移進「任務」頁的視圖切換列/篩選）
  const smart = [
    ['tasks', 'all', '所有任務'], ['week', 'week', '未來 7 天'], ['inbox', 'inbox', '願望清單'],
    ['completed', 'done', '已完成'], ['trash', 'trash', '垃圾桶'],
  ];
  // 主導航（桌面側邊欄也照同一套 IA）
  const mainNav = [['today', 'today', '今天'], ['plans', 'wizard', '計畫'], ['study', 'pomo', '讀書'], ['tasks', 'all', '任務'], ['calendar', 'calendar', '行事曆']];
  // §K 正式 IA：側欄只放次要功能，分四類。主導航（5）與舊 Todo IA（智慧清單／科目／
  // 篩選器／標籤）不再出現在側欄；排程精靈由「計畫→建立計畫」進入、時間設定由行事曆進入、
  // 排程鎖定改 context action（§N）、排程紀錄／矩陣退出第一層（route 仍在，供內部/深連結）。
  const pageGroups = [
    ['學習', [['goals', 'wizard', '目標'], ['material', 'book', '教材庫'], ['school', 'note', '學校作業'], ['stats', 'stats', '統計']]],
    ['工具', [['vocab', 'book', '單字本'], ['memo', 'note', '備忘錄'], ['habits', 'habit', '習慣']]],
    ['個人化', [['pet', 'paw', '寵物']]],
    ['App', [['settings', 'settings', '設定']]],
  ];

  const titleOf = () => {
    if (view.type === 'list') return lists.find(l => l.id === view.id)?.name || '';
    if (view.type === 'tag') return '#' + view.tag;
    if (view.type === 'filter') return filters.find(f => f.id === view.id)?.name || '';
    if (view.type === 'search') return `搜尋「${view.q}」`;
    if (view.type === 'tasks') return '所有任務';
    return smart.find(([t]) => t === view.type)?.[2] || '任務';
  };

  return (
    <div className="app">
      <button className="menu-btn" aria-label="開啟選單"
        style={{ position: 'fixed', top: 'calc(4px + env(safe-area-inset-top))', left: 4, zIndex: 10 }}
        onClick={() => setSide(true)}>☰</button>
      {side && <div className="backdrop" onClick={() => setSide(false)} />}
      <div className={'sidebar' + (side ? ' open' : '')}>
        <input placeholder="🔍 搜尋任務" value={searchQ} style={{ margin: '0 2px 8px', width: 'calc(100% - 4px)' }}
          onChange={e => { const q = e.target.value; setSearchQ(q); setViewRaw(q.trim() ? { type: 'search', q } : { type: 'today' }); }} />
        {/* §K：主導航只在桌機側欄出現（手機由底部導航負責，側欄抽屜不再放第二套主導航）。 */}
        <div className="side-primary">
          <div className="side-sec">主導航</div>
          {mainNav.map(([type, icon, label]) => (
            <div key={type} className={'side-item' + ((type === 'tasks' ? TASK_VIEWS.includes(view.type) : view.type === type) ? ' active' : '')} onClick={() => setView({ type })}>
              <Icon name={icon} size={18} style={{ opacity: .8 }} />{label}
              <span className="count">{type === 'today' ? count({ type: 'today' }) : ''}</span>
            </div>
          ))}
        </div>
        {pageGroups.map(([sec, items]) => (
          <div key={sec}>
            <div className="side-sec">{sec}</div>
            {items.map(([type, icon, label]) => (
              <div key={type} className={'side-item' + (view.type === type ? ' active' : '')} onClick={() => setView({ type })}>
                <Icon name={icon} size={18} style={{ opacity: .8 }} />{label}
              </div>
            ))}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div className="side-item" onClick={onLogout}><Icon name="logout" size={18} style={{ opacity: .8 }} />登出</div>
        <div className="muted" style={{ padding: '4px 12px', fontSize: 11 }}>版本 {window.APP_VER || ''}</div>
      </div>

      {view.type === 'today' ? <TodayView tasks={tasks} lists={lists} filters={filters} habits={habits} apiPlans={apiPlans} reload={reload}
            goStudy={() => setView({ type: 'study' })} goVocab={() => setView({ type: 'vocab' })} goMemo={() => setView({ type: 'memo' })}
            goWizardEdit={(planId, section) => setView({ type: 'wizard', mode: 'edit', planId, section, from: `plan:${planId}` })} />
        : view.type === 'plans' ? <PlansView tasks={tasks} lists={lists} apiPlans={apiPlans} reload={reload}
            openPlan={k => setView({ type: 'plan', key: k })} goWizard={() => setView({ type: 'wizard' })}
            createIntent={planCreateIntent} onCreateIntentHandled={() => setPlanCreateIntent(false)}
            goExamWizard={() => setView({ type: 'exam-wizard' })}
            createGeneralPlan={async () => {
              // 保留「一般／空白計畫」能力（非段考）：建立空白計畫並進明細。
              const p = await api('/plans', { method: 'POST', body: { name: '新的計畫', status: 'active', source: 'manual' } });
              // 計畫已建立：刷新失敗也照樣前往明細，不能留在原地讓使用者再按一次而重複建立
              await reload().catch(() => {});
              setView({ type: 'plan', key: `plan:${p.id}` });
            }}
            goWizardMode={m => setView({ type: 'wizard', scheduleMode: m })} />
        : view.type === 'exam-wizard' ? <ExamCreateWizard key="exam-wizard" lists={lists}
            onCancel={() => setView({ type: 'plans' })}
            onManageSubjects={() => setView({ type: 'settings' })}
            // 段考已在伺服器原子建立：刷新失敗也要離開精靈（否則會卡在「建立中」）
            onDone={async pid => { await reload().catch(() => {}); setView({ type: 'plan', key: `plan:${pid}` }); }} />
        : view.type === 'plan' ? <PlanDetailView planKey={view.key} tasks={tasks} lists={lists} apiPlans={apiPlans} reload={reload}
            onBack={() => setView({ type: 'plans' })} goWizard={() => setView({ type: 'wizard' })}
            // 「調整計畫」＝Edit Mode：帶著這個計畫進精靈，不會建立新計畫
            adjustPlan={(planId, section, scheduleMode) => setView({ type: 'wizard', mode: 'edit', planId, section, scheduleMode, from: view.key })}
            goLocks={() => setView({ type: 'locks' })}
            goScheduleHistory={() => setView({ type: 'schedule-history' })} />
        : view.type === 'study' || view.type === 'pomo' ? <StudyView tasks={tasks.filter(t => !t.deleted)} goPlans={() => setView({ type: 'plans' })} />
        : view.type === 'calendar' ? <CalendarView tasks={tasks.filter(t => !t.deleted)} reload={reload} lists={lists}
            addIntent={calAddIntent} onAddIntentHandled={() => setCalAddIntent(null)}
            onTimeSettings={() => setView({ type: 'routines' })} />
        : view.type === 'schedule-history' ? <ScheduleHistoryView onRestored={() => reload('tasks')} />
        : view.type === 'locks' ? <LocksView tasks={tasks} />
        : view.type === 'routines' ? <RoutinesView />
        : view.type === 'material' ? <MaterialLibraryView lists={lists} goPlans={() => setView({ type: 'plans' })} />
        : view.type === 'goals' ? <GoalsView plans={apiPlans} reloadPlans={() => reload()} />
        : view.type === 'matrix' ? <MatrixView tasks={tasks.filter(t => !t.deleted)} reload={reload} />
        : view.type === 'habits' ? <HabitsView habits={habits} reload={reload} />
        : view.type === 'stats' ? <StatsView />
        : view.type === 'settings' ? <SettingsView lists={lists} reload={reload} />
        : view.type === 'pet' ? <PetView />
        // key：建立／調整不同計畫要當成不同的精靈重新開始，
        // 否則 React 會沿用同一個實例，草稿與既有任務都會是上一個計畫的
        : view.type === 'wizard' ? <WizardView key={`wz:${view.mode || 'create'}:${view.planId ?? 'new'}:${view.section || ''}`} lists={lists} tasks={tasks} reload={reload}
            goTasks={() => setView({ type: 'today' })} goCalendar={() => setView({ type: 'calendar' })}
            mode={view.mode || 'create'} planId={view.planId ?? null} initialSection={view.section || ''}
            scheduleMode={view.scheduleMode || 'timed'}
            planTitle={apiPlans.find(p => p.id === view.planId)?.name || ''}
            planTasks={view.planId != null ? tasks.filter(t => t.plan_id === view.planId) : []}
            onDone={() => setView({ type: 'plan', key: view.from || `plan:${view.planId}` })} />
        : view.type === 'vocab' ? <VocabView />
        : view.type === 'memo' ? <MemoView />
        : view.type === 'school' ? <SchoolAssignmentView tasks={tasks.filter(t => !t.deleted)} lists={lists} plans={apiPlans} reload={reload} />
        : <Tasks view={view} tasks={tasks} lists={lists} filters={filters} habits={habits} reload={reload} title={titleOf()}
            onNav={setView}
            goVocab={() => setView({ type: 'vocab' })} goMemo={() => setView({ type: 'memo' })} />}

      {view.type !== 'pet' && petData && <Companion pet={petData.pet} tasks={tasks} />}

      {/* Global Add（§A）：Today / 計畫 / 任務 / 行事曆 共用同一顆右下 ＋。
          Study / Wizard / Plan 明細 / 設定等操作或表單狀態不顯示。 */}
      {(['today', 'plans', 'calendar'].includes(view.type) || TASK_VIEWS.includes(view.type)) && (
        <GlobalAdd lists={lists} reload={reload} defaultReminderTime={saReminderTime}
          onPlan={() => setViewRaw({ type: 'exam-wizard' })}
          onCalendarAdd={kind => { setCalAddIntent(kind); setViewRaw({ type: 'calendar' }); }} />
      )}

      {/* 手機底部導航：今天｜計畫｜〔讀書〕｜任務｜行事曆。
          「讀書」是中央主要動作，不是一般分頁——凸起的圓形按鈕、永遠是強調色。 */}
      <div className="bottom-nav">
        <button className={view.type === 'today' ? 'on' : ''} onClick={() => setView({ type: 'today' })}>
          <Icon name="today" size={22} className="bi" />今天
        </button>
        <button className={['plans', 'plan'].includes(view.type) ? 'on' : ''} onClick={() => setView({ type: 'plans' })}>
          <Icon name="wizard" size={22} className="bi" />計畫
        </button>
        <button className="primary" aria-label="開始讀書" onClick={() => setView({ type: 'study' })}>
          <span className={'primary-fab' + (view.type === 'study' ? ' on' : '')}><Icon name="pomo" size={26} /></span>
          <span className="primary-label">讀書</span>
        </button>
        <button className={TASK_VIEWS.includes(view.type) ? 'on' : ''} onClick={() => setView({ type: 'tasks' })}>
          <Icon name="all" size={22} className="bi" />任務
        </button>
        <button className={view.type === 'calendar' ? 'on' : ''} onClick={() => setView({ type: 'calendar' })}>
          <Icon name="calendar" size={22} className="bi" />行事曆
        </button>
      </div>
    </div>
  );
}
