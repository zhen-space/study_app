import { useEffect, useMemo, useState } from 'react';
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
import Companion from './Companion';
import Icon, { LIST_ICONS, LIST_COLORS } from './Icons';

export default function Shell({ onLogout }) {
  // 資訊架構：今天（執行）｜計畫（計畫管理）｜讀書（主要動作）｜任務（任務管理）｜行事曆（時間管理）
  // 其餘既有功能（習慣、寵物、統計、矩陣、單字、備忘錄、精靈）移到側邊「更多」，功能都還在。
  // 「任務」這一格要涵蓋所有任務類視圖（清單、標籤、篩選、搜尋…）
  const TASK_VIEWS = ['tasks', 'week', 'inbox', 'all', 'completed', 'trash', 'list', 'tag', 'filter', 'search'];
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
  // 提醒通知需要授權（之前從沒請求過，通知一直發不出來）
  useEffect(() => {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {}
  }, []);
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
    if (go && ['wizard', 'vocab', 'memo', 'calendar', 'pomo', 'habits', 'pet', 'stats', 'today', 'plans', 'study', 'tasks'].includes(go)) {
      setViewRaw({ type: go });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // due-time reminders (while app open)
  useEffect(() => {
    const iv = setInterval(() => {
      const now = new Date();
      const hm = now.toTimeString().slice(0, 5);
      tasks.forEach(t => {
        if (!t.completed && t.due_date === today() && t.due_time === hm && !t._notified) {
          t._notified = true;
          try { new Notification('任務提醒', { body: t.title }); } catch {}
        }
      });
    }, 30000);
    return () => clearInterval(iv);
  }, [tasks]);

  // 自訂標籤（存在帳號設定）＋任務上實際出現的標籤；防髒資料：tags 一定要是陣列
  const [customTags, setCustomTags] = useState([]);
  useEffect(() => { api('/settings').then(s => setCustomTags(s.custom_tags || [])).catch(() => {}); }, []);
  const tags = useMemo(() => [...new Set([
    ...customTags,
    ...tasks.flatMap(t => Array.isArray(t.tags) ? t.tags : []),
  ])].filter(t => typeof t === 'string' && t.trim() && !/^[a-zA-Z]{1,2}$/.test(t.trim())), [tasks, customTags]);
  async function addTag() {
    const name = prompt('新標籤名稱：');
    if (!name?.trim()) return;
    const next = [...new Set([...customTags, name.trim()])];
    setCustomTags(next);
    await api('/settings', { method: 'PUT', body: { custom_tags: next } });
  }
  async function delTag(t) {
    if (!confirm(`移除標籤「${t}」？（不影響已標記的任務）`)) return;
    const next = customTags.filter(x => x !== t);
    setCustomTags(next);
    await api('/settings', { method: 'PUT', body: { custom_tags: next } });
  }
  const count = v => tasks.filter(t => matchView(t, v, { filters })).length;

  async function addList() {
    const name = prompt('清單名稱：');
    if (!name?.trim()) return;
    await api('/lists', { method: 'POST', body: { name: name.trim(), color: LIST_COLORS[lists.length % LIST_COLORS.length] } });
    reload();
  }
  async function addFilter() {
    const name = prompt('篩選器名稱：');
    if (!name?.trim()) return;
    const pri = prompt('只顯示優先級？（0無 1低 2中 3高，留空不限）');
    const tag = prompt('只顯示標籤？（留空不限）');
    const due = prompt('期限？（today / week / overdue，留空不限）');
    const rule = {};
    if (pri) rule.priority = +pri;
    if (tag) rule.tag = tag.trim();
    if (due) rule.due = due.trim();
    await api('/filters', { method: 'POST', body: { name: name.trim(), rule } });
    reload();
  }
  async function delList(l) {
    if (!confirm(`刪除清單「${l.name}」？（任務會移到願望清單）`)) return;
    await api(`/lists/${l.id}`, { method: 'DELETE' });
    if (view.type === 'list' && view.id === l.id) setView({ type: 'today' });
    reload();
  }

  // 任務頁底下的清單分頁（「今天」已經獨立成主導航，這裡不再重複）
  const smart = [
    ['tasks', 'all', '所有任務'], ['week', 'week', '未來 7 天'], ['inbox', 'inbox', '願望清單'],
    ['completed', 'done', '已完成'], ['trash', 'trash', '垃圾桶'],
  ];
  const [editList, setEditList] = useState(null); // 正在編輯的清單 id
  async function patchList(l, body) {
    await api(`/lists/${l.id}`, { method: 'PATCH', body });
    reload();
  }
  async function shareList(l) {
    const members = await api(`/lists/${l.id}/shares`).catch(() => []);
    const cur = members.length ? `目前共享給：${members.map(m => m.email).join('、')}\n（輸入其中一個 email 可取消共享）\n\n` : '';
    const email = prompt(`${cur}輸入要共享「${l.name}」的對象 email：`);
    if (!email?.trim()) return;
    const ex = members.find(m => m.email === email.trim().toLowerCase());
    if (ex) {
      if (confirm(`取消與 ${ex.email} 的共享？`)) await api(`/lists/${l.id}/share/${ex.id}`, { method: 'DELETE' });
    } else {
      try { await api(`/lists/${l.id}/share`, { method: 'POST', body: { email: email.trim() } }); alert('已共享！對方登入後就會看到這個清單'); }
      catch (e) { alert(e.message); }
    }
    reload();
  }
  // 主導航（桌面側邊欄也照同一套 IA）
  const mainNav = [['today', 'today', '今天'], ['plans', 'wizard', '計畫'], ['study', 'pomo', '讀書'], ['tasks', 'all', '任務'], ['calendar', 'calendar', '行事曆']];
  // 不屬於五大主導航的既有功能：一個都沒刪，收在「更多」
  const pages = [['wizard', 'wizard', '排程精靈'], ['schedule-history', 'calendar', '排程紀錄'], ['locks', 'calendar', '排程鎖定'], ['vocab', 'book', '單字本'], ['memo', 'note', '備忘錄'], ['matrix', 'matrix', '矩陣'], ['habits', 'habit', '習慣'], ['pet', 'paw', '寵物'], ['stats', 'stats', '統計']];

  const is = v => JSON.stringify(view) === JSON.stringify(v);
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
        <div className="side-sec">主導航</div>
        {mainNav.map(([type, icon, label]) => (
          <div key={type} className={'side-item' + (view.type === type ? ' active' : '')} onClick={() => setView({ type })}>
            <Icon name={icon} size={18} style={{ opacity: .8 }} />{label}
            <span className="count">{type === 'today' ? count({ type: 'today' }) : ''}</span>
          </div>
        ))}
        <div className="side-sec">任務清單</div>
        {smart.map(([type, icon, label]) => (
          <div key={type} className={'side-item' + (is({ type }) ? ' active' : '')} onClick={() => setView({ type })}>
            <Icon name={icon} size={18} style={{ opacity: .8 }} />{label}
            <span className="count">{!['completed', 'trash'].includes(type) ? count({ type }) : ''}</span>
          </div>
        ))}
        <div className="side-sec">清單 <button className="icon-btn" onClick={addList}>＋</button></div>
        {lists.map(l => (
          <div key={l.id}>
            <div className={'side-item' + (is({ type: 'list', id: l.id }) ? ' active' : '')} onClick={() => setView({ type: 'list', id: l.id })}>
              <Icon name={l.icon || 'book'} size={18} style={{ color: l.color }} />
              {l.name}{l.shared_in ? <span className="muted" style={{ fontSize: 11 }}>（{l.owner_email}）</span> : ''}
              {l.shared_out ? <Icon name="share" size={13} style={{ opacity: .5 }} /> : null}
              <span className="count">{count({ type: 'list', id: l.id })}</span>
              {!l.shared_in &&
                <button className="icon-btn" title="編輯清單" onClick={e => { e.stopPropagation(); setEditList(editList === l.id ? null : l.id); }}>
                  <Icon name="pencil" size={15} />
                </button>}
            </div>
            {editList === l.id && (
              <div className="list-editor">
                <input defaultValue={l.name} onBlur={e => e.target.value.trim() && e.target.value.trim() !== l.name && patchList(l, { name: e.target.value.trim() })}
                  onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
                <div className="swatches">
                  {LIST_COLORS.map(c => (
                    <span key={c} className={'swatch' + (l.color === c ? ' on' : '')} style={{ background: c }} onClick={() => patchList(l, { color: c })} />
                  ))}
                </div>
                <div className="icon-grid">
                  {LIST_ICONS.map(ic => (
                    <span key={ic} className={'icon-cell' + ((l.icon || 'book') === ic ? ' on' : '')} style={{ color: l.color }}
                      onClick={() => patchList(l, { icon: ic })}><Icon name={ic} size={18} /></span>
                  ))}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn sm ghost" onClick={() => shareList(l)}><Icon name="share" size={14} /> 共享</button>
                  <button className="btn sm ghost" style={{ color: 'var(--red)' }} onClick={() => delList(l)}><Icon name="trash" size={14} /> 刪除</button>
                  <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setEditList(null)}><Icon name="check" size={14} /></button>
                </div>
              </div>
            )}
          </div>
        ))}
        <div className="side-sec">篩選器 <button className="icon-btn" onClick={addFilter}>＋</button></div>
        {filters.map(f => (
          <div key={f.id} className={'side-item' + (is({ type: 'filter', id: f.id }) ? ' active' : '')} onClick={() => setView({ type: 'filter', id: f.id })}>
            🔍 {f.name}
            <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={e => { e.stopPropagation(); api(`/filters/${f.id}`, { method: 'DELETE' }).then(reload); }}>✕</button>
          </div>
        ))}
        <div className="side-sec">標籤 <button className="icon-btn" onClick={addTag}><Icon name="plus" size={14} /></button></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 10px' }}>
          {tags.map(t => (
            <span key={t} className={'tag-pill' + (is({ type: 'tag', tag: t }) ? ' on' : '')} onClick={() => setView({ type: 'tag', tag: t })}>
              #{t}{customTags.includes(t) && <span style={{ marginLeft: 4, opacity: .6 }} onClick={e => { e.stopPropagation(); delTag(t); }}>×</span>}
            </span>
          ))}
        </div>
        <div className="side-sec">更多</div>
        {pages.map(([type, icon, label]) => (
          <div key={type} className={'side-item' + (view.type === type ? ' active' : '')} onClick={() => setView({ type })}>
            <Icon name={icon} size={18} style={{ opacity: .8 }} />{label}
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
            openPlan={k => setView({ type: 'plan', key: k })} goWizard={() => setView({ type: 'wizard' })} />
        : view.type === 'plan' ? <PlanDetailView planKey={view.key} tasks={tasks} lists={lists} apiPlans={apiPlans} reload={reload}
            onBack={() => setView({ type: 'plans' })} goWizard={() => setView({ type: 'wizard' })}
            // 「調整計畫」＝Edit Mode：帶著這個計畫進精靈，不會建立新計畫
            adjustPlan={(planId, section) => setView({ type: 'wizard', mode: 'edit', planId, section, from: view.key })} />
        : view.type === 'study' || view.type === 'pomo' ? <StudyView tasks={tasks.filter(t => !t.deleted)} />
        : view.type === 'calendar' ? <CalendarView tasks={tasks.filter(t => !t.deleted)} reload={reload} />
        : view.type === 'schedule-history' ? <ScheduleHistoryView onRestored={() => reload('tasks')} />
        : view.type === 'locks' ? <LocksView tasks={tasks} />
        : view.type === 'matrix' ? <MatrixView tasks={tasks.filter(t => !t.deleted)} reload={reload} />
        : view.type === 'habits' ? <HabitsView habits={habits} reload={reload} />
        : view.type === 'stats' ? <StatsView />
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
        : <Tasks view={view} tasks={tasks} lists={lists} filters={filters} habits={habits} reload={reload} title={titleOf()}
            goVocab={() => setView({ type: 'vocab' })} goMemo={() => setView({ type: 'memo' })} />}

      {view.type !== 'pet' && petData && <Companion pet={petData.pet} tasks={tasks} />}

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
