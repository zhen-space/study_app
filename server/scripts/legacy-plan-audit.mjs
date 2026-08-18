// Legacy migration gate：只讀 audit。絕不猜 created_at 群集，也絕不改 production 資料。
import { q, initSchema } from '../db/init.js';
await initSchema();
const rows = await q.all(`SELECT user_id,list_id,title,tags,due_date,deadline_date,plan_id,deleted,completed FROM tasks
  WHERE plan_id IS NULL AND COALESCE(deleted,0)=0`);
const legacy = rows.filter(t => {
  let tags = []; try { tags = JSON.parse(t.tags || '[]'); } catch {}
  return tags.includes('讀書計劃') || String(t.title || '').includes('｜');
});
const byUser = new Map();
for (const t of legacy) {
  const key = `${t.user_id}:${t.list_id ?? 'none'}`;
  const x = byUser.get(key) || { user_id: t.user_id, list_id: t.list_id, tasks: 0, completed: 0, dated: 0, sample_titles: [] };
  x.tasks++; x.completed += t.completed ? 1 : 0; x.dated += t.due_date ? 1 : 0;
  if (x.sample_titles.length < 3) x.sample_titles.push(t.title);
  byUser.set(key, x);
}
console.log(JSON.stringify({
  generated_at: new Date().toISOString(), mode: 'audit_only',
  warning: '此報告只協助人工審核；不可據此自動建立 Plan 或推定 deadline。',
  legacy_task_count: legacy.length, candidate_groups: [...byUser.values()],
}, null, 2));
