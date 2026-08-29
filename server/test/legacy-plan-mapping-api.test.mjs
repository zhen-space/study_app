// Legacy Task → Plan mapping 的 API 契約。
//
// 重點在 user boundary、重複 mapping、無效參照、確認狀態的流轉，
// 以及一條貫穿全部的硬規則：**這個 domain 永遠不改 tasks.plan_id，
// 也不碰 ScheduleVersion / ScheduledBlock / StudySession。**
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers.mjs';

const MAP = '/legacy-migration/mappings';
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture() {
  const s = await startServer();
  const post = async (p, body, H = s.H) =>
    fetch(s.base + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const patch = async (p, body, H = s.H) =>
    fetch(s.base + p, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
  const get = async (p, H = s.H) => fetch(s.base + p, { headers: H });

  const mkTask = async (title, H = s.H, extra = {}) =>
    (await post('/tasks', { title, ...extra }, H)).json();
  const mkPlan = async (name, H = s.H) => (await post('/plans', { name }, H)).json();
  return { ...s, post, patch, get, mkTask, mkPlan };
}

// 建立一筆已確認的 mapping，回傳所有相關 id
async function verifiedMapping(f) {
  const taskRow = await f.mkTask('舊任務｜第一章');
  const plan = await f.mkPlan('正式計畫');
  const r = await f.post(MAP, {
    legacy_task_id: taskRow.id, target_plan_id: plan.id,
    provenance_source: 'user_confirmed', provenance_ref: 'manifest#12',
    verification_status: 'verified',
  });
  return { task: taskRow, plan, mapping: await r.json() };
}

/* ---------- 建立 ---------- */

test('建立 mapping：預設是 unresolved，不會自動變成已確認', async () => {
  const f = await fixture();
  try {
    const taskRow = await f.mkTask('舊任務');
    const plan = await f.mkPlan('計畫');
    const r = await f.post(MAP, {
      legacy_task_id: taskRow.id, target_plan_id: plan.id, provenance_source: 'user_confirmed',
    });
    assert.equal(r.status, 200);
    const m = await r.json();
    assert.equal(m.verification_status, 'unresolved');
    assert.equal(m.verified_at, null);
    assert.equal(m.verified_by, null);
  } finally { f.stop(); }
});

test('建立並同時確認：記下誰、用什麼機制、什麼時候', async () => {
  const f = await fixture();
  try {
    const { mapping } = await verifiedMapping(f);
    assert.equal(mapping.verification_status, 'verified');
    assert.equal(mapping.verification_mechanism, 'api_user_confirmation');
    assert.ok(mapping.verified_by);
    assert.ok(Date.parse(mapping.verified_at));
    assert.equal(mapping.provenance_ref, 'manifest#12');
  } finally { f.stop(); }
});

test('heuristic provenance 一律 400', async () => {
  const f = await fixture();
  try {
    const taskRow = await f.mkTask('舊任務');
    const plan = await f.mkPlan('計畫');
    for (const source of ['inferred', 'title_match', 'date_cluster', 'subject_match']) {
      const r = await f.post(MAP, { legacy_task_id: taskRow.id, target_plan_id: plan.id, provenance_source: source });
      assert.equal(r.status, 400, source + ' 應該被擋下');
    }
  } finally { f.stop(); }
});

test('使用者不能自封 admin_verified / source_record / migration_manifest', async () => {
  const f = await fixture();
  try {
    const taskRow = await f.mkTask('舊任務');
    const plan = await f.mkPlan('計畫');
    for (const source of ['admin_verified', 'source_record', 'migration_manifest']) {
      const r = await f.post(MAP, { legacy_task_id: taskRow.id, target_plan_id: plan.id, provenance_source: source });
      assert.equal(r.status, 400, source + ' 不該由使用者自行宣稱');
    }
    // 而且不能靠這個繞過去拿到 authority
    const list = await (await f.get(MAP)).json();
    assert.equal(list.mappings.length, 0);
  } finally { f.stop(); }
});

test('同一個舊任務只能有一筆 mapping', async () => {
  const f = await fixture();
  try {
    const { task, plan } = await verifiedMapping(f);
    const other = await f.mkPlan('另一個計畫');
    const r = await f.post(MAP, {
      legacy_task_id: task.id, target_plan_id: other.id, provenance_source: 'user_confirmed',
    });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'mapping_exists');
  } finally { f.stop(); }
});

test('已經屬於某個計畫的任務不需要 mapping', async () => {
  const f = await fixture();
  try {
    const plan = await f.mkPlan('計畫');
    const taskRow = await f.mkTask('計畫內任務', f.H, { plan_id: plan.id });
    const r = await f.post(MAP, {
      legacy_task_id: taskRow.id, target_plan_id: plan.id, provenance_source: 'user_confirmed',
    });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'already_migrated');
  } finally { f.stop(); }
});

test('已刪除的任務不能建立 mapping', async () => {
  const f = await fixture();
  try {
    const taskRow = await f.mkTask('舊任務');
    const plan = await f.mkPlan('計畫');
    await fetch(`${f.base}/tasks/${taskRow.id}`, { method: 'DELETE', headers: f.H });
    const r = await f.post(MAP, {
      legacy_task_id: taskRow.id, target_plan_id: plan.id, provenance_source: 'user_confirmed',
    });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'task_deleted');
  } finally { f.stop(); }
});

/* ---------- user boundary ---------- */

test('不能把別人的舊任務對應到自己的計畫', async () => {
  const f = await fixture();
  try {
    const u2 = await f.secondUser();
    const theirTask = await f.mkTask('別人的舊任務', u2.H);
    const myPlan = await f.mkPlan('我的計畫');
    const r = await f.post(MAP, {
      legacy_task_id: theirTask.id, target_plan_id: myPlan.id, provenance_source: 'user_confirmed',
    });
    assert.equal(r.status, 404);
  } finally { f.stop(); }
});

test('不能把自己的舊任務對應到別人的計畫', async () => {
  const f = await fixture();
  try {
    const u2 = await f.secondUser();
    const theirPlan = await f.mkPlan('別人的計畫', u2.H);
    const myTask = await f.mkTask('我的舊任務');
    const r = await f.post(MAP, {
      legacy_task_id: myTask.id, target_plan_id: theirPlan.id, provenance_source: 'user_confirmed',
    });
    assert.equal(r.status, 404);
  } finally { f.stop(); }
});

test('別人的 mapping 讀不到也改不動', async () => {
  const f = await fixture();
  try {
    const { mapping } = await verifiedMapping(f);
    const u2 = await f.secondUser();
    assert.equal((await f.get(`${MAP}/${mapping.id}`, u2.H)).status, 404);
    assert.equal((await f.patch(`${MAP}/${mapping.id}`, { verification_status: 'rejected' }, u2.H)).status, 404);
    // 而且原本那筆沒有被改到
    const still = await (await f.get(`${MAP}/${mapping.id}`)).json();
    assert.equal(still.verification_status, 'verified');
    // 對方的清單裡也看不到
    const theirList = await (await f.get(MAP, u2.H)).json();
    assert.equal(theirList.mappings.length, 0);
  } finally { f.stop(); }
});

test('preview 只看得到自己的 mapping', async () => {
  const f = await fixture();
  try {
    await verifiedMapping(f);
    const u2 = await f.secondUser();
    const theirs = await (await f.get('/legacy-migration/migration-preview', u2.H)).json();
    // 不能只看 verified／unresolved 是 0：別人的 mapping 只要被讀進來，
    // 就算最後被分到 invalid_reference，mapping_id／target_plan_id／provenance_ref
    // 也已經外洩了。所以每一個桶子都必須是空的。
    for (const bucket of ['verified', 'unresolved', 'rejected', 'already_migrated', 'invalid_reference']) {
      assert.equal(theirs[bucket].length, 0, `${bucket} 不該出現別人的資料`);
      assert.equal(theirs.counts[bucket], 0, `${bucket} 計數不該算到別人的資料`);
    }
    assert.equal(theirs.counts.unmapped_legacy, 0);
    assert.equal(theirs.migratable_task_count, 0);
  } finally { f.stop(); }
});

/* ---------- 確認狀態流轉 ---------- */

test('可以確認、否決、退回未確認；只有確認會留下 verified_at', async () => {
  const f = await fixture();
  try {
    const taskRow = await f.mkTask('舊任務');
    const plan = await f.mkPlan('計畫');
    const m = await (await f.post(MAP, {
      legacy_task_id: taskRow.id, target_plan_id: plan.id, provenance_source: 'user_confirmed',
    })).json();

    const verified = await (await f.patch(`${MAP}/${m.id}`, { verification_status: 'verified' })).json();
    assert.ok(verified.verified_at);

    const rejected = await (await f.patch(`${MAP}/${m.id}`, { verification_status: 'rejected' })).json();
    assert.equal(rejected.verification_status, 'rejected');
    assert.equal(rejected.verified_at, null, '否決不該留著先前的確認時間');
    assert.equal(rejected.verified_by, null);

    const back = await (await f.patch(`${MAP}/${m.id}`, { verification_status: 'unresolved' })).json();
    assert.equal(back.verified_at, null);
  } finally { f.stop(); }
});

test('換了目標計畫，先前的確認自動失效', async () => {
  const f = await fixture();
  try {
    const { mapping } = await verifiedMapping(f);
    const other = await f.mkPlan('改成這個計畫');
    const out = await (await f.patch(`${MAP}/${mapping.id}`, { target_plan_id: other.id })).json();
    assert.equal(out.target_plan_id, other.id);
    assert.equal(out.verification_status, 'unresolved');
    assert.equal(out.verified_at, null);
  } finally { f.stop(); }
});

test('換計畫並同時重新確認：兩件事都生效', async () => {
  const f = await fixture();
  try {
    const { mapping } = await verifiedMapping(f);
    const other = await f.mkPlan('改成這個計畫');
    const out = await (await f.patch(`${MAP}/${mapping.id}`,
      { target_plan_id: other.id, verification_status: 'verified' })).json();
    assert.equal(out.target_plan_id, other.id);
    assert.equal(out.verification_status, 'verified');
    assert.ok(out.verified_at);
  } finally { f.stop(); }
});

test('不能換到別人的計畫', async () => {
  const f = await fixture();
  try {
    const { mapping } = await verifiedMapping(f);
    const u2 = await f.secondUser();
    const theirPlan = await f.mkPlan('別人的計畫', u2.H);
    assert.equal((await f.patch(`${MAP}/${mapping.id}`, { target_plan_id: theirPlan.id })).status, 404);
  } finally { f.stop(); }
});

test('任務刪掉之後不能再蓋確認章', async () => {
  const f = await fixture();
  try {
    const taskRow = await f.mkTask('舊任務');
    const plan = await f.mkPlan('計畫');
    const m = await (await f.post(MAP, {
      legacy_task_id: taskRow.id, target_plan_id: plan.id, provenance_source: 'user_confirmed',
    })).json();
    await fetch(`${f.base}/tasks/${taskRow.id}`, { method: 'DELETE', headers: f.H });
    const r = await f.patch(`${MAP}/${m.id}`, { verification_status: 'verified' });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'task_unavailable');
    // 但退回未確認／否決仍然可以做——那是紀錄整理，不是宣稱權威
    assert.equal((await f.patch(`${MAP}/${m.id}`, { verification_status: 'rejected' })).status, 200);
  } finally { f.stop(); }
});

test('不合法的確認狀態被擋下', async () => {
  const f = await fixture();
  try {
    const { mapping } = await verifiedMapping(f);
    assert.equal((await f.patch(`${MAP}/${mapping.id}`, { verification_status: 'maybe' })).status, 400);
    assert.equal((await f.get(`${MAP}?verification_status=maybe`)).status, 400);
  } finally { f.stop(); }
});

test('provenance_source 不可被 PATCH 改掉', async () => {
  const f = await fixture();
  try {
    const { mapping } = await verifiedMapping(f);
    const out = await (await f.patch(`${MAP}/${mapping.id}`, { provenance_source: 'admin_verified' })).json();
    assert.equal(out.provenance_source, 'user_confirmed');
  } finally { f.stop(); }
});

test('legacy_task_id / user_id 不可被 PATCH 改掉', async () => {
  const f = await fixture();
  try {
    const { mapping } = await verifiedMapping(f);
    const another = await f.mkTask('另一個舊任務');
    const out = await (await f.patch(`${MAP}/${mapping.id}`,
      { legacy_task_id: another.id, user_id: 99999 })).json();
    assert.equal(out.legacy_task_id, mapping.legacy_task_id);
    assert.equal(out.user_id, mapping.user_id);
  } finally { f.stop(); }
});

/* ---------- preview ---------- */

test('preview 分開回報四個結果，並且不寫任何東西', async () => {
  const f = await fixture();
  try {
    const plan = await f.mkPlan('計畫');
    const t1 = await f.mkTask('已確認');
    const t2 = await f.mkTask('未確認');
    const t3 = await f.mkTask('已否決');
    await f.mkTask('完全沒有對應');
    const mk = (id, status) => f.post(MAP, {
      legacy_task_id: id, target_plan_id: plan.id,
      provenance_source: 'user_confirmed', verification_status: status,
    });
    await mk(t1.id, 'verified');
    await mk(t2.id, 'unresolved');
    await mk(t3.id, 'rejected');

    const out = await (await f.get('/legacy-migration/migration-preview')).json();
    assert.equal(out.mode, 'preview_only');
    assert.equal(out.writes_performed, 0);
    assert.equal(out.apply_available, false);
    assert.equal(out.counts.verified, 1);
    assert.equal(out.counts.unresolved, 1);
    assert.equal(out.counts.rejected, 1);
    assert.equal(out.counts.unmapped_legacy, 1);
    assert.equal(out.migratable_task_count, 1);

    // preview 之後任務仍然全部是 legacy——沒有任何一筆被偷偷掛上 plan_id
    const tasks = await (await f.get('/tasks')).json();
    for (const t of tasks) assert.equal(t.plan_id ?? null, null, t.title + ' 不該被寫入 plan_id');
  } finally { f.stop(); }
});

test('unresolved 不是錯誤：preview 照樣回 200 並如實分類', async () => {
  const f = await fixture();
  try {
    const plan = await f.mkPlan('計畫');
    const t = await f.mkTask('舊任務');
    await f.post(MAP, { legacy_task_id: t.id, target_plan_id: plan.id, provenance_source: 'user_confirmed' });
    const r = await f.get('/legacy-migration/migration-preview');
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.counts.unresolved, 1);
    assert.equal(out.error, undefined);
  } finally { f.stop(); }
});

test('mapping 建立之後任務被刪除：preview 歸入 invalid_reference 而不是 verified', async () => {
  const f = await fixture();
  try {
    const { task } = await verifiedMapping(f);
    await fetch(`${f.base}/tasks/${task.id}`, { method: 'DELETE', headers: f.H });
    const out = await (await f.get('/legacy-migration/migration-preview')).json();
    assert.equal(out.counts.verified, 0);
    assert.equal(out.counts.invalid_reference, 1);
    assert.equal(out.invalid_reference[0].reason, 'task_deleted');
    assert.equal(out.migratable_task_count, 0);
  } finally { f.stop(); }
});

test('沒有任何 apply endpoint', async () => {
  const f = await fixture();
  try {
    const { mapping } = await verifiedMapping(f);
    for (const p of ['/legacy-migration/apply', '/legacy-migration/migrate',
      `${MAP}/${mapping.id}/apply`, '/legacy-migration/mappings/apply']) {
      const r = await f.post(p, {});
      assert.ok(r.status === 404, `${p} 不該存在（收到 ${r.status}）`);
    }
  } finally { f.stop(); }
});

/* ---------- 靜態契約 ---------- */

test('這個 router 完全不寫 tasks / 排程歷史', () => {
  const src = readFileSync(path.join(serverDir, 'src/routes/legacy-migration.js'), 'utf8');
  for (const forbidden of [
    /UPDATE\s+tasks/i, /INSERT\s+INTO\s+tasks/i, /DELETE\s+FROM\s+tasks/i,
    /schedule_versions/i, /scheduled_blocks/i, /study_sessions/i,
    /UPDATE\s+plans/i,
    // 指派 tasks.plan_id。前面的 [^_] 是為了不誤判 mapping 自己的 target_plan_id
    /(^|[^_])plan_id\s*=\s*\?/im,
  ]) {
    assert.equal(forbidden.test(src), false, `不該出現：${forbidden}`);
  }
});

test('判定模組不碰資料庫', () => {
  const src = readFileSync(path.join(serverDir, 'src/legacy/plan-mapping.js'), 'utf8');
  assert.equal(/db\/init/.test(src), false);
  assert.equal(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(src), false);
});

test('mapping 資料表存在且 (user_id, legacy_task_id) 唯一', async () => {
  const f = await fixture();
  const { createClient } = await import('@libsql/client');
  // 這個 client 直接開著測試伺服器的 SQLite 檔。一定要在 f.stop() 刪掉暫存目錄
  // 之前關掉，否則 node --test 會因為還有開著的 handle 而不結束。
  const c = createClient({ url: 'file:' + f.dbFile });
  try {
    assert.ok((await f.tableNames()).includes('legacy_task_plan_mappings'));
    const idx = await c.execute("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='legacy_task_plan_mappings'");
    const unique = idx.rows.map(r => String(r[1] ?? '')).filter(s => /UNIQUE/i.test(s));
    assert.ok(unique.some(s => /user_id/.test(s) && /legacy_task_id/.test(s)),
      '缺少 (user_id, legacy_task_id) 的唯一索引');

    // 直接寫入第二筆，讓 schema 自己擋——不靠應用層自律
    const { task, plan } = await verifiedMapping(f);
    await assert.rejects(() => c.execute({
      sql: `INSERT INTO legacy_task_plan_mappings
        (user_id,legacy_task_id,target_plan_id,provenance_source,verification_status,created_at,updated_at)
        VALUES ((SELECT user_id FROM legacy_task_plan_mappings WHERE legacy_task_id=?),?,?,?,?,?,?)`,
      args: [task.id, task.id, plan.id, 'user_confirmed', 'verified', 'x', 'x'],
    }));
  } finally { try { c.close(); } catch {} f.stop(); }
});
