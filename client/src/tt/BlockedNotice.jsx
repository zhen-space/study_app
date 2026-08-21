import { Button } from './ui';

// reconciliation.blocked[] / task_exits.blocked[] 的正式 UI。
//
// 這些是**真實衝突**，不是雜訊：後端已經把能安全退出排程的都處理掉了，
// 剩下這些是因為鎖定或既有排程狀態而沒有被自動修改的。
// 規則：不得靜默忽略、不得假裝全部成功、不得偷偷解除 Lock。
export default function BlockedNotice({ data, onClose, onViewLocks = null }) {
  const blocked = data?.blocked || [];
  const cancelled = data?.cancelled || [];
  if (!blocked.length) return null;

  return (
    <div className="mt-blocked" role="alert">
      <div className="mt-blocked-head">
        <span className="mt-blocked-icon" aria-hidden="true">!</span>
        <b>有 {blocked.length} 項無法從目前排程移除</b>
      </div>
      <p className="mt-blocked-body">
        這些項目受到鎖定或既有排程狀態影響，因此<strong>沒有自動修改</strong>。
        其餘變更已經套用{cancelled.length ? `（${cancelled.length} 項已退出排程）` : ''}。
      </p>
      <ul className="mt-blocked-list">
        {blocked.map((b, i) => (
          <li key={b.task_id ?? i}>
            <span className="mt-blocked-item">{b.title || `任務 #${b.task_id}`}</span>
            <span className="mt-blocked-why">{b.error || '受到鎖定保護'}</span>
          </li>
        ))}
      </ul>
      <div className="mt-blocked-actions">
        {onViewLocks && <Button size="sm" variant="secondary" onClick={onViewLocks}>查看鎖定安排</Button>}
        <Button size="sm" variant="tertiary" onClick={onClose}>保留目前安排</Button>
      </div>
    </div>
  );
}
