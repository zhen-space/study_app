import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { startServer } from './helpers.mjs';

test('習慣多欄位更新是單一寫入，不會只留下前半套設定', async () => {
  const { base, H, stop, dbFile } = await startServer();
  const db = createClient({ url: 'file:' + dbFile });
  try {
    const created = await fetch(base + '/habits', {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: '原名稱', icon: '⭐', color: '#16a34a' }),
    }).then(r => r.json());

    // 若欄位被拆成多次 UPDATE，第一個 name 會先成功，第二個 color 才失敗。
    await db.execute(`
      CREATE TRIGGER reject_habit_color
      BEFORE UPDATE ON habits
      WHEN NEW.color = '#ffffff'
      BEGIN
        SELECT RAISE(ABORT, '測試注入失敗');
      END
    `);

    const response = await fetch(`${base}/habits/${created.id}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ name: '不該留下', color: '#ffffff' }),
    });
    assert.equal(response.status, 500);

    const row = (await db.execute({
      sql: 'SELECT name,color FROM habits WHERE id=?', args: [created.id],
    })).rows[0];
    assert.equal(row.name, '原名稱');
    assert.equal(row.color, '#16a34a');
  } finally {
    db.close();
    stop();
  }
});

test('習慣多欄位更新成功時會一起套用', async () => {
  const { base, H, stop } = await startServer();
  try {
    const created = await fetch(base + '/habits', {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: '原名稱' }),
    }).then(r => r.json());
    const response = await fetch(`${base}/habits/${created.id}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ name: '新名稱', icon: '📖', category: '學習' }),
    });
    assert.equal(response.status, 200);

    const habits = await fetch(base + '/habits', { headers: H }).then(r => r.json());
    const habit = habits.find(h => Number(h.id) === Number(created.id));
    assert.equal(habit.name, '新名稱');
    assert.equal(habit.icon, '📖');
    assert.equal(habit.category, '學習');
  } finally { stop(); }
});
