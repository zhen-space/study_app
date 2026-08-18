import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { today } from './helpers';

// 「這個計畫需要調整嗎？」的判斷。
//
// 這一版刻意只用「現有資料就能確定」的訊號，不做任何推測：
// 前端不應該自己發明排程語意，缺口幾小時、還差幾天這種數字要等
// 2C 的 feasibility contract 實作完，由後端當正式判斷來源
// （見 docs/phase2c-schedule-persistence.md）。
//
// reason model 設計成可擴充：之後後端提供新的原因，只要往 reasons 陣列
// 多推一個 { type, count, message }，Today 與計畫明細都不用改。
//
// 注意：「昨天有一項沒做完就整份重排」不是永久的產品規則，
// 只是目前唯一能可靠判斷的第一個 trigger。

export const REASON_TEXT = {
  overdue: n => `有 ${n} 項已經過了預定的日子還沒完成`,
  past_target: n => `有 ${n} 項排在目標日之後`,
};

// 回傳 null＝這個計畫根本不進這套流程（舊資料、已完成、已封存）
export function planHealth(plan, raw) {
  // 舊資料沒有 plan id，重排無從指定範圍，不進新版流程
  if (!plan || plan.isLegacy || plan.planId == null) return null;
  // 已完成／已封存的計畫不提示重排
  if (plan.status !== 'active' && plan.status !== 'draft') return null;

  const td = today();
  const pending = plan.items.filter(t => !t.completed && !t.deleted);
  const reasons = [];

  // A. 過期未完成：目前唯一在任何情況下都可靠的訊號
  const overdue = pending.filter(t => t.due_date && t.due_date < td);
  if (overdue.length) reasons.push({ type: 'overdue', count: overdue.length, message: REASON_TEXT.overdue(overdue.length) });

  // B. 已經排到目標日之後：只有在計畫真的有設目標日時才判斷，
  //    沒設就不猜（deadline_date 與 due_date 是兩回事，不能互相推導）
  const target = raw?.target_date;
  if (target) {
    const late = pending.filter(t => t.due_date && t.due_date > target);
    if (late.length) reasons.push({ type: 'past_target', count: late.length, message: REASON_TEXT.past_target(late.length) });
  }

  return {
    planId: plan.planId,
    planKey: plan.key,
    name: plan.name,
    pending: pending.length,
    // 沒有剩下的未完成項目就沒有東西可以重排
    needsAdjustment: reasons.length > 0 && pending.length > 0,
    reasons,
  };
}

// 需要調整的計畫（依未完成數量多的排前面）
export function usePlansNeedingAdjustment(plans) {
  const ids = plans.filter(p => !p.isLegacy && p.planId != null && ['active', 'draft'].includes(p.status)).map(p => p.planId);
  const key = ids.join(',');
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let alive = true;
    Promise.all(ids.map(id => api(`/plans/${id}/health`).catch(() => null)))
      .then(result => { if (alive) setRows(result.filter(Boolean)); });
    return () => { alive = false; };
  }, [key]);
  return useMemo(() => {
    const byId = new Map(rows.map(r => [Number(r.plan_id), r]));
    return plans.map(plan => {
      const health = byId.get(Number(plan.planId));
      if (!health || health.status === 'healthy' || !health.pending) return null;
      return { ...health, planId: plan.planId, planKey: plan.key, name: plan.name, needsAdjustment: true };
    }).filter(Boolean).sort((a, b) => b.pending - a.pending);
  }, [plans, rows]);
}

// 單一計畫明細也讀同一支正式 health API，不能在 Today 與 Detail 各自猜一次。
export function usePlanScheduleHealth(plan) {
  const id = plan?.isLegacy || plan?.planId == null ? null : plan.planId;
  const [health, setHealth] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!id) { setHealth(null); return undefined; }
    api(`/plans/${id}/health`).then(x => { if (alive) setHealth(x); }).catch(() => { if (alive) setHealth(null); });
    return () => { alive = false; };
  }, [id]);
  if (!health || health.status === 'healthy' || !health.pending) return null;
  return { ...health, planId: id, planKey: plan?.key, name: plan?.name, needsAdjustment: true };
}
