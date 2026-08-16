import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';
import Tasks from './Tasks';
import Icon from './Icons';

// 「今天」＝執行頁：回答「我現在該做什麼」。
// 它不是 Tasks 的 today 篩選——上面多了今日進度、今天的固定行程、
// 以及「開始讀書」這個主要動作；下面才是今天要做的任務清單。
// 任務清單本身直接復用 Tasks（透過 topSlot 塞在上方），
// 不另外複製一套勾選／編輯／刪除的邏輯。

const HM = t => (t || '').slice(0, 5);

function TodayHeader({ tasks, goStudy }) {
  const [events, setEvents] = useState([]);
  useEffect(() => { api('/events').then(setEvents).catch(() => {}); }, []);

  const td = today();
  const mine = tasks.filter(t => !t.deleted && t.due_date === td);
  const done = mine.filter(t => t.completed).length;
  const left = mine.length - done;
  const pct = mine.length ? Math.round(done / mine.length * 100) : 0;

  // 今天適用的固定行程：單次比日期，每週比星期（跟後端 freeSlotsForDay 同一套判斷）
  const dow = new Date(td + 'T00:00:00Z').getUTCDay();
  const todayEv = events
    .filter(e => e.recurring === 'weekly'
      ? new Date(e.date + 'T00:00:00Z').getUTCDay() === dow && e.date <= td
      : e.date === td)
    .sort((a, b) => HM(a.start_time).localeCompare(HM(b.start_time)));

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="tile" style={{ padding: '12px 14px', background: 'var(--fill)' }}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <span style={{ fontSize: 26, fontWeight: 700 }}>{left}</span>
          <span className="muted">項待完成</span>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
            {mine.length ? `已完成 ${done}／${mine.length}` : '今天沒有排任務'}
          </span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--fill-strong)', marginTop: 8, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--primary)', transition: 'width .3s' }} />
        </div>
        <button className="btn" style={{ width: '100%', marginTop: 12, padding: '11px 0', fontSize: 16 }} onClick={goStudy}>
          <Icon name="pomo" size={18} style={{ verticalAlign: '-3px', marginRight: 6 }} />開始讀書
        </button>
      </div>

      {todayEv.length > 0 && (
        <div className="tgroup" style={{ marginTop: 10 }}>
          <div className="glabel">今天的行程</div>
          {todayEv.map(e => (
            <div key={e.id} className="trow" style={{ cursor: 'default' }}>
              <span className="muted" style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {HM(e.start_time)}–{HM(e.end_time)}
              </span>
              <span className="title">{e.title}</span>
              {e.location && <span className="muted" style={{ fontSize: 12 }}>{e.location}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TodayView({ tasks, lists, filters, habits, reload, goStudy, goVocab, goMemo }) {
  return (
    <Tasks
      view={{ type: 'today' }}
      tasks={tasks} lists={lists} filters={filters} habits={habits} reload={reload}
      title="今天"
      goVocab={goVocab} goMemo={goMemo}
      topSlot={<TodayHeader tasks={tasks} goStudy={goStudy} />}
    />
  );
}
