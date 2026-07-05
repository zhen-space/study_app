import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { matchView, today } from './helpers';
import Tasks from './Tasks';
import CalendarView from './CalendarView';
import MatrixView from './MatrixView';
import HabitsView from './HabitsView';
import PomoView from './PomoView';
import StatsView from './StatsView';
import PetView from './PetView';
import WizardView from './WizardView';
import Companion from './Companion';

const LIST_COLORS = ['#4772fa', '#e03131', '#16a34a', '#f59f00', '#9333ea', '#0891b2'];

export default function Shell({ onLogout }) {
  const [view, setViewRaw] = useState({ type: 'today' });
  const [side, setSide] = useState(false);
  const setView = v => { setViewRaw(v); setSide(false); };
  const [tasks, setTasks] = useState([]);
  const [lists, setLists] = useState([]);
  const [filters, setFilters] = useState([]);
  const [habits, setHabits] = useState([]);
  const [petData, setPetData] = useState(null);

  const reload = () => {
    api('/tasks').then(setTasks);
    api('/lists').then(setLists);
    api('/filters').then(setFilters);
    api('/habits').then(setHabits);
    api('/pet').then(setPetData);
  };
  useEffect(reload, []);
  useEffect(() => { api('/pet').then(setPetData).catch(() => {}); }, [view.type]);

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

  const tags = useMemo(() => [...new Set(tasks.flatMap(t => t.tags))], [tasks]);
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

  const smart = [
    ['today', '📅 今天'], ['week', '🗓️ 未來 7 天'], ['inbox', '💭 願望清單'],
    ['all', '📋 所有任務'], ['completed', '✅ 已完成'],
  ];
  const pages = [['wizard', '🪄 排程精靈'], ['calendar', '🗓 日曆'], ['matrix', '🔲 矩陣'], ['habits', '🌱 習慣'], ['pomo', '🍅 番茄鐘'], ['pet', '🐾 寵物'], ['stats', '📊 統計']];

  const is = v => JSON.stringify(view) === JSON.stringify(v);
  const titleOf = () => {
    if (view.type === 'list') return lists.find(l => l.id === view.id)?.name || '';
    if (view.type === 'tag') return '#' + view.tag;
    if (view.type === 'filter') return filters.find(f => f.id === view.id)?.name || '';
    return smart.find(([t]) => t === view.type)?.[1].slice(2) || '';
  };

  return (
    <div className="app">
      <button className="menu-btn" style={{ position: 'fixed', top: 'calc(4px + env(safe-area-inset-top))', left: 4, zIndex: 10 }} onClick={() => setSide(true)}>☰</button>
      {side && <div className="backdrop" onClick={() => setSide(false)} />}
      <div className={'sidebar' + (side ? ' open' : '')}>
        {smart.map(([type, label]) => (
          <div key={type} className={'side-item' + (is({ type }) ? ' active' : '')} onClick={() => setView({ type })}>
            {label}<span className="count">{type !== 'completed' ? count({ type }) : ''}</span>
          </div>
        ))}
        <div className="side-sec">清單 <button className="icon-btn" onClick={addList}>＋</button></div>
        {lists.map(l => (
          <div key={l.id} className={'side-item' + (is({ type: 'list', id: l.id }) ? ' active' : '')} onClick={() => setView({ type: 'list', id: l.id })}>
            <span className="dot" style={{ background: l.color }} />{l.name}
            <span className="count">{count({ type: 'list', id: l.id })}</span>
            <button className="icon-btn" onClick={e => { e.stopPropagation(); delList(l); }}>✕</button>
          </div>
        ))}
        <div className="side-sec">篩選器 <button className="icon-btn" onClick={addFilter}>＋</button></div>
        {filters.map(f => (
          <div key={f.id} className={'side-item' + (is({ type: 'filter', id: f.id }) ? ' active' : '')} onClick={() => setView({ type: 'filter', id: f.id })}>
            🔍 {f.name}
            <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={e => { e.stopPropagation(); api(`/filters/${f.id}`, { method: 'DELETE' }).then(reload); }}>✕</button>
          </div>
        ))}
        {tags.length > 0 && <div className="side-sec">標籤</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 10px' }}>
          {tags.map(t => (
            <span key={t} className={'tag-pill' + (is({ type: 'tag', tag: t }) ? ' on' : '')} onClick={() => setView({ type: 'tag', tag: t })}>#{t}</span>
          ))}
        </div>
        <div className="side-sec">更多</div>
        {pages.map(([type, label]) => (
          <div key={type} className={'side-item' + (view.type === type ? ' active' : '')} onClick={() => setView({ type })}>{label}</div>
        ))}
        <div style={{ flex: 1 }} />
        <div className="side-item" onClick={onLogout}>🚪 登出</div>
      </div>

      {view.type === 'calendar' ? <CalendarView tasks={tasks} reload={reload} />
        : view.type === 'matrix' ? <MatrixView tasks={tasks} reload={reload} />
        : view.type === 'habits' ? <HabitsView habits={habits} reload={reload} />
        : view.type === 'pomo' ? <PomoView tasks={tasks} />
        : view.type === 'stats' ? <StatsView />
        : view.type === 'pet' ? <PetView />
        : view.type === 'wizard' ? <WizardView lists={lists} reload={reload} goTasks={() => setView({ type: 'today' })} />
        : <Tasks view={view} tasks={tasks} lists={lists} filters={filters} reload={reload} title={titleOf()} />}

      {view.type !== 'pet' && petData && <Companion pet={petData.pet} tasks={tasks} />}

      <div className="bottom-nav">
        {[
          [{ type: 'today' }, '☑️', '任務', v => !['calendar', 'matrix', 'habits', 'pomo', 'stats', 'pet', 'wizard'].includes(v.type)],
          [{ type: 'wizard' }, '🪄', '排程'],
          [{ type: 'calendar' }, '🗓️', '日曆'],
          [{ type: 'habits' }, '🌱', '習慣'],
          [{ type: 'pet' }, '🐾', '寵物'],
        ].map(([v, icon, label, test]) => (
          <button key={label} className={(test ? test(view) : view.type === v.type) ? 'on' : ''} onClick={() => setView(v)}>
            <span className="bi">{icon}</span>{label}
          </button>
        ))}
      </div>
    </div>
  );
}
