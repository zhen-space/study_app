import { Router } from 'express';
import { q } from '../db/init.js';
import { requireAuth } from '../middleware/auth.js';
import {
  API_ALLOWED_PROVENANCE_SOURCES, PROVENANCE_SOURCES, FORBIDDEN_PROVENANCE_SOURCES,
  VERIFICATION_STATUSES, AUTHORITATIVE_STATUS,
  USER_CONFIRMATION_MECHANISM, validateMappingInput, classifyPreview,
} from '../legacy/plan-mapping.js';

// Legacy Task → Plan。
//
// 這個 router 完全不寫 tasks.plan_id，也不碰 ScheduleVersion / ScheduledBlock /
// StudySession。它只做兩件事：讓人把「這個舊任務屬於哪個計畫」的判斷明確記下來，
// 以及照著那些判斷產生唯讀的 preview。
//
// **沒有 apply endpoint，這是刻意的。** 真正會改 production tasks.plan_id 的動作
// 需要備份、mapping 快照與 rollback 三件事都先核准；在那之前不提供入口，
// 比提供一個「應該不會被誤觸」的入口安全。
const router = Router(); router.use(requireAuth);

const now = () => new Date().toISOString();
const VERIFICATION_MECHANISM = USER_CONFIRMATION_MECHANISM;

// 擁有權一律在查詢條件裡帶 user_id，不是查完再比對——少一個地方會忘記。
const myTask = (id, userId) =>
  q.get('SELECT id,title,plan_id,deleted FROM tasks WHERE id=? AND user_id=?', [id, userId]);
const myPlan = (id, userId) =>
  q.get("SELECT id,name FROM plans WHERE id=? AND user_id=? AND status<>'deleted'", [id, userId]);
const myMapping = (id, userId) =>
  q.get('SELECT * FROM legacy_task_plan_mappings WHERE id=? AND user_id=?', [id, userId]);

// I：使用者只看自己的 legacy 候選資料。這不是 migration runner，完全不寫資料。
router.get('/legacy-migration/preview', async (req, res) => {
  const tasks = await q.all(`SELECT t.id,t.title,t.list_id,t.due_date,t.completed,l.name AS list_name FROM tasks t LEFT JOIN lists l ON l.id=t.list_id
    WHERE t.user_id=? AND t.plan_id IS NULL AND COALESCE(t.deleted,0)=0`, [req.userId]);
  const candidates = tasks.filter(t => String(t.title || '').includes('｜'));
  res.json({ mode: 'preview_only', candidates, warning: '舊任務不會自動被分群、移動或刪除。請建立正式計畫後逐筆確認要加入的任務。' });
});

/* ---------- mapping ---------- */

// GET /api/legacy-migration/mappings?verification_status=verified
router.get('/legacy-migration/mappings', async (req, res) => {
  const args = [req.userId];
  let sql = 'SELECT * FROM legacy_task_plan_mappings WHERE user_id=?';
  const status = req.query.verification_status;
  if (status) {
    if (!VERIFICATION_STATUSES.includes(status)) return res.status(400).json({ error: '確認狀態不正確' });
    sql += ' AND verification_status=?';
    args.push(status);
  }
  sql += ' ORDER BY id';
  res.json({
    mappings: await q.all(sql, args),
    contract: {
      provenance_sources: PROVENANCE_SOURCES,
      api_allowed_provenance_sources: API_ALLOWED_PROVENANCE_SOURCES,
      forbidden_provenance_sources: FORBIDDEN_PROVENANCE_SOURCES,
      verification_statuses: VERIFICATION_STATUSES,
      authoritative_status: AUTHORITATIVE_STATUS,
    },
  });
});

router.get('/legacy-migration/mappings/:id', async (req, res) => {
  const mapping = await myMapping(req.params.id, req.userId);
  if (!mapping) return res.status(404).json({ error: '找不到這筆對應' });
  res.json(mapping);
});

// POST /api/legacy-migration/mappings
// 建立一筆人工確認的 mapping。預設是 unresolved——「建立」跟「確認」是兩個動作，
// 送出候選不等於已經查證過。要一次做完可以帶 verification_status: 'verified'。
router.post('/legacy-migration/mappings', async (req, res) => {
  const b = req.body || {};
  const err = validateMappingInput(b, { allowedSources: API_ALLOWED_PROVENANCE_SOURCES });
  if (err) return res.status(400).json({ error: err });

  const taskId = Number(b.legacy_task_id);
  const planId = Number(b.target_plan_id);
  // 兩邊都必須是自己的。不是自己的一律回 404，不區分「不存在」與「別人的」——
  // 否則這支端點會變成探測別人有哪些 id 的工具。
  const [task, plan] = await Promise.all([myTask(taskId, req.userId), myPlan(planId, req.userId)]);
  if (!task) return res.status(404).json({ error: '找不到這個舊任務' });
  if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
  if (task.deleted) return res.status(409).json({ error: '這個任務已刪除，不能建立對應', code: 'task_deleted' });
  if (task.plan_id != null) {
    return res.status(409).json({ error: '這個任務已經屬於某個計畫，不需要對應', code: 'already_migrated', current_plan_id: Number(task.plan_id) });
  }

  const existing = await q.get(
    'SELECT * FROM legacy_task_plan_mappings WHERE user_id=? AND legacy_task_id=?', [req.userId, taskId]);
  if (existing) {
    return res.status(409).json({ error: '這個舊任務已經有一筆對應，請直接修改它', code: 'mapping_exists', mapping: existing });
  }

  const status = b.verification_status || 'unresolved';
  const verified = status === AUTHORITATIVE_STATUS;
  const t = now();
  const r = await q.run(
    `INSERT INTO legacy_task_plan_mappings
      (user_id,legacy_task_id,target_plan_id,provenance_source,provenance_ref,
       verification_status,verified_at,verified_by,verification_mechanism,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [req.userId, taskId, planId, b.provenance_source, b.provenance_ref ?? null,
      status, verified ? t : null, verified ? req.userId : null,
      verified ? VERIFICATION_MECHANISM : null, t, t]);
  res.json(await q.get('SELECT * FROM legacy_task_plan_mappings WHERE id=?', [r.lastInsertRowid]));
});

// PATCH /api/legacy-migration/mappings/:id
// 可改：target_plan_id、provenance_ref、verification_status。
// user_id / legacy_task_id / provenance_source 不可改——改掉那三個等於換一筆 mapping，
// 應該重新建立，而不是把既有的紀錄改成別的意思。
router.patch('/legacy-migration/mappings/:id', async (req, res) => {
  const mapping = await myMapping(req.params.id, req.userId);
  if (!mapping) return res.status(404).json({ error: '找不到這筆對應' });
  const b = req.body || {};

  const sets = [], args = [];
  let targetPlanId = Number(mapping.target_plan_id);
  if (b.target_plan_id != null && Number(b.target_plan_id) !== targetPlanId) {
    const plan = await myPlan(Number(b.target_plan_id), req.userId);
    if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
    targetPlanId = Number(b.target_plan_id);
    sets.push('target_plan_id=?'); args.push(targetPlanId);
    // 換了目標計畫，先前那次確認查證的就不是現在這件事了。
    // 除非同一個請求重新確認，否則一律退回 unresolved。
    if (b.verification_status == null) {
      sets.push('verification_status=?', 'verified_at=?', 'verified_by=?', 'verification_mechanism=?');
      args.push('unresolved', null, null, null);
    }
  }
  if ('provenance_ref' in b) {
    if (b.provenance_ref != null && typeof b.provenance_ref !== 'string') {
      return res.status(400).json({ error: '依據參照格式不正確' });
    }
    sets.push('provenance_ref=?'); args.push(b.provenance_ref ?? null);
  }
  if (b.verification_status != null) {
    if (!VERIFICATION_STATUSES.includes(b.verification_status)) {
      return res.status(400).json({ error: '確認狀態不正確' });
    }
    const verified = b.verification_status === AUTHORITATIVE_STATUS;
    if (verified) {
      // 確認的對象必須還在、還是自己的、而且還是 legacy。對一個已刪除或已歸屬的
      // 任務蓋確認章，會產生一筆看起來有權威、其實指向不存在事實的紀錄。
      const task = await myTask(Number(mapping.legacy_task_id), req.userId);
      if (!task || task.deleted) {
        return res.status(409).json({ error: '這個任務已不存在或已刪除，不能確認', code: 'task_unavailable' });
      }
      if (task.plan_id != null) {
        return res.status(409).json({ error: '這個任務已經屬於某個計畫，不需要確認', code: 'already_migrated', current_plan_id: Number(task.plan_id) });
      }
      const plan = await myPlan(targetPlanId, req.userId);
      if (!plan) return res.status(404).json({ error: '找不到這個計畫' });
    }
    const t = now();
    sets.push('verification_status=?', 'verified_at=?', 'verified_by=?', 'verification_mechanism=?');
    args.push(b.verification_status, verified ? t : null, verified ? req.userId : null,
      verified ? VERIFICATION_MECHANISM : null);
  }
  if (!sets.length) return res.json(mapping);

  sets.push('updated_at=?'); args.push(now());
  args.push(mapping.id, req.userId);
  await q.run(`UPDATE legacy_task_plan_mappings SET ${sets.join(',')} WHERE id=? AND user_id=?`, args);
  res.json(await q.get('SELECT * FROM legacy_task_plan_mappings WHERE id=?', [mapping.id]));
});

// GET /api/legacy-migration/migration-preview
//
// 唯讀。四個結果桶是**平行的**，不是成功與失敗：
//   verified          —— 具備 migration authority
//   unresolved        —— 還沒有人確認。永遠停在這裡是被允許的結局
//   rejected          —— 已經確認「不屬於那個計畫」
//   already_migrated  —— 任務現在已經有 plan_id 了
// 另外兩個是報告用的事實，不是待辦：invalid_reference（參照壞掉）、
// unmapped_legacy（完全沒有 mapping 的舊任務）。
router.get('/legacy-migration/migration-preview', async (req, res) => {
  const [mappings, plans] = await Promise.all([
    q.all('SELECT * FROM legacy_task_plan_mappings WHERE user_id=? ORDER BY id', [req.userId]),
    q.all("SELECT id FROM plans WHERE user_id=? AND status<>'deleted'", [req.userId]),
  ]);
  // 需要的任務有兩種：所有 legacy 任務（算 unmapped），以及有 mapping 的任務
  // （其中有些已經不是 legacy 了，要能分進 already_migrated）。
  const tasks = await q.all(
    `SELECT id,title,plan_id,deleted FROM tasks
     WHERE user_id=? AND (plan_id IS NULL OR id IN (SELECT legacy_task_id FROM legacy_task_plan_mappings WHERE user_id=?))`,
    [req.userId, req.userId]);

  res.json({
    mode: 'preview_only',
    writes_performed: 0,
    // 這一輪沒有 apply endpoint。講清楚是為了讓前端不必去猜「按下去會發生什麼」。
    apply_available: false,
    apply_blocked_reason: '尚未開放自動套用：需要先核准備份、對應快照與 rollback 方案',
    ...classifyPreview({ tasks, plans, mappings }),
  });
});

export default router;
