# Study App Master Plan 現況

此文件記錄 Master Plan 的正式資料邊界，避免新流程又回到 Task `due_date` 當唯一時間真相。

## 已落地的基線

- Plan 與 Subject/List 分離；Task 可選擇歸屬 Plan。
- ScheduleVersion 是 user-level snapshot；ScheduledBlock 透過 Task 取得 Plan。
- Restore、Lock、Diff 與手動調整都以 current active schedule 為準。
- Plan Task 的 `due_date` / `due_time` 僅由 ScheduleVersion persistence mirror 寫入。Task API 對新 Plan Task 直接寫時間會拒絕；`legacy_due_compat` 僅供既有資料 cutover 使用。
- Availability routine、exception、StudySession、Goal、constraint intent 都是可獨立演進的 domain。

## Master Plan 進度

- A：preview 提供 deterministic feasibility gap；Plan health 使用 normalized model。
- B：有 recurring routine、例外日、scheduler mapping 與學生端管理入口。
- C：有 AI → structured intent → user confirmation 的安全通道；只有 supported 欄位會進 scheduler，strict dependency 仍明確標記為 unsupported。
- D：Plan Detail 可新增 Task、編輯 description、completed → active。
- E：Calendar 可顯示 ScheduledBlock 與 Time/Day Lock，並走既有 manual version flow。
- F/G：StudySession 與 planned vs actual 統計已建立；後續估時調整必須以資料驗證後另行設計。
- H：Goal CRUD、Plan 指派與 aggregate progress 已建立。
- I：audit、preview 與 UI 安全入口已建立；production apply 仍受 audit gate 保護。

## 正式 Gate

production legacy migration 尚未獲得資料 audit approval。不得自動分群、不得以 `created_at` 推斷群集、不得把舊 `due_date` 推定為 hard deadline；詳見 [legacy-migration.md](legacy-migration.md)。
