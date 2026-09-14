// 跨 App 日期語意（Phase 1 §M）：三種概念必須清楚分開，過了原定進度日不得叫「逾期」。
import { describe, it, expect } from 'vitest';
import {
  zhDate, zhDateShort, relativeDay, deadlineLabel, dailyProgressLabel, scheduledBlockLabel,
} from '../tt/dateSemantics';

const TODAY = '2026-09-14';

describe('中文日期格式', () => {
  it('9/14 與 9 月 14 日', () => {
    expect(zhDateShort('2026-09-14')).toBe('9/14');
    expect(zhDate('2026-09-14')).toBe('9 月 14 日');
    expect(zhDate('2026-09-14', { weekday: true })).toMatch(/9 月 14 日（週.）/);
  });
  it('相對日：今天／明天／昨天', () => {
    expect(relativeDay('2026-09-14', TODAY)).toBe('今天');
    expect(relativeDay('2026-09-15', TODAY)).toBe('明天');
    expect(relativeDay('2026-09-13', TODAY)).toBe('昨天');
    expect(relativeDay('2026-09-20', TODAY)).toBe('9/20');
  });
  it('月底／年底邊界：明天／昨天跨月跨年正確', () => {
    expect(relativeDay('2026-09-01', '2026-08-31')).toBe('明天');   // 跨月
    expect(relativeDay('2026-08-31', '2026-09-01')).toBe('昨天');
    expect(relativeDay('2027-01-01', '2026-12-31')).toBe('明天');   // 跨年
    expect(relativeDay('2026-12-31', '2027-01-01')).toBe('昨天');
    expect(zhDateShort('2026-12-31')).toBe('12/31');
    expect(zhDate('2026-08-31')).toBe('8 月 31 日');
  });
});

describe('Deadline 語意（截止／逾期）', () => {
  it('未到＝截止，已過＝逾期，不含假的 23:59', () => {
    expect(deadlineLabel('2026-09-20', null, TODAY)).toMatchObject({ tone: 'normal' });
    expect(deadlineLabel('2026-09-20', null, TODAY).text).toContain('截止');
    expect(deadlineLabel('2026-09-20', null, TODAY).text).not.toContain('23:59');
    expect(deadlineLabel('2026-09-14', null, TODAY).tone).toBe('today');
    const od = deadlineLabel('2026-09-10', '18:00', TODAY);
    expect(od.tone).toBe('overdue');
    expect(od.text).toContain('逾期');
    expect(od.text).toContain('18:00');
  });
});

describe('Daily progress 語意（今日進度／原定／未完成進度）', () => {
  it('過了原定進度日是「未完成進度」，不是「逾期」', () => {
    expect(dailyProgressLabel('2026-09-14', TODAY).text).toBe('今日進度');
    expect(dailyProgressLabel('2026-09-16', TODAY).text).toContain('原定');
    const missed = dailyProgressLabel('2026-09-10', TODAY);
    expect(missed.tone).toBe('missed');
    expect(missed.text).toContain('未完成進度');
    expect(missed.text).not.toContain('逾期');
  });
});

describe('ScheduledBlock 語意（時段／錯過安排）', () => {
  it('顯示時段；過了是「錯過安排」，不是「逾期」', () => {
    expect(scheduledBlockLabel('2026-09-14', '19:00', '20:00', TODAY).text).toBe('今天 19:00–20:00');
    const missed = scheduledBlockLabel('2026-09-12', '19:00', '20:00', TODAY);
    expect(missed.tone).toBe('missed');
    expect(missed.text).toContain('錯過安排');
    expect(missed.text).not.toContain('逾期');
  });
});
