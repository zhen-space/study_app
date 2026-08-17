import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';
import Tasks from './Tasks';
import Icon from './Icons';
import { usePlans } from './plans';
import { usePlansNeedingAdjustment } from './planHealth';
import ReplanSheet from './ReplanSheet';

// 「今天」＝執行頁：回答「我現在該做什麼」。
// 它不是 Tasks 的 today 篩選——上面多了今日進度、今天的固定行程、
// 以及「開始讀書」這個主要動作；下面才是今天要做的任務清單。
// 任務清單本身直接復用 Tasks（透過 topSlot 塞在上方），
// 不另外複製一套勾選／編輯／刪除的邏輯。

const HM = t => (t || '').slice(0, 5);

// 計畫已經明顯偏離目前安排時，Today 主動說一聲，並給一個直接重排的入口。
// 一切正常就什麼都不顯示——這裡不該變成常駐的紅字。
function AdjustBanner({ tasks, lists, apiPlans, reload, goWizardEdit }) {
  const plans = usePlans(tasks, lists, apiPlans);
  const needing = usePlansNeedingAdjustment(plans, apiPlans);
  const [dismissed, setDismissed] = useState([]);   // 只是這次畫面上收起來，不動任何資料
  const [picking, setPicking] = useState(false);
  const [replanKey, setReplanKey] = useState(null);

  const live = needing.filter(h => !dismissed.includes(h.planId));
  if (!live.length) return null;

  const health = live.find(h => h.planKey === replanKey);
  const plan = plans.find(p => p.key === replanKey);

  const cta = h => (
    <div className="row" style={{ marginTop: 10 }}>
      <button className="btn sm" onClick={() => setReplanKey(h.planKey)}>讓 AI 重新安排</button>
      {/* 「稍後」只把提示收起來，不改計畫狀態、不寫任何旗標。
          問題還在的話，下次進 Today 還是會再出現。 */}
      <button className="btn sm ghost" onClick={() => setDismissed(d => [...d, h.planId])}>稍後</button>
    </div>
  );

  return (
    <>
      <div className="tile" style={{ padding: '12px 14px', marginBottom: 10, borderLeft: '3px solid var(--orange, #C46A22)' }}>
        {live.length === 1 ? (
          <>
            <div className="row"><b>計畫需要調整</b></div>
            <div style={{ marginTop: 2 }}>{live[0].name}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              {live[0].reasons[0].message}，目前安排需要重新計算。
            </div>
            {cta(live[0])}
          </>
        ) : (
          <>
            {/* 多個計畫時只給摘要，不要堆一排大方塊 */}
            <div className="row"><b>{live.length} 個計畫需要調整</b></div>
            {live.slice(0, 3).map(h => (
              <div key={h.planId} className="muted" style={{ fontSize: 13, marginTop: 2 }}>{h.name}</div>
            ))}
            {live.length > 3 && <div className="muted" style={{ fontSize: 12 }}>…還有 {live.length - 3} 個</div>}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn sm" onClick={() => setPicking(v => !v)}>查看</button>
            </div>
            {picking && live.map(h => (
              <div key={h.planId} className="tile" style={{ padding: '10px 12px', marginTop: 8, background: 'var(--fill)' }}>
                <b>{h.name}</b>
                <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{h.reasons[0].message}</div>
                {cta(h)}
              </div>
            ))}
          </>
        )}
      </div>

      {plan && health && (
        <ReplanSheet plan={plan} health={health} raw={apiPlans.find(p => p.id === plan.planId)}
          lists={lists} reload={reload} onClose={() => setReplanKey(null)}
          onEditConditions={sec => { setReplanKey(null); goWizardEdit?.(plan.planId, sec); }} />
      )}
    </>
  );
}

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

export default function TodayView({ tasks, lists, filters, habits, apiPlans = [], reload, goStudy, goVocab, goMemo, goWizardEdit }) {
  return (
    <Tasks
      view={{ type: 'today' }}
      tasks={tasks} lists={lists} filters={filters} habits={habits} reload={reload}
      title="今天"
      goVocab={goVocab} goMemo={goMemo}
      topSlot={<>
        <AdjustBanner tasks={tasks} lists={lists} apiPlans={apiPlans} reload={reload} goWizardEdit={goWizardEdit} />
        <TodayHeader tasks={tasks} goStudy={goStudy} />
      </>}
    />
  );
}
