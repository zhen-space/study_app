import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import { applySchedule, SOURCE } from '../schedule/persistence.js';
import { getPlanSelection } from '../material/service.js';

// 段考計畫（Exam Plan）——不是第二套 Plan，就是既有 Plan 加兩個 additive 層：
//   ・plan_exam_subjects：每一科自己的考試日（plan.target_date＝整個段考最後一天）。
//     各科內容的有效完成上限＝該科考試日；排程時寫進該科 Task 的 deadline_date，
//     由既有排程器強制。
//   ・plan_manual_scope：老師指定、教材庫沒有的「範圍」＝first-class scope，
//     不是 Task、不是 material selection、也不是完成。
//
// 建立是「使用者在三步精靈按下確認」時才發生的**單一原子動作**：先在一筆交易內
// 建立 Plan＋各科考試日＋教材選取＋手動 scope；若選了每日/時段，再用既有
// applySchedule 建立正式 ScheduleVersion（失敗則補償刪除剛建立的 Plan，不留半成品）。
// 絕不先建空 Plan、也不把使用者丟到空白 Plan Detail。

const router = Router();
router.use(requireAuth);

const LEVELS = ['progress', 'daily', 'timed'];
const validDate = x => x == null || x === '' || /^\d{4}-\d\d-\d\d$/.test(x);
const now = () => new Date().toISOString();

// content item 擁有權（fail-closed）：全部必須屬於自己。
async function ownedContentItems(userId, ids) {
  if (!ids.length) return true;
  const ph = ids.map(() => '?').join(',');
  const rows = await q.all(`SELECT id FROM material_content_items WHERE user_id=? AND id IN (${ph})`, [userId, ...ids]);
  return rows.length === ids.length;
}

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

// 驗證段考定義。回錯誤字串或 null。
async function validateDef(userId, b) {
  if (!String(b.name || '').trim()) return '請輸入段考名稱';
  if (!b.end_date || !validDate(b.end_date)) return '請設定段考結束日期';
  if (!validDate(b.start_date)) return '開始日期不正確';
  if (b.start_date && b.end_date < b.start_date) return '結束日期不能早於開始日期';
  if (b.level != null && !LEVELS.includes(b.level)) return '安排方式不正確';
  const subjects = Array.isArray(b.subjects) ? b.subjects : [];
  if (!subjects.length) return '請至少加入一個考試科目';
  for (const s of subjects) {
    const l = await q.get('SELECT id FROM lists WHERE id=? AND user_id=?', [s.subject_list_id, userId]);
    if (!l) return '找不到其中一個科目';
    if (s.exam_date != null && s.exam_date !== '' && !validDate(s.exam_date)) return '某一科的考試日期不正確';
    if (s.exam_date && b.end_date && s.exam_date > b.end_date) return '單科考試日不能晚於段考結束日';
  }
  const mat = [...new Set((b.material_scope || []).map(Number).filter(Number.isInteger))];
  if (!(await ownedContentItems(userId, mat))) return '教材範圍中有不存在或不屬於你的內容';
  for (const m of (b.manual_scope || [])) {
    if (!String(m.label || '').trim()) return '手動範圍必須有名稱';
  }
  return null;
}

// POST：原子建立段考計畫。
router.post('/exam-plans', async (req, res) => {
  const b = req.body || {};
  const err = await validateDef(req.userId, b);
  if (err) return res.status(400).json({ error: err });
  const userId = req.userId;
  const endDate = b.end_date;
  const subjects = b.subjects;
  const materialIds = [...new Set((b.material_scope || []).map(Number).filter(Number.isInteger))];
  const manual = (b.manual_scope || []).filter(m => String(m.label || '').trim());
  const level = LEVELS.includes(b.level) ? b.level : 'progress';

  // tx1：Plan + 各科考試日 + 教材選取 + 手動 scope（原子）。
  const planId = await q.tx(async tx => {
    const r = await tx.run(
      `INSERT INTO plans (user_id,name,description,primary_list_id,start_date,target_date,status,source,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [userId, String(b.name).trim(), b.description || '', subjects[0]?.subject_list_id ?? null,
        b.start_date || null, endDate, 'active', 'manual', now(), now()]);
    const pid = Number(r.lastInsertRowid);
    let oi = 0;
    for (const s of subjects) {
      await tx.run(
        `INSERT INTO plan_exam_subjects (user_id,plan_id,subject_list_id,exam_date,order_index)
         VALUES (?,?,?,?,?)`,
        [userId, pid, s.subject_list_id, s.exam_date || endDate, oi++]);
    }
    for (const cid of materialIds) {
      await tx.run(
        `INSERT INTO plan_material_items (user_id,plan_id,content_item_id,selected,updated_at)
         VALUES (?,?,?,1,CURRENT_TIMESTAMP)
         ON CONFLICT(plan_id,content_item_id) DO UPDATE SET selected=1, removed_at=NULL, updated_at=CURRENT_TIMESTAMP`,
        [userId, pid, cid]);
    }
    oi = 0;
    for (const m of manual) {
      await tx.run(
        `INSERT INTO plan_manual_scope (user_id,plan_id,subject_list_id,label,estimated_minutes,order_index)
         VALUES (?,?,?,?,?,?)`,
        [userId, pid, m.subject_list_id ?? null, String(m.label).trim(),
          Number.isInteger(m.estimated_minutes) && m.estimated_minutes > 0 ? m.estimated_minutes : null, oi++]);
    }
    return pid;
  });

  // 每日／時段：用既有 applySchedule 建立正式 ScheduleVersion（各科 deadline＝該科考試日）。
  // 失敗補償：剛建立的 Plan 沒有任何歷史，整組刪除，不留半成品。
  const sched = b.schedule || null;
  if ((level === 'daily' || level === 'timed') && sched && Array.isArray(sched.blocks) && sched.blocks.length) {
    try {
      await applySchedule(userId, {
        planId, source: SOURCE.INITIAL,
        taskCreates: sched.task_creates || [],
        blocks: sched.blocks || [],
      });
    } catch (e) {
      await q.tx(async tx => {
        await tx.run('DELETE FROM plan_manual_scope WHERE user_id=? AND plan_id=?', [userId, planId]);
        await tx.run('DELETE FROM plan_material_items WHERE user_id=? AND plan_id=?', [userId, planId]);
        await tx.run('DELETE FROM plan_exam_subjects WHERE user_id=? AND plan_id=?', [userId, planId]);
        await tx.run('DELETE FROM plans WHERE user_id=? AND id=?', [userId, planId]);
      }).catch(() => {});
      return res.status(e.status || 400).json({ error: `已取消建立：排程失敗（${e.message}）`, code: e.code || null });
    }
  }

  res.status(201).json(await examProjection(userId, planId));
});

export default router;
