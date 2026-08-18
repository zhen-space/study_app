# Master Plan L：Repo-wide Product Audit

最後更新：2026-08-18。此稽核以程式搜尋、排程契約與 CI 為依據；不以 UI 表面顯示推定資料真相。

## 已確認

1. Plan Task 的未來 `due_date` / `due_time` 唯一正式寫入點是 `schedule/persistence.js` 的 mirror；公開 Task API 即使帶 `legacy_due_compat` 也回 409。唯一例外是持有 server-only migration token 的 cutover path。
2. 所有正式 schedule write 都經 `/api/schedule/apply`、manual adjustment 或 restore，最後集中在 `createScheduleVersionInTx()`；不會由前端直接寫 `scheduled_blocks`。
3. Plan 與 List/Subject 分離：schema、Plan API 與 Plan Detail 都以 `plan_id` 作工作容器，`list_id` 僅為科目分類。
4. legacy heuristic 只保留於 compatibility/preview 路徑；新版 Wizard 不呼叫 legacy `/api/plan-tasks`。
5. ScheduleVersion、ScheduledBlock、Lock、Restore、Diff 與 manual adjustment 均以 user-level active version 為邊界。
6. 已確認的 structured constraint 只由 scheduler 讀取：不支援的 strict dependency 明示為 unsupported；時間窗、日期／截止範圍、單次時長、每日上限、節奏與可用時間覆寫皆有 server-side hard enforcement，不能只靠 AI 或前端提示。

## 已處理的遺留狀態

- Wizard 的 confirmed schedule profile 已有正式 `plan_schedule_profiles` persistence；localStorage 僅保留離線與舊資料 fallback。
- Task 有 `estimated_minutes`，健康度與 replan 都優先採用它；舊資料仍可從舊 notes 相容還原，絕不猜 60 分鐘。
- 已確認的 `max_per_day` 會在 `put()` 最後寫入關卡再次驗證，補位／修復流程不得藉由舊版舒適性 fallback 繞過硬限制；超額結果明確回報為 unplaced。

## 正式 gate

`BLOCKED_BY_PRODUCTION_AUDIT`：legacy migration 的 production apply。audit script、dry-run、preview、runner 與 rollback strategy 已可用；未取得 production audit 結果前，不得自動 clustering、寫入 `plan_id` 或推定 hard deadline。

## 驗證要求

- Backend：三時區 `npm test`。
- Frontend：`npm test` 與 `npm run build`。
- PR 合併前確認最新版 GitHub Actions 全綠、draft/mergeable 狀態正確。
