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

  // 改一筆任務不需要把清單／篩選／習慣整包重抓——之前每個動作都打 5 支 API，
  // 手機上就是每按一下等好幾百毫秒。scope='tasks' 只抓真正會變的（任務＋金幣）。
  // 回傳 Promise：建立計畫之後要等清單真的更新，才能開它的明細
  const reload = (scope) => {
    const jobs = [
      api('/tasks').then(setTasks).catch(() => {}),
      api('/pet').then(setPetData).catch(() => {}),   // 完成任務會加金幣
      // 帶 includeArchived：計畫頁要能顯示（並恢復）已封存的計畫。
      // 舊後端沒有這支也要能跑，所以失敗就退回空陣列走 legacy 推導。
      api('/plans?includeArchived=1').then(setApiPlans).catch(() => setApiPlans([])),
    ];
    if (scope !== 'tasks') jobs.push(
      api('/lists').then(setLists).catch(() => {}),
      api('/filters').then(setFilters).catch(() => {}),
      api('/habits').then(setHabits).catch(() => {}),
    );
    return Promise.all(jobs);
  };
  useEffect(() => { reload(); }, []);
  useEffect(() => { api('/pet').then(setPetData).catch(() => {}); }, [view.type]);
  // 通知權限改成使用者自己到「設定」按才要。一進 App 就跳系統對話框，
  // 大部分人會直接按拒絕——之後就再也問不到了。
  // Siri 捷徑/小工具替代：開 https://…/?add=買牛奶 就直接建一筆今天的任務
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get('add');
    if (t?.trim()) {
      api('/tasks', { method: 'POST', body: { title: t.trim(), due_date: today() } })
        .then(() => { window.history.replaceState({}, '', window.location.pathname); reload(); })
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
    ['學習', [['goals', 'wizard', '目標'], ['material', 'book', '教材庫'], ['stats', 'stats', '統計']]],
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
            createIntent={planCreateIntent} onCreateIntentHandled={() => setPlanCreateIntent(false)} />
        : view.type === 'plan' ? <PlanDetailView planKey={view.key} tasks={tasks} lists={lists} apiPlans={apiPlans} reload={reload}
            onBack={() => setView({ type: 'plans' })} goWizard={() => setView({ type: 'wizard' })}
            // 「調整計畫」＝Edit Mode：帶著這個計畫進精靈，不會建立新計畫
            adjustPlan={(planId, section) => setView({ type: 'wizard', mode: 'edit', planId, section, from: view.key })}
            goLocks={() => setView({ type: 'locks' })} />
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
            planTitle={apiPlans.find(p => p.id === view.planId)?.name || ''}
            planTasks={view.planId != null ? tasks.filter(t => t.plan_id === view.planId) : []}
            onDone={() => setView({ type: 'plan', key: view.from || `plan:${view.planId}` })} />
        : view.type === 'vocab' ? <VocabView />
        : view.type === 'memo' ? <MemoView />
        : view.type === 'school' ? <SchoolAssignmentView tasks={tasks.filter(t => !t.deleted)} lists={lists} reload={reload} />
        : <Tasks view={view} tasks={tasks} lists={lists} filters={filters} habits={habits} reload={reload} title={titleOf()}
            onNav={setView}
            goVocab={() => setView({ type: 'vocab' })} goMemo={() => setView({ type: 'memo' })} />}

      {view.type !== 'pet' && petData && <Companion pet={petData.pet} tasks={tasks} />}

      {/* Global Add（§A）：Today / 計畫 / 任務 / 行事曆 共用同一顆右下 ＋。
          Study / Wizard / Plan 明細 / 設定等操作或表單狀態不顯示。 */}
      {(['today', 'plans', 'calendar'].includes(view.type) || TASK_VIEWS.includes(view.type)) && (
        <GlobalAdd lists={lists} reload={reload} defaultReminderTime={saReminderTime}
          onPlan={() => { setPlanCreateIntent(true); setViewRaw({ type: 'plans' }); }}
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
