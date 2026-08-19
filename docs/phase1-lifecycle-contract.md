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
- Goal progress 的分母只算未刪除、未取消 Task；取消工作不算完成，但以 `cancelled_task_count` 保留。這避免「不再做」被誤顯示為落後。

## ScheduleVersion transaction

Plan lifecycle 造成 future schedule 變動時，必須在同一 transaction：更新 Plan 狀態、從 active global snapshot 移除該 Plan 的 future blocks、檢查現在有效 Locks、建立新的 immutable ScheduleVersion、切換 active pointer 並更新 due mirror。任一環節失敗時全部 rollback。

現有 Lock 仍是 hard constraint；若停止 Plan 會改變有效的 Lock slice，操作回 409，使用者必須先解除 Lock。

## StudySession 唯一性與 production gate

- API 已拒絕同一使用者同時有多筆 `running`／`paused` session。
- 資料庫 partial unique index 不能在 production 啟動時靜默建立；先執行 `server/scripts/production-study-session-live-audit.mjs` 的唯讀 audit。
- audit 顯示沒有重複 live session 後，才可由 operator 明確執行 `server/scripts/enable-study-session-live-index.mjs`。若有重複，腳本拒絕建立 index，也不會自動改寫歷史資料。
