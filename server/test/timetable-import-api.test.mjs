// 課表匯入 v2 的 API 閘門。
//
// 重點是負向行為：低信心不得直接寫入、辨識結果不得先落地再讓人改、
// 匯入只走既有的 fixed_events，不新增匯入結果表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers.mjs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIRM = '/import/timetable/confirm';

async function fixture() {
  const s = await startServer();
  const post = (p, b, H = s.H) => fetch(s.base + p, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const get = (p, H = s.H) => fetch(s.base + p, { headers: H });
  return { ...s, post, get };
}

const item = (o = {}) => ({ day_of_week: 1, title: '數學', start_time: '08:10', end_time: '09:00', ...o });

test('確認匯入：寫進既有的 fixed_events，不建新表', async () => {
  const f = await fixture();
  try {
    const r = await f.post(CONFIRM, { items: [item(), item({ day_of_week: 2, title: '英文' })] });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).imported, 2);

    const events = await (await f.get('/events')).json();
    assert.equal(events.length, 2);
    assert.equal(events[0].recurring, 'weekly');

    // 沒有任何新的匯入結果表
    const names = await f.tableNames();
    for (const n of names) {
      assert.equal(/^(timetable_|import_|ocr_)/.test(n), false, `不該存在 ${n}`);
    }
  } finally { f.stop(); }
});

test('低信心且未確認 → 409，不得寫入', async () => {
  const f = await fixture();
  try {
    const r = await f.post(CONFIRM, { items: [item()], requires_mapping_confirmation: true });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'mapping_confirmation_required');
    assert.equal((await (await f.get('/events')).json()).length, 0, '被擋下時不得留下任何資料');
  } finally { f.stop(); }
});

test('低信心但已明確確認 → 允許寫入', async () => {
  const f = await fixture();
  try {
    const r = await f.post(CONFIRM,
      { items: [item()], requires_mapping_confirmation: true, mapping_confirmed: true });
    assert.equal(r.status, 200);
    assert.equal((await (await f.get('/events')).json()).length, 1);
  } finally { f.stop(); }
});

test('欄位不完整一律擋下，且不寫入任何一筆', async () => {
  const f = await fixture();
  try {
    for (const bad of [
      { items: [] },
      { items: [item({ day_of_week: 9 })] },
      { items: [item({ title: '  ' })] },
      { items: [item({ start_time: '8:10' })] },
      { items: [item({ end_time: null })] },
      { items: [item({ start_time: '10:00', end_time: '09:00' })] },
    ]) {
      const r = await f.post(CONFIRM, bad);
      assert.ok(r.status === 400, JSON.stringify(bad));
    }
    assert.equal((await (await f.get('/events')).json()).length, 0);
  } finally { f.stop(); }
});

test('未登入不能匯入', async () => {
  const f = await fixture();
  try {
    const r = await fetch(f.base + CONFIRM, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [item()] }),
    });
    assert.equal(r.status, 401);
  } finally { f.stop(); }
});

test('沒有 AI 金鑰時，辨識端點明確回 503，不會假裝成功', async () => {
  const f = await fixture();
  try {
    const r = await f.post('/import/timetable', { filename: 'a.png', mime: 'image/png', data: 'x' });
    assert.equal(r.status, 503);
  } finally { f.stop(); }
});

test('結構層不碰資料庫、不呼叫 AI', () => {
  const src = readFileSync(path.join(serverDir, 'src/timetable/structure.js'), 'utf8');
  assert.equal(/db\/init|Anthropic/.test(src), false);
  assert.equal(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(src), false);
});

test('辨識端點的 prompt 不讓模型決定星期幾', () => {
  const src = readFileSync(path.join(serverDir, 'src/routes/import.js'), 'utf8');
  const i = src.indexOf("router.post('/timetable'");
  const block = src.slice(i, src.indexOf("router.post('/timetable/confirm'"));
  assert.ok(block.includes('不要判斷哪一欄是星期幾'), 'prompt 必須明講模型不判斷星期');
  assert.ok(block.includes('buildPreview'), '星期對應必須交給結構層');
});
