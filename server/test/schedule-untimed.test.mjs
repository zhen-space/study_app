// 段考模式二「每天要做什麼（不指定時段）」＝ timed:false：
// 排出的 block 只有日期，**不得虛構 start_time／end_time**。模式三 timed:true 才有時段。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, sec, day } from './helpers.mjs';

let S;
before(async () => { S = await startServer(); });
after(() => S?.stop());

describe('段考模式二／三：時段語意', () => {
  test('daily（timed:false）blocks 沒有 start_time／end_time', async () => {
    const r = await S.plan([sec(1, '數學｜單元1｜節1｜範例+例題'), sec(1, '數學｜單元1｜節2｜範例+例題')],
      { timed: false, startDate: day(0), endDate: day(6) });
    assert.ok(r.blocks.length > 0);
    for (const b of r.blocks) {
      assert.ok(!b.start_time, '不得有 start_time');
      assert.ok(!b.end_time, '不得有 end_time');
      assert.match(b.date, /^\d{4}-\d\d-\d\d$/);
    }
  });

  test('timed（timed:true）blocks 才有 start_time／end_time', async () => {
    const r = await S.plan([sec(1, '數學｜單元1｜節1｜範例+例題')],
      { timed: true, startDate: day(0), endDate: day(6) });
    assert.ok(r.blocks.length > 0);
    assert.ok(r.blocks.every(b => b.start_time && b.end_time), 'timed 模式應有時段');
  });
});
