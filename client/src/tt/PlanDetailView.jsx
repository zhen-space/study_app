import { useState } from 'react';
import { api } from '../api';
import Icon from './Icons';
import { today } from './helpers';
import { usePlans, bookOf, shortTitle, md, byLesson } from './plans';

// 單一計畫的內容。
//
// 分組主軸是「科目」而不是「書」——一個 Plan 可以跨科，書只是標題裡的一段，
// 不是 Plan 的身分。同一科底下有多本書時才再用書名分小段。
//
// 正式 Plan（有 planId）才有改名／改期限／完成／封存；
// 舊資料沒有 plan id，這些操作對它沒有意義，一律不顯示。

const STATUS_LABEL = { draft: '草稿', active: '進行中', completed: '已完成', archived: '已封存' };

// 「調整計畫」的入口：先問要調整哪一段，再深連結到排程精靈對應的位置。
// 一次只調一件事，不用每次都從頭走一遍精靈。
const ADJUST = [
  ['content', '學習內容', '加、減或換讀的範圍'],
  ['deadline', '完成期限', '改開始日、目標日與分配方式'],
  ['time', '可用時間', '看目前的行程與作息（要改請到行事曆）'],
  ['cond', '排程條件', '題型、順序、每天幾項'],
  ['all', '全部設定', '從頭走一次精靈'],
];

export default function PlanDetailView({ planKey, tasks, lists, apiPlans = [], reload, onBack, goWizard, adjustPlan }) {
  const plan = usePlans(tasks, lists, apiPlans).find(p => p.key === planKey);
  const [showDone, setShowDone] = useState(false);
  const [manage, setManage] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // 新增任務：空白計畫建立後總得有辦法往裡面加第一件事，
  // 不然使用者會停在一個什麼都不能做的頁面
  const [adding, setAdding] = useState(false);
  const [nt, setNt] = useState({ title: '', list_id: '', deadline_date: '' });

  if (!plan) {
    return (
      <div className="main">
        <div className="main-head"><h2>計畫</h2></div>
        <div className="main-body">
          <button className="btn sm ghost" onClick={onBack}>← 回計畫列表</button>
          <div className="muted" style={{ marginTop: 20 }}>找不到這個計畫（可能已經全部刪除了）</div>
        </div>
      </div>
    );
  }

  const isReal = !plan.isLegacy && plan.planId != null;
  // 只有正式且還在進行的計畫能調整；封存的先恢復再說
  const showAdjust = isReal && plan.status !== 'archived' && !!adjustPlan;
  const raw = apiPlans.find(p => p.id === plan.planId);   // 正式 Plan 的原始欄位（日期等）

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
  const patch = body => run(() => api(`/plans/${plan.planId}`, { method: 'PATCH', body }));
  const archive = () => run(() => api(`/plans/${plan.planId}/archive`, { method: 'POST', body: {} }));
  const restore = () => run(() => api(`/plans/${plan.planId}/restore`, { method: 'POST', body: {} }));
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
      },
    });
    setNt({ title: '', list_id: nt.list_id, deadline_date: '' });   // 科目留著，連續加同一科比較順
  });

  const complete = () => run(async () => {
    // 後端會先回未解決的任務讓使用者確認，force 才真的完成
    const r = await api(`/plans/${plan.planId}/complete`, { method: 'POST', body: {} });
    if (r.needs_confirm) {
      const ok = window.confirm(`還有 ${r.unresolved.length} 項沒有完成，仍要把整個計畫標記為完成嗎？`);
      if (!ok) return;
      await api(`/plans/${plan.planId}/complete`, { method: 'POST', body: { force: true } });
    }
  });

  // 依科目分組；同一科有多本書時再分小段。
  // 尚未安排的已經有自己的區塊，這裡要排除掉，否則同一筆會出現兩次。
  const unplacedIds = new Set(plan.unplaced.map(t => t.id));
  const placed = plan.items.filter(t => !unplacedIds.has(t.id));
  const groups = plan.subjects.length
    ? plan.subjects.map(s => ({
        subject: s,
        items: placed.filter(t => String(t.list_id ?? '') === String(s.id ?? '')),
      }))
    : [{ subject: null, items: placed }];

  const visible = list => list.filter(t => showDone || !t.completed).sort((a, b) => byLesson(a.title, b.title));

  const Row = t => {
    const late = !t.completed && t.due_date && t.due_date < today();
    return (
      <div key={t.id} className="trow" style={{ cursor: 'default' }}>
        <input type="checkbox" checked={!!t.completed} onChange={() => toggle(t)} />
        <span className="title" style={t.completed ? { textDecoration: 'line-through', color: 'var(--muted)' } : {}}>
          {shortTitle(t.title)}
        </span>
        {t.due_date
          ? <span className="muted" style={late ? { color: 'var(--red)' } : {}}>{md(t.due_date)}</span>
          : <span className="chip">尚未安排</span>}
      </div>
    );
  };

  return (
    <div className="main">
      <div className="main-head">
        <h2>{plan.name}</h2>
        {plan.isLegacy && <span className="chip" title="還沒轉成正式計畫的舊資料">舊資料</span>}
        {isReal && plan.status !== 'active' && <span className="chip">{STATUS_LABEL[plan.status] || plan.status}</span>}
        <span className="muted">{plan.done}／{plan.total}</span>
      </div>
      <div className="main-body">
        <div className="row">
          <button className="btn sm ghost" onClick={onBack}>← 計畫列表</button>
          {showAdjust && (
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setAdjust(true)}>
              <Icon name="wizard" size={14} /> 調整計畫
            </button>
          )}
          {isReal && (
            <button className="btn sm ghost" style={showAdjust ? undefined : { marginLeft: 'auto' }} onClick={() => setManage(v => !v)}>
              <Icon name="pencil" size={14} /> {manage ? '完成' : '管理'}
            </button>
          )}
          {!isReal && (
            <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={goWizard}>
              <Icon name="wizard" size={14} /> 重新安排
            </button>
          )}
        </div>

        <div className="row" style={{ marginTop: 8, fontSize: 13, flexWrap: 'wrap' }}>
          {plan.start && <span className="muted">{md(plan.start)}–{md(plan.end)}</span>}
          {plan.overdue > 0 && <span style={{ color: 'var(--red)' }}>逾期 {plan.overdue} 項</span>}
          {plan.subjects.length > 1 && <span className="muted">{plan.subjects.length} 個科目</span>}
        </div>

        {plan.isLegacy && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            這是還沒轉成正式計畫的舊資料，只能查看與打勾，不能改名、改期限或封存
          </div>
        )}

        {/* 管理操作：全部直接打 Phase 2A 的 /plans API */}
        {isReal && manage && (
          <div className="tile" style={{ marginTop: 10, padding: '12px 14px', background: 'var(--fill)' }}>
            <div className="muted" style={{ fontSize: 12 }}>計畫名稱</div>
            <input defaultValue={plan.name} style={{ width: '100%', marginTop: 2 }}
              aria-label="計畫名稱"
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== plan.name) patch({ name: v }); }}
              onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}>開始</span>
              <input type="date" aria-label="開始日期" value={raw?.start_date || ''}
                onChange={e => patch({ start_date: e.target.value || null })} />
              <span className="muted" style={{ fontSize: 12 }}>目標</span>
              <input type="date" aria-label="目標日期" value={raw?.target_date || ''}
                onChange={e => patch({ target_date: e.target.value || null })} />
            </div>
            <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              {plan.status !== 'completed' && plan.status !== 'archived' && (
                <button className="btn sm" disabled={busy} onClick={complete}>標記完成</button>
              )}
              {plan.status !== 'archived'
                ? <button className="btn sm ghost" disabled={busy} onClick={archive}>封存</button>
                : <button className="btn sm" disabled={busy} onClick={restore}>恢復</button>}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>封存不會刪掉任何任務</div>
            {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
          </div>
        )}

        {/* 新增任務：正式 Plan 才有。legacy 沒有 plan id，加了也掛不上去 */}
        {isReal && plan.status !== 'archived' && (
          <div style={{ marginTop: 12 }}>
            {!adding
              ? <button className="btn ghost" style={{ width: '100%' }} onClick={() => setAdding(true)}>
                  <Icon name="plus" size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />新增任務
                </button>
              : (
                <div className="tile" style={{ padding: '12px 14px', background: 'var(--fill)' }}>
                  <div className="row">
                    <b>新增任務到這個計畫</b>
                    <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => { setAdding(false); setErr(''); }}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  <input aria-label="任務名稱" placeholder="要做什麼？" value={nt.title} style={{ width: '100%', marginTop: 8 }}
                    onChange={e => setNt({ ...nt, title: e.target.value })}
                    onKeyDown={e => e.key === 'Enter' && addTask()} />
                  <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                    <span className="muted" style={{ fontSize: 12 }}>科目</span>
                    <select aria-label="科目" value={nt.list_id} onChange={e => setNt({ ...nt, list_id: e.target.value })}>
                      <option value="">未分科目</option>
                      {lists.filter(l => !l.shared_in).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                    <span className="muted" style={{ fontSize: 12 }}>截止日</span>
                    <input type="date" aria-label="截止日" value={nt.deadline_date}
                      onChange={e => setNt({ ...nt, deadline_date: e.target.value })} />
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="muted" style={{ fontSize: 12 }}>加進來的任務會先放在「尚未安排」</span>
                    <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={busy || !nt.title.trim()} onClick={addTask}>
                      {busy ? '新增中…' : '新增'}
                    </button>
                  </div>
                  {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
                </div>
              )}
          </div>
        )}

        {/* 尚未安排：在計畫裡 ≠ 已經排到日期 */}
        {plan.unplaced.length > 0 && (
          <div className="tgroup" style={{ marginTop: 12 }}>
            <div className="glabel">尚未安排 <span className="muted" style={{ fontWeight: 400 }}>{plan.unplaced.length} 項</span></div>
            <div className="muted" style={{ fontSize: 12, padding: '0 0 4px' }}>這些還沒排進行事曆</div>
            {plan.unplaced.sort((a, b) => byLesson(a.title, b.title)).map(Row)}
          </div>
        )}

        {plan.total === 0 && (
          <div className="muted" style={{ marginTop: 24, textAlign: 'center' }}>
            這個計畫還沒有任務{isReal && plan.status !== 'archived' ? '——用上面的「新增任務」加第一件事吧' : ''}
          </div>
        )}

        {/* 主分組＝科目。同一科有多本書時，才再用書名分小段 */}
        {groups.map(({ subject, items }) => {
          const list = visible(items);
          if (!list.length) return null;
          const undone = items.filter(t => !t.completed).length;
          const books = [...new Set(list.map(t => bookOf(t.title)))];
          return (
            <div key={String(subject?.id ?? 'none')} className="tgroup" style={{ marginTop: 12 }}>
              <div className="glabel">
                {subject && <Icon name={subject.icon} size={14} style={{ color: subject.color, verticalAlign: '-2px', marginRight: 4 }} />}
                {subject?.name || '未分科目'}
                <span className="muted" style={{ fontWeight: 400 }}> 剩 {undone} 項</span>
              </div>
              {books.length > 1
                ? books.map(b => (
                    <div key={b}>
                      <div className="muted" style={{ fontSize: 12, padding: '6px 0 2px' }}>{b}</div>
                      {list.filter(t => bookOf(t.title) === b).map(Row)}
                    </div>
                  ))
                : list.map(Row)}
            </div>
          );
        })}

        {/* 調整計畫：先問要調哪一段，再跳到排程精靈對應的位置 */}
        {adjust && (
          <div className="cal-modal-back" onClick={() => setAdjust(false)}>
            <div className="ev-sheet tile" style={{ padding: '14px 16px' }} onClick={e => e.stopPropagation()}>
              <div className="row">
                <b>要調整什麼？</b>
                <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setAdjust(false)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                調整的是「{plan.name}」，不會建立新的計畫
              </div>
              {ADJUST.map(([sec, label, hint]) => (
                <button key={sec} className="btn ghost" style={{ width: '100%', marginTop: 8, textAlign: 'left' }}
                  onClick={() => { setAdjust(false); adjustPlan(plan.planId, sec); }}>
                  <b>{label}</b>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{hint}</span>
                </button>
              ))}
              {/* 鎖定還沒有地方存（要等 2C 的 Task Lock），先顯示成之後才有的功能 */}
              <button className="btn ghost" style={{ width: '100%', marginTop: 8, textAlign: 'left' }} disabled title="還沒開放">
                <b>鎖定內容</b>
                <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>把某幾項釘在原本的日子（之後才有）</span>
              </button>
            </div>
          </div>
        )}

        {plan.done > 0 && (
          <button className="btn sm ghost" style={{ marginTop: 12 }} onClick={() => setShowDone(s => !s)}>
            {showDone ? '隱藏已完成' : `顯示已完成（${plan.done}）`}
          </button>
        )}
      </div>
    </div>
  );
}
