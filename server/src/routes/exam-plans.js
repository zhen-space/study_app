import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { buildExamScope, createExamPlanAtomic, ExamPlanError } from '../schedule/persistence.js';
import { runPreview } from './schedule.js';
import { getPlanSelection } from '../material/service.js';
import { todayTW } from '../util/date.js';
import { signExamPlanPreview, verifyExamPlanPreview } from '../schedule/exam-plan-token.js';

// 段考計畫（Exam Plan）——不是第二套 Plan，就是既有 Plan 加兩個 additive 層：
//   ・plan_exam_subjects：每一科自己的考試日（plan.target_date＝整個段考最後一天）。
//     各科內容的有效完成上限＝該科考試日；排程時寫進該科 Task 的 deadline_date，
//     由既有排程器強制。
//   ・plan_manual_scope：老師指定、教材庫沒有的「範圍」＝first-class scope，
//     不是 Task、不是 material selection、也不是完成。
//
// 建立是「使用者在三步精靈按下確認」時才發生的**單一原子動作**（見
// createExamPlanAtomic）：Plan＋各科考試日＋教材選取＋手動 scope＋（daily／timed）
// Task＋ScheduleVersion＋blocks 全部在同一筆交易裡同生共死，任一步失敗整筆 rollback、
// 對外零可見殘留。**排程由伺服器自己用 CURRENT scope 算**（runPreview 唯讀），
// client 不送 schedule／blocks；deadline 一律以 CURRENT 該科考試日覆寫，不信 client。

const router = Router();
router.use(requireAuth);

const LEVELS = ['progress', 'daily', 'timed'];

async function authoritativePreview(userId, b) {
  if (!String(b.name || '').trim()) throw new ExamPlanError('請輸入段考名稱', 'NAME_REQUIRED');
  if (b.level != null && !LEVELS.includes(b.level)) throw new ExamPlanError('安排方式不正確', 'INVALID_LEVEL');
  const level = LEVELS.includes(b.level) ? b.level : 'progress';
  const endDate = b.end_date;
  const startDate = b.start_date || null;
  const scope = await buildExamScope(q, userId, { endDate, startDate, level,
    subjects: b.subjects || [], materialIds: b.material_scope || [], manual: b.manual_scope || [] });
  const state = await q.get('SELECT active_version_id FROM user_schedule_state WHERE user_id=?', [userId]);
  let blocks = [], check = null, unplaced_tasks = [];
  if (level === 'daily' || level === 'timed') {
    if (!scope.scopeItems.length) throw new ExamPlanError('這個安排方式需要至少一項可排入的範圍', 'EXAM_SCOPE_EMPTY', 422);
    const scheduleStart = startDate || todayTW();
    const items = scope.scopeItems.map(si => ({ subject_id: si.subjectId, title: si.title,
      minutes: si.minutes, spread: false, start: scheduleStart, end: si.deadline }));
    const pv = await runPreview(userId, { items, timed: level === 'timed', startDate: scheduleStart, endDate, pace: 'even' });
    if (pv.status !== 200) throw new ExamPlanError(pv.body?.error || '無法排出可行的安排', pv.body?.code || 'EXAM_SCHEDULE_INFEASIBLE', 422);
    unplaced_tasks = pv.body.unplaced_tasks || [];
    if (pv.body.unplaced || unplaced_tasks.length) throw new ExamPlanError(pv.body.message || '有內容排不進去，請調整日期或範圍', 'EXAM_SCHEDULE_GAP', 422);
    blocks = (pv.body.blocks || []).filter(x => !x._pinned && x.subject_id != null);
    check = pv.body.check || null;
  }
  const snapshot = { user_id: Number(userId), level, start_date: startDate, end_date: endDate,
    subjects: scope.orderedSubjects, material_ids: scope.materialIds, manual_scope: scope.manualEntries,
    scope_sig: scope.sig, base_version_id: state?.active_version_id ?? null, blocks };
  const canonicalScope = scope.scopeItems.map(x => ({ kind: x.kind, subject_list_id: x.subjectId, title: x.title,
    estimated_minutes: x.minutes, content_item_id: x.contentItemId, deadline: x.deadline }));
  if (level === 'progress') for (const m of scope.manualEntries) canonicalScope.push({ kind: 'manual',
    subject_list_id: m.subject_list_id, title: m.label, estimated_minutes: m.estimated_minutes,
    content_item_id: null, deadline: scope.examBySubject.get(Number(m.subject_list_id)) ?? endDate });
  return { level, start_date: startDate, end_date: endDate, subjects: scope.orderedSubjects,
    scope: canonicalScope,
    blocks, check, unplaced_tasks, base_version_id: snapshot.base_version_id,
    preview_token: signExamPlanPreview(snapshot) };
}

router.post('/exam-plans/preview', async (req, res) => {
  try { res.json(await authoritativePreview(req.userId, req.body || {})); }
  catch (e) { res.status(e.status || 400).json({ error: e.message, code: e.code || 'EXAM_PREVIEW_ERROR' }); }
});

// 段考範圍投影（Plan Detail 首屏用）：各科考試日 + 教材範圍（科目→教材→章）+ 手動 scope。
async function examProjection(userId, planId) {
  const plan = await q.get("SELECT * FROM plans WHERE id=? AND user_id=? AND status<>'deleted'", [planId, userId]);
  if (!plan) return null;
  const lists = await q.all('SELECT id,name FROM lists WHERE user_id=?', [userId]);
  const nameOf = id => (id != null ? (lists.find(l => Number(l.id) === Number(id))?.name || null) : null);
  const subjRows = await q.all(
    'SELECT * FROM plan_exam_subjects WHERE user_id=? AND plan_id=? ORDER BY order_index,id', [userId, planId]);
  const subjects = subjRows.map(s => ({
    subject_list_id: s.subject_list_id,
    subject_name: nameOf(s.subject_list_id),
    exam_date: s.exam_date || plan.target_date || null,
  }));
  const examBySubject = new Map(subjects.map(s => [Number(s.subject_list_id), s.exam_date]));
  // 教材選取（已帶 book_title/chapter_title 路徑）
  const material = (await getPlanSelection(userId, planId)).filter(r => r.selected).map(r => ({
    ...r, exam_date: examBySubject.get(Number(r.subject_list_id)) ?? plan.target_date ?? null,
  }));
  const manual = (await q.all(
    'SELECT * FROM plan_manual_scope WHERE user_id=? AND plan_id=? AND removed_at IS NULL ORDER BY order_index,id', [userId, planId]))
    .map(m => ({
      id: m.id, subject_list_id: m.subject_list_id, subject_name: nameOf(m.subject_list_id),
      label: m.label, estimated_minutes: m.estimated_minutes ?? null, task_id: m.task_id ?? null,
      exam_date: examBySubject.get(Number(m.subject_list_id)) ?? plan.target_date ?? null,
    }));
  return {
    plan: { id: plan.id, name: plan.name, target_date: plan.target_date, start_date: plan.start_date, status: plan.status },
    subjects, material, manual_scope: manual,
  };
}

// GET 投影：Plan Detail 首屏。
router.get('/plans/:id/exam', async (req, res) => {
  const p = await examProjection(req.userId, req.params.id);
  if (!p) return res.status(404).json({ error: '找不到計畫' });
  res.json(p);
});

// POST：原子建立段考計畫（server-authoritative，單一交易）。
router.post('/exam-plans', async (req, res) => {
  const b = req.body || {};
  const userId = req.userId;
  if (!String(b.name || '').trim()) return res.status(400).json({ error: '請輸入段考名稱' });
  if (b.level != null && !LEVELS.includes(b.level)) return res.status(400).json({ error: '安排方式不正確' });
  const level = LEVELS.includes(b.level) ? b.level : 'progress';
  const endDate = b.end_date;
  const startDate = b.start_date || null;

  const signed = verifyExamPlanPreview(b.preview_token);
  if (!signed || Number(signed.user_id) !== Number(userId)) return res.status(409).json({ error: '請先重新預覽段考安排', code: 'EXAM_PREVIEW_STALE' });
  const computedBlocks = signed.blocks || [];

  // ③ 單一交易建立（任一步失敗 → 整筆 rollback，零可見殘留）。
  let planId;
  try {
    ({ planId } = await createExamPlanAtomic(userId, {
      name: b.name, description: b.description || '', startDate, endDate, level,
      subjects: b.subjects || [], materialIds: b.material_scope || [], manual: b.manual_scope || [],
      computedBlocks, scopeSig: signed.scope_sig, previewToken: b.preview_token,
    }));
  } catch (e) {
    if (e instanceof ExamPlanError || e.status) {
      return res.status(e.status || 400).json({ error: `已取消建立：${e.message}`, code: e.code || null });
    }
    throw e;
  }

  res.status(201).json(await examProjection(userId, planId));
});

export default router;
