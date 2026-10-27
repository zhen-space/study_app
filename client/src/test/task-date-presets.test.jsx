import { describe, expect, it } from 'vitest';
import { nextWeek, thisWeekend } from '../tt/helpers';

describe('任務日期快捷預設', () => {
  it('本週末取本週六，週末當天則不跳到下週', () => {
    expect(thisWeekend('2026-10-27')).toBe('2026-10-31');
    expect(thisWeekend('2026-10-31')).toBe('2026-10-31');
    expect(thisWeekend('2026-11-01')).toBe('2026-11-01');
  });

  it('下週取下一個週一', () => {
    expect(nextWeek('2026-10-27')).toBe('2026-11-02');
    expect(nextWeek('2026-11-01')).toBe('2026-11-02');
    expect(nextWeek('2026-11-02')).toBe('2026-11-09');
  });
});
