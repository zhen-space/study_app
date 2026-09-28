import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { buildExamScope, createExamPlanAtomic, ExamPlanError } from '../schedule/persistence.js';
import { runPreview } from './schedule.js';
import { getPlanSelection } from '../material/service.js';
import { todayTW } from '../util/date.js';

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
  const scheduled = level === 'daily' || level === 'timed';

  // ① 從 CURRENT 世界建立 scope（驗證＋擁有權＋歸屬＋估時）；同一支給交易內重讀共用。
  let scope;
  try {
    scope = await buildExamScope(q, userId, {
      endDate, startDate, level,
      subjects: b.subjects || [], materialIds: b.material_scope || [], manual: b.manual_scope || [],
    });
  } catch (e) {
    if (e instanceof ExamPlanError) return res.status(e.status || 400).json({ error: e.message, code: e.code || null });
    throw e;
  }

  // ② daily／timed：伺服器自己排（唯讀 runPreview），排不下一律 fail closed，不建計畫。
  //    client 不送任何 blocks；unplaced／empty／失敗時禁止建立可確認的計畫。
  let computedBlocks = [];
  if (scheduled) {
    if (!scope.scopeItems.length) {
      return res.status(422).json({ error: '這個安排方式需要至少一項可排入的範圍', code: 'EXAM_SCOPE_EMPTY' });
    }
    const today = todayTW();
    const items = scope.scopeItems.map(si => ({
      subject_id: si.subjectId, title: si.title, minutes: si.minutes, spread: false, start: today, end: si.deadline,
    }));
    let pv;
    try {
      pv = await runPreview(userId, { items, timed: level === 'timed', startDate: today, endDate, pace: 'even' });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message || '無法排出可行的安排', code: 'EXAM_SCHEDULE_ERROR' });
    }
    if (pv.status !== 200) {
      return res.status(422).json({ error: pv.body?.error || '無法排出可行的安排', code: pv.body?.code || 'EXAM_SCHEDULE_INFEASIBLE' });
    }
    if (pv.body.unplaced || (pv.body.unplaced_tasks && pv.body.unplaced_tasks.length)) {
      return res.status(422).json({
        error: pv.body.message || '有內容排不進去，請延長日期或減少範圍，或改用「只分段」',
        code: 'EXAM_SCHEDULE_GAP',
      });
    }
    computedBlocks = (pv.body.blocks || []).filter(x => !x._pinned && x.subject_id != null);
  }

  // ③ 單一交易建立（任一步失敗 → 整筆 rollback，零可見殘留）。
  let planId;
  try {
    ({ planId } = await createExamPlanAtomic(userId, {
      name: b.name, description: b.description || '', startDate, endDate, level,
      subjects: b.subjects || [], materialIds: b.material_scope || [], manual: b.manual_scope || [],
      computedBlocks, scopeSig: scope.sig,
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
