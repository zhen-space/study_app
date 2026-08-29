# Legacy Task → Plan migration

**目前 gate：`BLOCKED_BY_PRODUCTION_AUDIT`。** production apply 尚未獲人工授權。

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

既然資料裡沒有答案，就必須有一個地方把答案**明確補上去**，並記下是誰、根據什麼、什麼時候下的判斷。那個地方是 `legacy_task_plan_mappings`。

**不要求所有 legacy Task 都要遷移。** 沒有可查證依據的任務永遠留在 legacy 是正式允許的結果，不是待辦、也不是錯誤。

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

## Provenance：`legacy_task_plan_mappings`

audit 只回答「現況有多少、多曖昧」。要讓某一筆舊任務真的可以遷移，需要的是**新的、明確的 provenance**，而不是放寬判定。這張表就是記錄那個判斷的地方。

| 欄位 | 說明 |
|---|---|
| `user_id` | 擁有者 |
| `legacy_task_id` | 舊任務 |
| `target_plan_id` | 目標計畫。`rejected` 的列上仍保留，記錄「曾被提出並被否決」的候選 |
| `provenance_source` | `source_record` / `migration_manifest` / `user_confirmed` / `admin_verified` |
| `provenance_ref` | manifest 行號、來源紀錄 id 等；`source_record`／`migration_manifest` 的 authoritative mapping 必填 |
| `verification_status` | `unresolved` / `verified` / `rejected` |
| `verified_at` / `verified_by` / `verification_mechanism` | 確認的時間、人與機制 |
| `created_at` / `updated_at` | |

刻意獨立成一張表而不是加欄位在 `tasks` 上：mapping 是一個**待確認的主張**，`tasks.plan_id` 是**已生效的事實**。放在同一列，等於每次寫入主張都在碰生產資料。

### Invariants

1. `(user_id, legacy_task_id)` 唯一，由 unique index 強制。同一個 Task 同時「屬於 A」又「屬於 B」不是 authoritative，是兩個互相矛盾的主張
2. legacy Task 與 target Plan 必須屬於同一位使用者。查詢一律把 `user_id` 帶在 WHERE 裡，跨使用者一律回 404（不區分「不存在」與「別人的」，否則會變成探測 id 的工具）
3. 只有 `verified` 具備 migration authority，而且必須同時有合法的 `provenance_source` 與 `verified_at`；`source_record`／`migration_manifest` 必須有可追溯的 `provenance_ref`，`user_confirmed`／`admin_verified` 必須有符合來源的 verifier 與 verification mechanism
4. `unresolved` / `rejected` 不得修改 `tasks.plan_id`
5. mapping 不修改 ScheduleVersion / ScheduledBlock / StudySession 歷史

### 禁止的 provenance

`inferred`、`title_match`、`date_cluster`、`created_at_cluster`、`subject_match`、`list_match`、`due_date_match`、`material_match`、`heuristic` 全部明文列在 `FORBIDDEN_PROVENANCE_SOURCES`。白名單本來就擋得住，額外列禁止清單是為了讓錯誤訊息說得出**為什麼**不行，也讓日後想放寬的人先撞到理由。

HTTP 端點另外只接受 `user_confirmed`。其餘三種代表「系統／營運方查證過」，一般使用者不該能自己宣稱——否則送一個 `provenance_source: 'admin_verified'` 就能自封權威。它們必須由伺服器端匯入流程寫入。

## API

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/api/legacy-migration/mappings` | 自己的 mapping 清單，可加 `?verification_status=` |
| `GET` | `/api/legacy-migration/mappings/:id` | 單筆 |
| `POST` | `/api/legacy-migration/mappings` | 建立人工確認 mapping，預設 `unresolved` |
| `PATCH` | `/api/legacy-migration/mappings/:id` | 改 `target_plan_id` / `provenance_ref` / `verification_status` |
| `GET` | `/api/legacy-migration/migration-preview` | 唯讀分類報告 |
| `GET` | `/api/legacy-migration/preview` | 既有的舊任務候選清單，不變 |

`user_id` / `legacy_task_id` / `provenance_source` 不可 PATCH——改掉那三個等於換一筆 mapping，應該重新建立。換 `target_plan_id` 會自動把確認退回 `unresolved`：先前那次查證的已經不是現在這件事了（同一個請求裡一併重新確認則兩者都生效）。

### migration preview

四個結果桶是**平行的**，不是成功與失敗：

- `verified` —— 具備 migration authority
- `unresolved` —— 還沒有人確認。**這不是錯誤**，永遠停在這裡是允許的結局
- `rejected` —— 已確認「不屬於那個計畫」
- `already_migrated` —— 任務現在已經有 `plan_id`

另外兩個是報告用的事實，不是待辦：`invalid_reference`（任務不存在／已刪除／目標計畫不存在，即使狀態是 `verified` 也不得留在 verified 桶）與 `unmapped_legacy`（完全沒有 mapping 的舊任務）。

`migratable_task_count` 一律從 `verified` 桶導出，不另外估——一旦與判定脫鉤就是在猜。

## Migration runner

`scripts/legacy-plan-migrate.mjs` **目前沒有實作任何遷移**，即使給了 approval 旗標也會拒絕退出。這是刻意的：在沒有 Plan 歸屬證據以前，任何 runner 都只能用猜的。

API 這一層也**刻意不提供任何 apply endpoint**，preview 回應裡的 `apply_available: false` 明講這件事。真正會改 production `tasks.plan_id` 的動作需要備份、mapping 快照與 rollback 三者都先核准；在那之前不提供入口，比提供一個「應該不會被誤觸」的入口安全。

audit 完成後仍需人工 gate，依序審核 sanitized summary、決定是否逐筆 mapping、核准
backup 與 rollback strategy，並由使用者另外明確授權 production apply。

## 目前唯一支援的路徑

UI 的逐筆轉換：使用者自己建立正式 Plan，再逐筆確認要把哪些舊任務加進去。系統不猜分群，也不搬動資料。

`GET /api/legacy-migration/preview` 只列出該使用者自己的候選舊任務，不寫任何東西。

## 程式與測試

- audit 判定：`server/src/legacy/plan-audit.js`、`server/test/legacy-plan-audit.test.mjs`
- mapping 判定：`server/src/legacy/plan-mapping.js`（純函式，不碰資料庫）
- API：`server/src/routes/legacy-migration.js`（不含任何 `UPDATE tasks` / 排程歷史寫入，由測試靜態驗證）
- mapping 測試：`server/test/legacy-plan-mapping.test.mjs`、`server/test/legacy-plan-mapping-api.test.mjs`

## 禁止事項

未取得正式 production audit approval 前：不得執行 migration apply、不得在 production 寫入 `plan_id`、不得修改 ScheduledBlock / ScheduleVersion / StudySession 歷史、不得跨 user boundary、不得執行任何不可逆 mutation。備份、mapping 與 rollback strategy 必須在 gate 通過後另行核准。
