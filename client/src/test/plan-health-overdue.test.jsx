// 離線 fallback 的 planHealth 與計畫明細同一套逾期定義（含排程歷史已過、due_date 為 NULL 的任務）。
import { describe, expect, it } from 'vitest';
import { planHealth } from '../tt/planHealth';
import { today, addDays } from '../tt/helpers';

describe('planHealth fallback', () => {
  it('過去排過但 due_date 已因排程歷史變成 NULL 的任務算已逾期；從沒排過的不算', () => {
    const TD = today();
    const plan = { planId: 1, key: 'plan:1', name: '段考', status: 'active', items: [
      { id: 1, completed: 0, due_date: null, last_scheduled_date: addDays(TD, -2) },
      { id: 2, completed: 0, due_date: null },
      { id: 3, completed: 0, due_date: null, last_scheduled_date: TD },
      { id: 4, completed: 1, due_date: null, last_scheduled_date: addDays(TD, -2) },
    ] };
    const h = planHealth(plan, {});
    expect(h.reasons.find(r => r.type === 'overdue').count).toBe(1);
  });
});
