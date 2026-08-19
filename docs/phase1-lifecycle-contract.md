# Phase 1 Lifecycle Contract

## Plan

- 主 lifecycle：`draft | active | paused | completed | ended`；`archived` 是收納狀態。
- `completed` 只在所有未刪除 Task 都是 `completed` 或 `cancelled` 時成立；不支援 `force`。
- `ended` 表示使用者不再繼續，可保留未完成 Task 與 `end_reason`；必須明確確認。
- `paused`、`completed`、`ended` 與 `archived` 均不參與新的排程或 Study 開始候選。
- archive 保存 `archived_from_status`，restore 必須回到封存前狀態，不能一律回 `active`。
- restart／resume 只回到 `active`；原本未完成 Task 保持 unplaced，絕不偷偷復原舊 block。

## Task

- Task 結果互斥：`completed`、`cancelled`、未處理三者只能擇一；cancel 不是 delete。
- completed／cancelled Task 不進新的 future ScheduleVersion、scheduler、unplaced、health workload 或 Study start candidate。completed Task 保留既有 `due_date` 作歷史相容顯示；cancelled Plan Task 會清除 mirror。
- reopen 會清除 completed/cancelled 結果，但不會自行建立排程。

## ScheduleVersion transaction

Plan lifecycle 造成 future schedule 變動時，必須在同一 transaction：更新 Plan 狀態、從 active global snapshot 移除該 Plan 的 future blocks、檢查現在有效 Locks、建立新的 immutable ScheduleVersion、切換 active pointer 並更新 due mirror。任一環節失敗時全部 rollback。

現有 Lock 仍是 hard constraint；若停止 Plan 會改變有效的 Lock slice，操作回 409，使用者必須先解除 Lock。
