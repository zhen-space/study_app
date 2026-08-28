# Legacy Task → Plan migration

**目前 gate：`BLOCKED_BY_PRODUCTION_AUDIT`。** 沒有可用的 Plan 歸屬證據，production apply 也尚未獲人工授權。

## 為什麼不能直接遷移

`tasks` 上唯一表示「屬於哪一個 Plan」的欄位就是 `plan_id` 本身，legacy 列它是 `NULL`。**沒有任何其他欄位或關聯表記錄過舊任務的 Plan 歸屬。**

剩下看起來像線索的東西，全部是 hard contract 明文禁止的推論來源：

| 訊號 | 為什麼不算證據 |
|---|---|
| `created_at` | 只代表同一批建立，不代表同一個計畫 |
| `title` 的「｜」與相似度 | 舊的組合字串格式，不是 identity |
| `list_id` | 科目分類。一科可以有很多計畫，一個計畫也可以跨科 |
| `due_date` / `due_time` | 排程鏡射，不是 deadline，也不是 Plan 邊界 |
| `material_content_item_id` | 說得出「這是哪一段教材」，說不出「屬於哪一次計畫」——同一段教材可以出現在很多個 Plan 裡 |

所以「一科＝一個 Plan」「同一天建立的是一組」這類做法一律不採用。legacy 任務若無法 deterministic 判定，**寧可保持 legacy**。

## 只讀 audit

```bash
cd server
# production（Turso 憑證只放在執行環境，不進 repo；兩者缺一即拒絕）
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/legacy-plan-audit.mjs

# 本機或備份副本（明確 opt-in，絕不自動退回 server/data.sqlite）
DB_FILE=/path/to/copy.sqlite LEGACY_AUDIT_ALLOW_LOCAL_COPY=1 node scripts/legacy-plan-audit.mjs
```

audit 在載入資料庫 client 前先 fail closed：production 必須同時有兩個 Turso 憑證；
本機副本必須同時有既存 `DB_FILE` 與 `LEGACY_AUDIT_ALLOW_LOCAL_COPY=1`。它不會呼叫
`initSchema()`，所有 DB 呼叫只可通過 `SELECT` 的窄介面，`writes_performed` 恆為 0。

輸出 JSON 會明確標示 `target_mode` 為 `production_turso` 或 `local_copy`，但不會輸出
完整 URL、token、原始 user id 或 Task title。`review_groups.user_ref` 是每次 audit 的
隨機 salt 所產生之不可逆代號，只能在同一份報告內交叉對照。請勿把憑證貼到 shell
history、repo、PR、CI log 或聊天中。輸出含：

- `totals` — 沒有 plan 的任務數、其中 legacy 數、影響人數
- `lifecycle` — active / completed / cancelled / **deleted**（刪除的也要算，否則報告會低估）
- `legacy_date_fields` — 有 due_date / due_time / deadline_date 的數量
- `history_references` — 被 ScheduledBlock、StudySession 參照的數量，以及**已刪除卻仍被參照**的數量
- `migratability` — deterministic / ambiguous，以及預估要建的 Plan 數與要掛的 Task 數
- `identity_risks` — 人工要看幾組、有幾位使用者跨科
- `review_groups` — 去識別化的人工審核分組。**刻意不叫 plan_candidates**：它不是分群建議

判定邏輯在 `server/src/legacy/plan-audit.js`，測試在 `server/test/legacy-plan-audit.test.mjs`（含 8 個 mutation 驗證過的負向測試，確保上表那些訊號都不會被誤判成證據）。

## Migration runner

`scripts/legacy-plan-migrate.mjs` **目前沒有實作任何遷移**，即使給了 approval 旗標也會拒絕退出。這是刻意的：在沒有 Plan 歸屬證據以前，任何 runner 都只能用猜的。

要解除這個 gate，需要先有**新的、明確的 provenance**，而不是放寬判定。例如在舊資料上補一個由人工確認過的 `legacy_plan_ref`——`planProvenance()` 已經預留了讀它的位置。

audit 完成後仍需人工 gate，依序審核 sanitized summary、決定是否逐筆 mapping、核准
backup 與 rollback strategy，並由使用者另外明確授權 production apply。本批只提供唯讀
audit；不包含 migration apply。

## 目前唯一支援的路徑

UI 的逐筆轉換：使用者自己建立正式 Plan，再逐筆確認要把哪些舊任務加進去。系統不猜分群，也不搬動資料。

`GET /api/legacy-migration/preview` 只列出該使用者自己的候選舊任務，不寫任何東西。

## 禁止事項

未取得正式 production audit approval 前：不得執行 migration apply、不得在 production 寫入 `plan_id`、不得修改 ScheduledBlock / ScheduleVersion 歷史、不得跨 user boundary、不得執行任何不可逆 mutation。備份、mapping 與 rollback strategy 必須在 gate 通過後另行核准。
