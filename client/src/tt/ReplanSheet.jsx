import { useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { today, addDays } from './helpers';
import { shortTitle } from './plans';
import { applyWizardSchedule } from './wizardApply';
import { buildSchedulePreviewRequest, planScheduleConditions, CONDITION_LABEL } from './schedulePreview';
import { BottomSheet, Button, SurfaceCard } from './ui';

// AI 重排流程：確認 → 預覽 → 套用。
//
// Today 與計畫明細兩個入口共用這一支，不寫兩份。
//
// 邊界（很重要）：
//   ・重排範圍一律以正式 plan_id 為準，不用「讀書計劃」標籤當範圍
//   ・只動這個計畫「尚未完成」的任務；已完成／已刪除／別的計畫一律不碰
//   ・排程用既有的 /schedule/preview，不另寫第二套演算法
//   ・按下「套用新版安排」之前不寫入任何東西
//   ・寫入走 wizardApply 這一層（2C 之後整層換掉，這裡不用改）

const WD = '日一二三四五六';

export default function ReplanSheet({ plan, health, raw, lists = [], reload, onClose, onEditConditions }) {
  const [stage, setStage] = useState('confirm');   // confirm | loading | preview | saving
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');

  // 重排的對象：這個計畫底下還沒完成的任務。完成的連讀都不讀進來。
  const pending = plan.items.filter(t => !t.completed && !t.deleted);

  // 重排＝用「原本的排法」重算剩下的內容。條件不齊就不排，
  // 絕對不自己補一組預設值——那等於偷偷換掉學生設定的排法。
  const { conditions, minutes, missing, complete } = planScheduleConditions(plan.planId, pending);

  async function run() {
    setStage('loading'); setErr('');
    const start = today();
    // 結束日：計畫自己的目標日優先。沒設或已經過去，就給一段合理的區間，
    // 不去猜「應該延到什麼時候」——那要使用者自己在條件裡決定。
    const target = raw?.target_date;
    const end = target && target >= start ? target : addDays(start, Math.max(6, pending.length - 1));
    try {
      const pv = await api('/schedule/preview', {
        method: 'POST',
        body: buildSchedulePreviewRequest({
          items: pending.map(t => ({
            subject_id: t.list_id,
            title: t.title,
            // 只排進度時排程器不看 minutes，就不要生一個假數字出來
            ...(conditions.timed ? { minutes: minutes[t.id] } : {}),
            start,
            // 每一項自己的硬性截止日還是硬的（deadline_date ≠ 排定日期）
            end: t.deadline_date && t.deadline_date >= start ? t.deadline_date : end,
          })),
          startDate: start, endDate: end, conditions,
        }),
      });
      pv.blocks = [...pv.blocks].sort((a, b) => a.date.localeCompare(b.date));
      setPreview(pv);
      setStage('preview');
    } catch (e) { setErr(e.message); setStage('confirm'); }
  }

  async function apply() {
    setStage('saving'); setErr('');
    try {
      await applyWizardSchedule({
        mode: 'edit',
        planId: plan.planId,
        blocks: preview.blocks,
        existingTasks: plan.items,
        // 重排只是把東西搬到新的日子：排不進去的留在原地，不刪
        removeUnscheduled: false,
        // 也不動使用者自己設的起訖日與名稱
        updatePlanDates: false,
      });
    } catch (e) { setErr(e.message); setStage('preview'); return; }
    await reload();
    onClose();
  }

  const Head = ({ title }) => (
    <div className="row">
      <b>{title}</b>
      <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="關閉" onClick={onClose}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );

  return (
    <BottomSheet onClose={onClose}>
      <>
        {stage === 'confirm' || stage === 'loading' ? (
          <>
            <Head title={`重新安排「${plan.name}」`} />
            <div className="side-sec" style={{ marginTop: 10 }}>原因</div>
            {(health?.reasons || []).map(r => (
              <div key={r.type} className="muted" style={{ fontSize: 13 }}>・{r.message}</div>
            ))}
            <div className="side-sec" style={{ marginTop: 12 }}>AI 將重新計算</div>
            <div className="muted" style={{ fontSize: 13 }}>・還沒完成、而且屬於這個計畫的 {pending.length} 項</div>
            <div className="side-sec" style={{ marginTop: 12 }}>不會修改</div>
            <div className="muted" style={{ fontSize: 13 }}>・已經完成的項目</div>
            <div className="muted" style={{ fontSize: 13 }}>・其他計畫</div>
            <div className="muted" style={{ fontSize: 13 }}>・過去的完成紀錄</div>

            {/* 找不到這個計畫當初的排法時，不會自己補一組預設值硬排下去，
                而是請使用者確認一次；確認過的條件之後就會被沿用。 */}
            {!complete && (
              <SurfaceCard tone="accent" style={{ marginTop: 'var(--sp-3)' }}>
                <b>需要先確認安排條件</b>
                <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                  找不到這個計畫當初的排法，AI 不會自己替你決定：
                </div>
                {missing.map(k => (
                  <div key={k} className="ui-meta">・{CONDITION_LABEL[k] || k}</div>
                ))}
              </SurfaceCard>
            )}

            {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}
            <div className="row" style={{ marginTop: 14 }}>
              {complete ? (
                <>
                  <Button variant="secondary" disabled={stage === 'loading'} onClick={() => onEditConditions('deadline')}>修改條件</Button>
                  <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={stage === 'loading' || !pending.length} onClick={run}>
                    {stage === 'loading' ? '重新安排中…' : '重新安排'}
                  </Button>
                </>
              ) : (
                <Button variant="primary" style={{ marginLeft: 'auto' }} onClick={() => onEditConditions('deadline')}>確認安排條件</Button>
              )}
            </div>
            {stage === 'loading' && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>AI 正在算新的安排，先別關掉…</div>
            )}
          </>
        ) : (
          <>
            <Head title="新的安排已準備好" />
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{plan.name}</div>

            {/* 排不下：照後端已經算得出來的原因說明，不自己編缺口數字 */}
            {preview.unplaced && (
              <SurfaceCard tone="warning" style={{ marginTop: 'var(--sp-3)' }}>
                <b style={{ color: 'var(--warning)' }}>目前無法完整安排</b>
                <div className="ui-meta" style={{ margin: '4px 0 8px' }}>{preview.message}</div>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <Button size="sm" onClick={() => onEditConditions('deadline')}>延後期限</Button>
                  <Button size="sm" onClick={() => onEditConditions('time')}>調整可用時間</Button>
                  <Button size="sm" onClick={() => onEditConditions('content')}>減少學習內容</Button>
                </div>
              </SurfaceCard>
            )}
            {(preview.check?.tight || []).map((t, i) => (
              <div key={'t' + i} style={{ marginTop: 8, fontSize: 13, color: 'var(--orange, #C46A22)' }}>
                ⚠️ {lists.find(l => l.id === t.subject_id)?.name || '有一科'}的日期只有 {t.haveDays} 天，
                最擠的一天要排 {t.maxPerDay} 項，大約需要 {t.needDays} 天。
              </div>
            ))}

            <div style={{ marginTop: 12 }}>
              {Object.entries(preview.blocks.reduce((a, b) => { (a[b.date] = a[b.date] || []).push(b); return a; }, {}))
                .map(([d, list]) => (
                  <div key={d} style={{ marginBottom: 8 }}>
                    <b style={{ fontSize: 14 }}>{d}（週{WD[new Date(d + 'T00:00:00').getDay()]}）</b>
                    {list.map((b, i) => {
                      const l = lists.find(x => String(x.id) === String(b.subject_id));
                      return (
                        <div key={i} className="row" style={{ marginTop: 3, fontSize: 13 }}>
                          {b.start_time && <span className="muted">{b.start_time}–{b.end_time}</span>}
                          <span style={{ color: l?.color }}>■</span>
                          <span>{shortTitle(b.title)}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
            </div>

            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              按下「套用新版安排」之前，原本的安排不會有任何改變
            </div>
            {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
            <div className="row" style={{ marginTop: 12 }}>
              <Button variant="secondary" disabled={stage === 'saving'} onClick={() => onEditConditions('deadline')}>返回修改條件</Button>
              <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={stage === 'saving'} onClick={apply}>
                {stage === 'saving' ? '套用中…' : '套用新版安排'}
              </Button>
            </div>
          </>
        )}
      </>
    </BottomSheet>
  );
}
