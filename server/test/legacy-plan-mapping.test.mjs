// Legacy Task → Plan mapping 的判定邏輯（純函式，不開伺服器）。
//
// 這裡最需要被釘住的是**負向**行為：任何推論性的來源都不得取得 migration authority，
// 而 unresolved 永遠不是錯誤。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVENANCE_SOURCES, FORBIDDEN_PROVENANCE_SOURCES, API_ALLOWED_PROVENANCE_SOURCES,
  VERIFICATION_STATUSES, AUTHORITATIVE_STATUS,
  isAllowedProvenanceSource, hasMigrationAuthority, validateMappingInput, classifyPreview,
} from '../src/legacy/plan-mapping.js';

const mapping = (o = {}) => ({
  id: 1, legacy_task_id: 10, target_plan_id: 100,
  provenance_source: 'user_confirmed', provenance_ref: null,
  verification_status: 'verified', verified_at: '2026-01-01T00:00:00.000Z',
  verified_by: 1, verification_mechanism: 'api_user_confirmation', ...o,
});
const task = (o = {}) => ({ id: 10, title: '舊任務', plan_id: null, deleted: 0, ...o });

/* ---------- provenance 允許清單 ---------- */

test('只有四種 authoritative provenance 被接受', () => {
  assert.deepEqual(PROVENANCE_SOURCES,
    ['source_record', 'migration_manifest', 'user_confirmed', 'admin_verified']);
  for (const s of PROVENANCE_SOURCES) assert.equal(isAllowedProvenanceSource(s), true);
});

test('heuristic 來源一律不被接受', () => {
  for (const s of FORBIDDEN_PROVENANCE_SOURCES) {
    assert.equal(isAllowedProvenanceSource(s), false, s + ' 不該被接受');
    assert.equal(PROVENANCE_SOURCES.includes(s), false, s + ' 不該出現在允許清單裡');
  }
  // 契約明文點名的四種必須都在禁止清單裡
  for (const s of ['inferred', 'title_match', 'date_cluster', 'subject_match']) {
    assert.equal(FORBIDDEN_PROVENANCE_SOURCES.includes(s), true, s + ' 必須被明確禁止');
  }
});

test('API 只接受 user_confirmed：其餘三種不得由使用者自行宣稱', () => {
  assert.deepEqual(API_ALLOWED_PROVENANCE_SOURCES, ['user_confirmed']);
  for (const s of ['source_record', 'migration_manifest', 'admin_verified']) {
    const err = validateMappingInput({ legacy_task_id: 1, target_plan_id: 2, provenance_source: s },
      { allowedSources: API_ALLOWED_PROVENANCE_SOURCES });
    assert.match(err, /系統匯入流程/);
  }
});

/* ---------- migration authority ---------- */

test('只有 verified 具備 migration authority', () => {
  assert.deepEqual(VERIFICATION_STATUSES, ['unresolved', 'verified', 'rejected']);
  assert.equal(AUTHORITATIVE_STATUS, 'verified');
  assert.equal(hasMigrationAuthority(mapping()), true);
  assert.equal(hasMigrationAuthority(mapping({ verification_status: 'unresolved' })), false);
  assert.equal(hasMigrationAuthority(mapping({ verification_status: 'rejected' })), false);
  assert.equal(hasMigrationAuthority(undefined), false);
});

test('verified 但沒有 verified_at 不算數', () => {
  assert.equal(hasMigrationAuthority(mapping({ verified_at: null })), false);
});

test('verified 但 provenance 是 heuristic 不算數', () => {
  for (const s of FORBIDDEN_PROVENANCE_SOURCES) {
    assert.equal(hasMigrationAuthority(mapping({ provenance_source: s })), false, s);
  }
});

/* ---------- 輸入檢查 ---------- */

test('缺少任務、計畫或來源都被擋下', () => {
  assert.match(validateMappingInput({ target_plan_id: 2, provenance_source: 'user_confirmed' }), /舊任務/);
  assert.match(validateMappingInput({ legacy_task_id: 1, provenance_source: 'user_confirmed' }), /計畫/);
  assert.match(validateMappingInput({ legacy_task_id: 1, target_plan_id: 2 }), /依據來源/);
  assert.equal(validateMappingInput({ legacy_task_id: 1, target_plan_id: 2, provenance_source: 'user_confirmed' }), null);
});

test('heuristic 來源的錯誤訊息說得出為什麼', () => {
  const err = validateMappingInput({ legacy_task_id: 1, target_plan_id: 2, provenance_source: 'title_match' });
  assert.match(err, /標題|日期|科目/);
});

test('確認狀態不在清單裡就擋下', () => {
  assert.match(validateMappingInput({ legacy_task_id: 1, target_plan_id: 2, provenance_source: 'user_confirmed', verification_status: 'probably' }), /確認狀態/);
});

/* ---------- preview 分桶 ---------- */

test('四個桶子各自分開，unresolved 不是錯誤', () => {
  const out = classifyPreview({
    tasks: [task({ id: 10 }), task({ id: 11 }), task({ id: 12 }), task({ id: 13, plan_id: 100 })],
    plans: [{ id: 100 }],
    mappings: [
      mapping({ id: 1, legacy_task_id: 10 }),
      mapping({ id: 2, legacy_task_id: 11, verification_status: 'unresolved', verified_at: null }),
      mapping({ id: 3, legacy_task_id: 12, verification_status: 'rejected', verified_at: null }),
      mapping({ id: 4, legacy_task_id: 13 }),
    ],
  });
  assert.deepEqual(out.counts,
    { verified: 1, unresolved: 1, rejected: 1, already_migrated: 1, invalid_reference: 0, unmapped_legacy: 0 });
  assert.equal(out.verified[0].legacy_task_id, 10);
  assert.equal(out.already_migrated[0].current_plan_id, 100);
  assert.equal(out.migratable_task_count, 1);
});

test('migratable 只從 verified 導出，不另外估', () => {
  const out = classifyPreview({
    tasks: [task({ id: 10 }), task({ id: 11 })],
    plans: [{ id: 100 }],
    mappings: [
      mapping({ id: 1, legacy_task_id: 10, verification_status: 'unresolved', verified_at: null }),
      mapping({ id: 2, legacy_task_id: 11, verification_status: 'rejected', verified_at: null }),
    ],
  });
  assert.equal(out.migratable_task_count, 0);
  assert.equal(out.verified.length, 0);
});

test('沒有 mapping 的 legacy 任務進 unmapped，不是待處理也不是錯誤', () => {
  const out = classifyPreview({ tasks: [task({ id: 10 }), task({ id: 11 })], plans: [{ id: 100 }], mappings: [] });
  assert.equal(out.counts.unmapped_legacy, 2);
  assert.equal(out.counts.unresolved, 0);
  assert.equal(out.migratable_task_count, 0);
});

test('已刪除的 legacy 任務不算 unmapped', () => {
  const out = classifyPreview({ tasks: [task({ id: 10, deleted: 1 })], plans: [{ id: 100 }], mappings: [] });
  assert.equal(out.counts.unmapped_legacy, 0);
});

test('verified 但任務已刪除 → invalid_reference，不得留在 verified', () => {
  const out = classifyPreview({
    tasks: [task({ id: 10, deleted: 1 })], plans: [{ id: 100 }], mappings: [mapping()],
  });
  assert.equal(out.counts.verified, 0);
  assert.equal(out.invalid_reference[0].reason, 'task_deleted');
  assert.equal(out.migratable_task_count, 0);
});

test('verified 但任務不存在 → invalid_reference', () => {
  const out = classifyPreview({ tasks: [], plans: [{ id: 100 }], mappings: [mapping()] });
  assert.equal(out.invalid_reference[0].reason, 'task_not_found');
  assert.equal(out.counts.verified, 0);
});

test('verified 但目標計畫不是自己的 → invalid_reference', () => {
  // plans 只帶得進自己的計畫；別人的 plan id 在這裡就等於不存在
  const out = classifyPreview({ tasks: [task()], plans: [{ id: 999 }], mappings: [mapping()] });
  assert.equal(out.invalid_reference[0].reason, 'plan_not_found');
  assert.equal(out.counts.verified, 0);
  assert.equal(out.migratable_task_count, 0);
});

test('already_migrated 優先於 rejected：任務已歸屬就不再是待判定', () => {
  const out = classifyPreview({
    tasks: [task({ plan_id: 100 })], plans: [{ id: 100 }],
    mappings: [mapping({ verification_status: 'rejected', verified_at: null })],
  });
  assert.equal(out.counts.already_migrated, 1);
  assert.equal(out.counts.rejected, 0);
});
