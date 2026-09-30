import { createHash } from 'node:crypto';

export const normalizeSubjectName = value => String(value ?? '')
  .normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-Hant-TW');

const REFS = [['tasks', 'list_id'], ['toc_items', 'list_id'], ['plans', 'primary_list_id'],
  ['material_books', 'subject_list_id'], ['plan_progress_segments', 'subject_list_id'], ['plan_manual_scope', 'subject_list_id']];
const marks = ids => ids.map(() => '?').join(',');

export async function matchingSubjects(db, userId, name) {
  const normalized = normalizeSubjectName(name);
  if (!normalized) return [];
  return (await db.all('SELECT id,name,color,order_index FROM lists WHERE user_id=? ORDER BY order_index,id', [userId]))
    .filter(row => normalizeSubjectName(row.name) === normalized);
}

export async function subjectMergeImpact(db, userId, targetId, sourceIds) {
  const target = Number(targetId);
  const sources = [...new Set((sourceIds || []).map(Number).filter(Number.isInteger))].filter(id => id !== target);
  if (!Number.isInteger(target) || !sources.length) throw Object.assign(new Error('請選擇要合併的科目'), { status: 400 });
  const all = [target, ...sources];
  const rows = await db.all(`SELECT id,name,color,order_index FROM lists WHERE user_id=? AND id IN (${marks(all)}) ORDER BY id`, [userId, ...all]);
  if (rows.length !== sources.length + 1) throw Object.assign(new Error('找不到科目，或科目不屬於你'), { status: 404 });
  if (new Set(rows.map(row => normalizeSubjectName(row.name))).size !== 1) throw Object.assign(new Error('只允許合併正規化後同名的科目'), { status: 409 });
  const counts = {}, state = { lists: rows };
  for (const [table, column] of REFS) {
    const linked = await db.all(`SELECT id,${column} AS subject_id FROM ${table} WHERE user_id=? AND ${column} IN (${marks(sources)}) ORDER BY id`, [userId, ...sources]);
    counts[table] = linked.length; state[table] = linked;
  }
  const shares = await db.all(`SELECT id,list_id,owner_id,member_id FROM list_shares WHERE owner_id=? AND list_id IN (${marks(all)}) ORDER BY id`, [userId, ...all]);
  const exam = await db.all(`SELECT id,plan_id,subject_list_id,exam_date,order_index FROM plan_exam_subjects WHERE user_id=? AND subject_list_id IN (${marks(all)}) ORDER BY id`, [userId, ...all]);
  state.list_shares = shares; state.plan_exam_subjects = exam;
  counts.list_shares = shares.filter(r => sources.includes(Number(r.list_id))).length;
  counts.plan_exam_subjects = exam.filter(r => sources.includes(Number(r.subject_list_id))).length;
  const examPlans = new Set(exam.filter(r => exam.some(o => Number(o.plan_id) === Number(r.plan_id) && Number(o.id) !== Number(r.id))).map(r => Number(r.plan_id)));
  const targetMembers = new Set(shares.filter(r => Number(r.list_id) === target).map(r => Number(r.member_id)));
  const fingerprint = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  return { target: rows.find(r => Number(r.id) === target), sources: rows.filter(r => sources.includes(Number(r.id))), counts,
    conflicts: { exam_plans_deduplicated: examPlans.size, duplicate_shares_deduplicated: shares.filter(r => sources.includes(Number(r.list_id)) && targetMembers.has(Number(r.member_id))).length }, fingerprint };
}

export async function mergeSubjects(tx, userId, targetId, sourceIds, expectedFingerprint) {
  const impact = await subjectMergeImpact(tx, userId, targetId, sourceIds);
  if (!expectedFingerprint || expectedFingerprint !== impact.fingerprint) throw Object.assign(new Error('科目內容在預覽後有變動，請重新確認影響範圍'), { status: 409, code: 'merge_preview_stale', impact });
  const target = Number(targetId), sources = impact.sources.map(r => Number(r.id));
  for (const [table, column] of REFS) await tx.run(`UPDATE ${table} SET ${column}=? WHERE user_id=? AND ${column} IN (${marks(sources)})`, [target, userId, ...sources]);
  const all = [target, ...sources];
  const exams = await tx.all(`SELECT id,plan_id,subject_list_id,exam_date,order_index FROM plan_exam_subjects WHERE user_id=? AND subject_list_id IN (${marks(all)}) ORDER BY id`, [userId, ...all]);
  for (const planId of [...new Set(exams.map(r => Number(r.plan_id)))]) {
    const group = exams.filter(r => Number(r.plan_id) === planId), keeper = group.find(r => Number(r.subject_list_id) === target) || group[0];
    const dates = group.map(r => r.exam_date).filter(Boolean).sort(), order = Math.min(...group.map(r => Number(r.order_index) || 0));
    for (const row of group) if (Number(row.id) !== Number(keeper.id)) await tx.run('DELETE FROM plan_exam_subjects WHERE id=? AND user_id=?', [row.id, userId]);
    await tx.run('UPDATE plan_exam_subjects SET subject_list_id=?,exam_date=?,order_index=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?', [target, dates[0] || null, order, keeper.id, userId]);
  }
  const shares = await tx.all(`SELECT id,list_id,member_id FROM list_shares WHERE owner_id=? AND list_id IN (${marks(all)}) ORDER BY CASE WHEN list_id=? THEN 0 ELSE 1 END,id`, [userId, ...all, target]);
  const members = new Set();
  for (const share of shares) {
    const member = Number(share.member_id);
    if (!members.has(member)) { members.add(member); if (Number(share.list_id) !== target) await tx.run('UPDATE list_shares SET list_id=? WHERE id=? AND owner_id=?', [target, share.id, userId]); }
    else await tx.run('DELETE FROM list_shares WHERE id=? AND owner_id=?', [share.id, userId]);
  }
  await tx.run(`DELETE FROM lists WHERE user_id=? AND id IN (${marks(sources)})`, [userId, ...sources]);
  return impact;
}
