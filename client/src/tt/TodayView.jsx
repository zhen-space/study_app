import { useEffect, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';
import Tasks from './Tasks';
import Icon from './Icons';
import { usePlans, shortTitle } from './plans';
import { usePlansNeedingAdjustment } from './planHealth';
import ReplanSheet from './ReplanSheet';
import { Button, SurfaceCard, ProgressBar } from './ui';
import { useActiveSchedule, blocksForTask } from './scheduleAdjust';
import AdjustBlockSheet from './AdjustBlockSheet';

// 「今天」＝執行頁：回答「我現在該做什麼」。
//
// UI-R1 起，這一頁是全 App 的母版：大標題 → 今日狀態 → 需要處理的事情
// → 接下來（時間軸）→ 今天的待辦 → 中央主要動作。
// 版面層級靠背景階層與留白做出來，不是每一塊都包一個同樣的大方框。
//
// 任務清單本身仍直接復用 Tasks（透過 topSlot 塞在上方），
// 不另外複製一套勾選／編輯／刪除的邏輯。

const HM = t => (t || '').slice(0, 5);
const WD = '日一二三四五六';

// 計畫已經明顯偏離目前安排時，Today 主動說一聲，並給一個直接重排的入口。
// 一切正常就什麼都不顯示——這裡不該變成常駐的紅字。
// 視覺上用 accent（AI／建議），不是 Danger：這是「可以幫你處理」而不是「出事了」。
function AdjustBanner({ tasks, lists, apiPlans, reload, goWizardEdit }) {
  const plans = usePlans(tasks, lists, apiPlans);
  const needing = usePlansNeedingAdjustment(plans);
  const [dismissed, setDismissed] = useState([]);   // 只是這次畫面上收起來，不動任何資料
  const [picking, setPicking] = useState(false);
  const [replanKey, setReplanKey] = useState(null);

  const live = needing.filter(h => !dismissed.includes(h.planId));
  if (!live.length) return null;

  const health = live.find(h => h.planKey === replanKey);
  const plan = plans.find(p => p.key === replanKey);

  const cta = h => (
    <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
      <Button variant="primary" size="sm" onClick={() => setReplanKey(h.planKey)}>讓 AI 重新安排</Button>
      {/* 「稍後」只把提示收起來，不改計畫狀態、不寫任何旗標。
          問題還在的話，下次進 Today 還是會再出現。 */}
      <Button variant="tertiary" size="sm" onClick={() => setDismissed(d => [...d, h.planId])}>稍後</Button>
    </div>
  );

  return (
    <>
      <SurfaceCard tone="accent" style={{ marginBottom: 'var(--sp-4)' }}>
        {live.length === 1 ? (
          <>
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <Icon name="wizard" size={15} style={{ color: 'var(--accent)' }} />
              <b>計畫需要調整</b>
            </div>
            <div style={{ marginTop: 'var(--sp-2)', fontWeight: 600 }}>{live[0].name}</div>
            <div className="ui-meta">{live[0].reasons[0].message}。</div>
            {cta(live[0])}
          </>
        ) : (
          <>
            {/* 多個計畫時只給摘要，不要堆一排大方塊 */}
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <Icon name="wizard" size={15} style={{ color: 'var(--accent)' }} />
              <b>{live.length} 個計畫需要調整</b>
            </div>
            {live.slice(0, 3).map(h => (
              <div key={h.planId} className="ui-meta" style={{ marginTop: 2 }}>{h.name}</div>
            ))}
            {live.length > 3 && <div className="ui-meta">…還有 {live.length - 3} 個</div>}
            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <Button variant="primary" size="sm" onClick={() => setPicking(v => !v)}>查看</Button>
            </div>
            {picking && live.map(h => (
              <SurfaceCard key={h.planId} style={{ marginTop: 'var(--sp-3)' }}>
                <b>{h.name}</b>
                <div className="ui-meta">{h.reasons[0].message}</div>
                {cta(h)}
              </SurfaceCard>
            ))}
          </>
        )}
      </SurfaceCard>

      {plan && health && (
        <ReplanSheet plan={plan} health={health} raw={apiPlans.find(p => p.id === plan.planId)}
          lists={lists} reload={reload} onClose={() => setReplanKey(null)}
          onEditConditions={sec => { setReplanKey(null); goWizardEdit?.(plan.planId, sec); }} />
      )}
    </>
  );
}

// 接下來：時間在左、內容在右，中間一條很淡的線。
//   實心圓點＝已排定的讀書時段（用科目色）
//   空心圓點＝固定行程（中性色，不是「我的任務」）
// Lock 上線後會在右側加一個小鎖，不會因此換整張卡的顏色。
function NextUp({ tasks, lists, reload, goStudy }) {
  const [events, setEvents] = useState([]);
  useEffect(() => { api('/events').then(setEvents).catch(() => {}); }, []);

  // 排定時間的真相在 ScheduledBlock，不在 due_date。要讓使用者自己改時間，
  // 就得知道那一格到底是哪一個 block（一個任務可能被切成好幾塊）。
  const sched = useActiveSchedule();
  const [adjust, setAdjust] = useState(null);   // { block, task }
  const [starting, setStarting] = useState(null);
  const [startError, setStartError] = useState('');

  async function startScheduledStudy(row) {
    if (!row.block) return;
    setStarting(row.block.id); setStartError('');
    try {
      await api('/study-sessions', {
        method: 'POST',
        body: { task_id: row.task.id, scheduled_block_id: row.block.id, source: 'scheduled_block' },
      });
      goStudy?.();
    } catch (err) {
      setStartError(err.message || '無法開始讀書');
    } finally {
      setStarting(null);
    }
  }

  const td = today();
  const dow = new Date(td + 'T00:00:00Z').getUTCDay();
  const todayEv = events.filter(e => e.recurring === 'weekly'
    ? new Date(e.date + 'T00:00:00Z').getUTCDay() === dow && e.date <= td
    : e.date === td);

  const rows = [
    // 只放「已排定的讀書時段」（屬於某個計畫、而且有時間）與固定行程。
    // 一般的有時間任務留在下面的「今天的待辦」，同一件事不會出現兩次。
    ...tasks.filter(t => !t.deleted && !t.completed && t.due_date === td && t.due_time && t.plan_id != null)
      .map(t => {
        const l = lists.find(x => String(x.id) === String(t.list_id));
        // 這一格對應到的 block。due_date / due_time 就是鏡射自這個任務的第一個
        // block（persistence 的 mirror 取最早那一筆），所以時間軸上的這一列
        // 對到的一定是 blocksForTask 排序後的第一個。
        // 找不到就只是不能調整，畫面照樣顯示。
        const block = blocksForTask(sched.blocks, t.id)[0];
        // 標題＝實際要做的事（去掉「科目｜書名｜」前綴），科目退成下面一行的 meta。
        // 原本把科目名當標題、副標又整串重複一次，同一個詞會出現兩次。
        return { key: 't' + t.id, time: HM(t.due_time), kind: 'task', color: l?.color,
          title: shortTitle(t.title), sub: l?.name || '讀書', task: t, block };
      }),
    ...todayEv.map(e => ({ key: 'e' + e.id, time: HM(e.start_time), kind: 'event', title: e.title,
      sub: e.location ? `固定行程・${e.location}` : '固定行程' })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  if (!rows.length) return null;
  return (
    <>
    <section className="ui-section">
      <div className="ui-section-title">接下來</div>
      {rows.map(r => (
        <div key={r.key} className="tl-row">
          <div className="tl-time">{r.time}</div>
          <div className="tl-rail">
            <span className={'tl-dot' + (r.kind === 'event' ? ' tl-dot--event' : '')}
              style={r.kind === 'task' && r.color ? { background: r.color } : undefined} />
          </div>
          <div className="tl-body">
            <div className="tl-title">{r.title}</div>
            {r.sub && <div className="tl-sub">{r.sub}</div>}
          </div>
          {/* 固定行程不是 AI 排的，改它要去行事曆改；這裡只讓讀書時段可以調。 */}
          {r.block && (
            <div className="row" style={{ gap: 4 }}>
              <button className="tl-adjust" aria-label={`開始讀「${r.title}」`}
                disabled={starting === r.block.id} onClick={() => startScheduledStudy(r)}>
                {starting === r.block.id ? '啟動中…' : '開始'}
              </button>
              <button className="tl-adjust" aria-label={`調整「${r.title}」的時間`}
                onClick={() => setAdjust({ block: r.block, task: r.task })}>
                調整
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
    {startError && <div className="ui-meta" role="alert" style={{ color: 'var(--danger)', marginTop: 'var(--sp-2)' }}>{startError}</div>}
    {/* 放在 section 外面：時間軸靠 .tl-row:last-child 收掉最後一段軸線，
        在裡面多一個兄弟節點會讓最後一列多出一截線。 */}
    {adjust && (
      <AdjustBlockSheet block={adjust.block} task={adjust.task} lists={lists}
        versionId={sched.version?.id}
        reload={async () => { await reload?.(); await sched.reload(); }}
        onClose={() => setAdjust(null)} />
    )}
    </>
  );
}

// 今日狀態：一條進度條就夠，不需要一整張儀表板卡
function TodayProgress({ tasks, goStudy }) {
  const td = today();
  const mine = tasks.filter(t => !t.deleted && t.due_date === td);
  const done = mine.filter(t => t.completed).length;
  const left = mine.length - done;

  return (
    <div>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <span style={{ fontSize: 22, fontWeight: 650, letterSpacing: '-.02em' }}>
          {done} / {mine.length}
        </span>
        <span className="ui-meta">已完成</span>
      </div>
      <div style={{ marginTop: 'var(--sp-2)' }}>
        <ProgressBar value={done} max={mine.length} label={`今日進度：${mine.length} 項中已完成 ${done} 項`} />
      </div>
      <div className="ui-meta" style={{ marginTop: 'var(--sp-2)' }}>
        {mine.length ? <>還有 {left} <span>項待完成</span></> : '今天沒有排任務'}
      </div>
      {/* 中央導航的「讀書」才是全 App 的 Primary Action。這裡再放一顆一樣重的
          實心大鈕，整頁就會變成兩個主要動作互相搶——所以降成 secondary。 */}
      <Button variant="secondary" size="md" block style={{ marginTop: 'var(--sp-4)' }} onClick={goStudy}>
        <Icon name="pomo" size={18} />開始讀書
      </Button>
    </div>
  );
}

export default function TodayView({ tasks, lists, filters, habits, apiPlans = [], reload, goStudy, goVocab, goMemo, goWizardEdit }) {
  const d = new Date(today() + 'T00:00:00');
  const subtitle = `${d.getMonth() + 1} 月 ${d.getDate()} 日・星期${WD[d.getDay()]}`;
  return (
    <Tasks
      view={{ type: 'today' }}
      tasks={tasks} lists={lists} filters={filters} habits={habits} reload={reload}
      title="今天" subtitle={subtitle}
      goVocab={goVocab} goMemo={goMemo}
      listLabel="今天的待辦"
      topSlot={<>
        <TodayProgress tasks={tasks} goStudy={goStudy} />
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <AdjustBanner tasks={tasks} lists={lists} apiPlans={apiPlans} reload={reload} goWizardEdit={goWizardEdit} />
        </div>
        <NextUp tasks={tasks} lists={lists} reload={reload} goStudy={goStudy} />
      </>}
    />
  );
}
