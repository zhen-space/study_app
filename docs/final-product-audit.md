# Master Plan L：Repo-wide Product Audit

最後更新：2026-08-18。此稽核以程式搜尋、排程契約與 CI 為依據；不以 UI 表面顯示推定資料真相。

## 已確認

1. Plan Task 的未來 `due_date` / `due_time` 唯一正式寫入點是 `schedule/persistence.js` 的 mirror；公開 Task API 即使帶 `legacy_due_compat` 也回 409。唯一例外是持有 server-only migration token 的 cutover path。
2. 所有正式 schedule write 都經 `/api/schedule/apply`、manual adjustment 或 restore，最後集中在 `createScheduleVersionInTx()`；不會由前端直接寫 `scheduled_blocks`。
3. Plan 與 List/Subject 分離：schema、Plan API 與 Plan Detail 都以 `plan_id` 作工作容器，`list_id` 僅為科目分類。
4. legacy heuristic 只保留於 compatibility/preview 路徑；新版 Wizard 不呼叫 legacy `/api/plan-tasks`。
5. ScheduleVersion、ScheduledBlock、Lock、Restore、Diff 與 manual adjustment 均以 user-level active version 為邊界。
6. 已確認的 structured constraint 只由 scheduler 讀取：不支援的 strict dependency 明示為 unsupported；時間窗、日期／截止範圍、單次時長、每日上限、節奏與可用時間覆寫皆有 server-side hard enforcement，不能只靠 AI 或前端提示。
7. `GET /api/tasks` 的 recurring drop roll-forward 只作用於一般 Task；Plan Task 的 mirror 不會被 read path 改寫。`capacity_gap_minutes` 僅以 timed placement 計算，date-only placement 不會因缺少 `planned_minutes` 被誤判。
8. Plan health 的 Lock/collision reason 均為 plan-scoped；其他 Plan 的有效 Lock 不會使本 Plan 進入 Today「計畫需要調整」。
9. StudySession 是現役實際讀書時間唯一來源；Today 與 Calendar 從 ScheduledBlock 開始讀書時會寫入該 `scheduled_block_id`，統計可回到對應的 block。已完成或已刪除的 Task 不能開始新的 StudySession。
10. ScheduledBlock timing 僅有兩種 canonical shape：timed block 同時具有 `start_time`、`end_time`，且 `planned_minutes` 等於兩者的分鐘差；date-only block 的三欄皆為 `null`。persistence write gate、manual candidate、Lock baseline 與 bootstrap 都使用同一 canonicalizer，零／負／不完整時間窗不會成為新的 timed placement。

## 已處理的遺留狀態

- Wizard 的 confirmed schedule profile 已有正式 `plan_schedule_profiles` persistence；localStorage 僅保留離線與舊資料 fallback。
- Task 有 `estimated_minutes`，健康度與 replan 都優先採用它；舊資料仍可從舊 notes 相容還原，絕不猜 60 分鐘。
- 已確認的 `max_per_day` 會在 `put()` 最後寫入關卡再次驗證，補位／修復流程不得藉由舊版舒適性 fallback 繞過硬限制；超額結果明確回報為 unplaced。
- `/api/plan-tasks` 的 DELETE 僅限 `plan_id IS NULL` 的 legacy Task；modern Plan Task 永不會被這支相容端點 hard delete。
- `tstats` 對 immutable versions 的 moved aggregation 使用批次 block query，StudySession／planned 統計的 Task/List/Plan joins 都帶 user boundary。
- Pomodoro 已 deprecated：既有 `pomo_sessions` historical rows 不刪除，但 `/api/pomo` 不再接受新寫入，且現役 `tstats.actual*` 僅由 StudySession 計算。StudySession list/history 使用 task title snapshot 與 user-scoped LEFT JOIN，因此 Task 被 hard-delete 後歷史紀錄仍可讀取。
- init schema 的冪等 ScheduledBlock integrity repair 會將 Class B（完整 window、缺 `planned_minutes`）回填為 window 的真實分鐘數；Class A（half-timed）與 invalid window 則保守降為 date-only。這是 schema-integrity repair，不會碰 `tasks.plan_id`，不屬於 production Plan migration gate。修復後舊版 planned 統計可能由 `NULL` 變成可驗證的實際 window 分鐘數，但不會 double count，也不影響 StudySession 的 actual source of truth。
- bootstrap 面對舊 Plan Task 的 `due_date + due_time` 但無 duration 時，一律建立 date-only block；不得捏造 60 分鐘或其他 timed workload。
- Goals 目前沒有「刪除目標」的 UI 或既定 lifecycle contract；為避免自行決定 Plans 要 unlink、archive 或 cascade，本輪不新增 DELETE route。

## 正式 gate

`BLOCKED_BY_PRODUCTION_AUDIT`：legacy migration 的 production apply。audit script、dry-run、preview、runner 與 rollback strategy 已可用；未取得 production audit 結果前，不得自動 clustering、寫入 `plan_id` 或推定 hard deadline。

## 保留技術債

- `/plans/:id/health` 仍採數個清楚的 plan-scoped query；未在缺少量測的情況下改成複雜 batch query，以免改變 health contract。資料量成長後再以 query profile 決定索引與批次策略。
- Pomodoro 的舊 reward source 已停用；尚未有已批准的 StudySession award contract，因此本輪不臨時新增 coins 規則。

## 驗證要求

- Backend：三時區 `npm test`。
- Frontend：`npm test` 與 `npm run build`。
- PR 合併前確認最新版 GitHub Actions 全綠、draft/mergeable 狀態正確。
