# Phase 2C Implementation Plan

> 範圍固定為既定 2C 契約；不新增產品議題、不改排程演算法的規則。

## 1. 寫入地基與 schema

- `server/src/db/init.js`：補齊 versions、blocks、locks、state 的冪等欄位與索引。
- `server/src/schedule/persistence.js`：唯一的 ScheduleVersion／ScheduledBlock 寫入點。
- 所有 version metadata、block、active pointer 與未完成 Plan Task 的 due mirror 在一筆 `q.tx()` 中完成。
- block 建立前於 transaction 內驗證：Task 存在、同 user、有 `plan_id`、未刪除、未完成；任一失敗整筆 rollback。

## 2. Bootstrap 與 active version

- `POST /api/schedule/bootstrap` 以 transaction 內 `active_version_id IS NULL` 作為原子前置條件。
- 已有 active 時回傳既有 version，不建立第二份 bootstrap；不依賴程序內 writeQueue。
- active 的唯一來源為 `user_schedule_state.active_version_id`，絕不以最大 version number 推導。

## 3. Due mirror

- active block 單向鏡射未完成、未刪除的 Plan Task。
- 該 task 沒有 active block 即正式 unplaced，清除 `due_date`／`due_time`。
- completed Plan Task 不被 mirror 清除，保留歷史顯示相容資料。

## 3.1 P2：Wizard／Replan 接線

- `POST /api/schedule/apply` 是 Wizard 初次建立與 AI Replan 的正式套用入口。
- 同一筆 `q.tx()` 內完成未完成 Plan Task 的建立／非時間欄位更新／軟刪除、
  新 ScheduleVersion、ScheduledBlocks、active pointer 與 due mirror；任一 block
  對應失敗時全部 rollback。
- Wizard create 使用 `source=initial`；Replan 使用 `source=ai_replan`，並在交易內
  讀取當前 active version 作為 `parent_version_id`。
- 前端不得在這兩條新流程呼叫 `/tasks/bulk`，也不得 PATCH `due_date`／`due_time`；
  時間只以 preview block 傳給 persistence service。

## 4. Restore preview / apply

- 新增 restore preview / apply service 與 `/versions/:id/restore-preview`、`/restore`。
- preview 以來源版本作模板、現在 active 作 base，套用現在的 task、deadline 與 fixed event constraints。
- apply 必須在 transaction 內以 `base_version_id` 條件更新 active pointer；stale 時回 409，不進 retry。
- restore 永遠產生新 version，新增 task 保持 unplaced，從不直接重啟舊版。
- P3 提供版本列表、版本內容與 restore preview 的最小 UI；partial 必須由使用者明確確認。
- Lock constraint 將在 P4 接入同一條 feasibility 路徑；本批不新增 Lock CRUD 或 UI。

## 5. Feasibility 與 Lock

- `server/src/schedule/locks.js` 放 pure validator：有效 lock 推導、block signature、candidate lock conflicts。
- `server/src/schedule/feasibility.js` 組合 task、fixed event、Lock 與 schedule-level 檢查；不直接存取 DB。
- `server/src/routes/schedule.js` 只負責組裝輸入：被鎖 Task 事前釘住、time/day slice 扣容量，生成後再用 pure validator 驗證。
- `GET/POST/DELETE /api/schedule/locks` 做 Lock CRUD；解除是 soft release，Task Lock 不可對 unplaced task 建立。

## 6. Diff

- `server/src/schedule/diff.js` 以 `task_id` 的 canonical block set 比對兩版。
- 回傳 `unchanged | moved | added | removed | changed`；UI 預設隱藏 unchanged。
- 不建 `schedule_diffs` table；歷史 diff 從 immutable blocks 即時計算。
- restore diff 永遠是 restore 前 active → 新 restore version。

## 7. 測試矩陣

- transaction rollback、非法 block、跨 user、deleted/completed/non-Plan task。
- bootstrap multi-instance idempotency、version number collision、stale base 409。
- mirror / unplaced / completed historical due-date。
- restore full / partial / impossible / nothing-to-restore、past / fixed event / deadline / lock。
- Task/Time/Day lock lifecycle、空 slice、完成後豁免與取消完成後恢復。
- diff 的多 block、四類變更、effective_from 邊界、restore comparison base。
- 全後端測試三時區、前端測試、production build、CI。
