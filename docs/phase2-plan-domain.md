# Phase 2：Plan Domain Contract 與 Legacy Migration Audit

> 狀態：**契約已定案，尚未實作。** 本文件是 Phase 2 開工前的唯一權威依據。
> 基準 commit：`54d97aa`（Phase 1 合併後）
> 最後更新：2026-08-16

---

## 0. 為什麼需要這份文件

Phase 1 的計畫視圖是**推導出來的**，不是真的 domain：

```js
// client/src/tt/plans.js（Phase 1）
export const isPlanTask = t =>
  !t.deleted && ((Array.isArray(t.tags) && t.tags.includes('讀書計劃'))
    || (t.title || '').includes('｜'));
// 再用 list_id（科目）分組 → 一科＝一個「計畫」
```

後端**沒有** `plans` 表，也沒有 `schedule_versions` / `scheduled_blocks` / `schedule_locks`。
Phase 1 的做法只是暫時的呈現層取巧，Phase 2 必須讓它退休。

---

## 1. 核心不變式（Invariants）

這五條是 Phase 2 之後不可違反的：

| # | 不變式 |
|---|---|
| 1 | **Subject/List ≠ Plan。** List 是分類；Plan 是有目標、範圍、期限與生命週期的工作單位 |
| 2 | **Schedule Version 屬於 user schedule，不屬於單一 Plan** |
| 3 | **ScheduledBlock 透過 Task 取得 Plan，不 duplicate `plan_id`** |
| 4 | **Plan 分開管理，Schedule 全域協調**（跨所有 active Plans） |
| 5 | **禁止沿用「一個科目＝一個 Plan」作為正式資料模型** |

一個科目可以有多個 Plan：

```
數學（Subject）
  ├── 第二次段考數學複習
  ├── 數學競賽準備
  ├── 暑假數學講義
  └── 每週數學錯題整理
```

Plan 也可以跨科目——「第二次段考準備」底下可以同時有數學、英文、化學的 Task。
所以 `primary_list_id` 只是**主要分類／顯示用途**，不代表 Plan identity。

最終分層：

```
Subject/List          分類
Plan                  目標導向的工作容器
Task                  可執行的工作項目
Schedule              跨 Plan 的全域時間分配
StudySession          實際發生了什麼
```

---

## 2. 本輪新增的正式決策

### 決策 1：`scheduled_blocks` 是排程時間的唯一 source of truth

Phase 2 起，「一個任務被安排在什麼時候」**只由 `scheduled_blocks` 決定**。

### 決策 2：`tasks.due_date` 降級為 legacy compatibility / materialized mirror

- 對 **Plan Task**：`due_date` 由 **active Schedule Version 的 ScheduledBlock 單向同步**（block → task），**不得**再作為 Scheduling Engine 的 authoritative schedule
- 對**非 Plan Task**：`due_date` 維持原意義，行為不變
- 同步方向是單向的：**永遠 block → due_date，絕不反向**
- 保留 `due_date` 的唯一理由是相容——既有的日曆、篩選器、匯出、提醒都讀它

> 這解決了 audit 指出的「兩個時間真相」問題。若不明確定義方向，`scheduled_blocks` 建起來的當天就會與 `due_date` 分岔。

### 決策 3：新增 `tasks.deadline_date`

現況 `due_date` 同時被當成「排定日期」與「截止日」兩種語意在用，排程演算法的硬規則「不得排到自己截止日之後」目前是靠 items 的 `end` 傳進去、算完就丟。

Phase 2 新增：

```sql
ALTER TABLE tasks ADD COLUMN deadline_date TEXT;
```

| 欄位 | 語意 |
|---|---|
| `deadline_date` | **正式截止日 constraint**。排程引擎的硬約束來源 |
| `due_date` | 排定日期的鏡像（見決策 2） |

兩者不可互相取代。`deadline_date` 為 NULL 表示無硬性截止。

### 決策 4：Legacy migration Plan 命名 `{科目名}｜{書名}`

書名取自標題第 2 段（`物理｜新大滿貫｜單元3｜節2｜範例+例題` → `新大滿貫`），
取不到時回退 `toc_items.book`，再取不到則只用科目名。

### 決策 5：migrated Plan 的日期

- `start_date` = 該 cluster 的 `MIN(due_date)`
- `target_date` = 該 cluster 的 `MAX(due_date)`

⚠️ `target_date` **僅為舊資料推定的排程範圍結尾，不保證等於原始 deadline。**
舊資料沒有保存 deadline，這是推定值。Migration 建立的 Plan 不得因此設定
`deadline_date`——寧可留白，也不要寫入猜測值。

### 決策 6：沿用既有 migration 風格

不導入 migration framework。照 `server/src/db/init.js` 現行做法：

```js
// 新表
CREATE TABLE IF NOT EXISTS plans (...)
// 新欄位
try { await client.execute("ALTER TABLE tasks ADD COLUMN plan_id INTEGER"); } catch {}
```

冪等、可重複執行、失敗不擋啟動。這是這個專案既有的慣例，不要為了 Plan domain 另造一套。

---

## 3. Legacy Migration Audit（實際程式碼調查）

### 3.1 有沒有 batch / generation / source identifier？

**沒有。**

`POST /api/tasks/bulk`（`server/src/routes/ticktick.js:259`）寫入的欄位只有：

```
user_id, list_id, title, notes, due_date, due_time,
priority, tags, subtasks, recurring, miss_policy
```

前端 `WizardView.confirm()`（`client/src/tt/WizardView.jsx`）送出的更少：

```js
tasks: preview.blocks.map(b => ({
  title: b.title, list_id: b.subject_id, due_date: b.date, tags: ['讀書計劃'],
  ...(b.start_time ? { due_time: b.start_time, notes: `讀書時段 …` } : {}),
}))
```

**結論：「哪些 Task 屬於同一次真正的計畫」這個資訊，在寫入當下就沒有被保留。**

### 3.2 唯一可用的代理鍵：`tasks.created_at`

`tasks` 原始 schema 就有（`init.js:78`）：

```sql
created_at TEXT DEFAULT CURRENT_TIMESTAMP
```

而整份計畫是**單一 `q.batch()`、一個交易**寫入的，所以同一次生成的任務 `created_at` 會落在數秒內。

兩個必須注意的技術細節：

1. `CURRENT_TIMESTAMP` 是**秒級**且每個 statement 各自求值 → 大批次（200 筆）可能橫跨 1–3 秒。
   **必須用時間叢集（gap 超過門檻視為新批次），不可用精確相等分組。**
2. **不要用 `id` 連號判斷邊界**。單批內 id 連號成立，但跨批也連號，分不出批次交界。

### 3.3 關鍵發現：多數歷史批次已經不存在

`DELETE /api/plan-tasks`（`ticktick.js:324`）在每次建立新計畫前執行：

```sql
DELETE FROM tasks WHERE user_id=? AND completed=0
  AND (tags LIKE '%讀書計劃%' OR title LIKE '%｜%')
```

**是硬刪除，不是軟刪除。** 因此：

| 資料 | 保留情形 |
|---|---|
| 未完成的計劃任務 | **只有最近一次生成存活** |
| 已完成的計劃任務 | 跨所有世代累積，各自帶著自己的 `created_at` |

對 migration 的意義：

- ✅ **「目前正在執行的計畫」邊界是明確的**——就是那唯一一叢未完成任務
- ❌ **「一個科目曾經有過幾份不同 Plan」對未完成資料而言已永久遺失**
  （這不是 migration 寫得好不好的問題，是資料當初就被刪了）

### 3.4 三個地雷

**① `title LIKE '%｜%'` 會誤判。**
任何使用者手打、標題含全形「｜」的一般任務都會被當成計劃任務——而且**已經被硬刪過**。
Migration 必須**以 `tags` 為主**，「｜」只當次要訊號。

**② 軟刪除的任務。**
`deleted=1` 的任務還在表裡。若 migration 跳過它們，使用者從垃圾桶還原後會得到
`plan_id = NULL` 的孤兒。**建議一併補 `plan_id`，`deleted` 旗標不動。**

**③ 標籤是安全的。**
`cleanTags`（`ticktick.js:11`）只濾掉 1–2 個 ASCII 字母的標籤，`讀書計劃` 不會被吃掉。

---

## 4. 正式資料查詢（結果待回填）

> ⚠️ **本節數字尚未取得。**
> 這些查詢必須在**正式 Turso 資料庫**上執行。開發環境的 `data.sqlite` 目前是空的
> （容器重啟時清掉），無法提供有意義的樣本。SQL 語法已驗證可執行。
> **Phase 2 開工前必須先跑完並回填本節，第 5 節的規則才能定案。**

```sql
-- ① created_at 有沒有真的填上
SELECT COUNT(*) total,
       SUM(CASE WHEN created_at IS NULL OR created_at='' THEN 1 ELSE 0 END) 沒有時間戳
FROM tasks WHERE user_id = ?;

-- ② 時間叢集：看得出幾個批次、每批幾筆
SELECT substr(created_at,1,16) 分鐘, COUNT(*) 筆數,
       SUM(completed) 已完成, COUNT(DISTINCT list_id) 科目數
FROM tasks
WHERE user_id = ? AND (tags LIKE '%讀書計劃%' OR title LIKE '%｜%')
GROUP BY 1 ORDER BY 1;

-- ③ 「｜」誤判規模：含｜但沒有讀書計劃標籤的筆數
SELECT COUNT(*) FROM tasks
WHERE user_id = ? AND title LIKE '%｜%' AND tags NOT LIKE '%讀書計劃%';
```

### 回填欄位

| 查詢 | 結果 | 填寫日期 |
|---|---|---|
| ① total / 沒有時間戳 | _待填_ | |
| ② 叢集數 / 各叢筆數 | _待填_ | |
| ③ ｜誤判筆數 | _待填_ | |

---

## 5. Legacy Clustering / Fallback 規則（依 §4 結果二選一）

規則**預先承諾**如下，數字回填後直接對照採用，不再重新討論：

### 判定條件 A — `created_at` 可用

**成立條件：**① 的「沒有時間戳」為 **0**，且 ② 至少能看出 **2 個以上**分離的時間叢集。

**採用規則：**

1. 取出 `tags LIKE '%讀書計劃%'` 的任務（含 `deleted=1`，排除 ③ 的誤判集合）
2. 依 `created_at` 排序，**相鄰間隔 > 5 分鐘**即切為新 cluster
   （批次內部橫跨數秒，正常使用不會在 5 分鐘內連續建立兩份計畫）
3. 每個 cluster **再依 `list_id` 細分**——舊資料一次生成本來就會跨科，
   而 Phase 2 的 Plan 雖然允許跨科，但舊資料無從得知使用者原本的意圖，
   拆到科目粒度比硬湊成一個跨科 Plan 更貼近當時的實際使用
4. 每個 (cluster, list_id) → 一個 Plan
   - `name` = `{科目名}｜{書名}`（決策 4）
   - `start_date` / `target_date` = 該組 `MIN/MAX(due_date)`（決策 5）
   - `status` = 全部完成 → `completed`；否則 → `active`
   - `source` = `legacy_migration`
   - `deadline_date` **不設定**

### 判定條件 B — `created_at` 不可用

**成立條件：**① 有 NULL/空值，或 ② 只看得出單一叢集（無法分辨世代）。

**採用規則（fallback）：**

1. 每個 `list_id` 建立**一個** `legacy_migration` Plan
2. `name` = `{科目名}｜{書名}`（同一科多本書時，書名以「、」串接前 3 本）
3. 日期同決策 5
4. 文件必須明記：**此為降級結果，非 domain rule**

### 兩種條件都適用的規則

- ③ 的誤判集合（含「｜」但無標籤）**一律不自動 migrate**，`plan_id` 留 NULL，
  另外產出清單供人工檢視
- 既有 Task 的 `id / title / list_id / tags / due_date / completed / completed_at / deleted`
  **一律不得修改**，只補 `plan_id`
- 舊的 `讀書計劃` tag **暫時保留**，避免既有 UI／篩選器／匯出壞掉；
  等 Phase 2 穩定後再做 cleanup migration

---

## 6. Plan Domain Contract

### 6.1 Plan model

```ts
type PlanStatus = 'draft' | 'active' | 'completed' | 'archived';

interface Plan {
  id: number;
  user_id: number;
  name: string;
  description: string;
  goal_id: number | null;          // optional，Goal CRUD 可延後
  primary_list_id: number | null;  // 僅主要分類／顯示，非 identity
  start_date: string | null;       // YYYY-MM-DD
  target_date: string | null;      // YYYY-MM-DD
  status: PlanStatus;
  source: 'manual' | 'ai' | 'legacy_migration' | 'import';
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
}
```

**必要欄位**：`id`、`user_id`、`name`、`status`、`created_at`、`updated_at`。其餘皆可選。

**Plan 不儲存**：

| 不存什麼 | 為什麼 |
|---|---|
| `progress_percent` | 由底下 Task 推導，存一份就會不同步 |
| `scheduled_start` / `scheduled_end` | 那是 Schedule domain，不是 Plan domain |

### 6.2 關係

```
Goal   1 ──── 0..N Plan        （Goal optional）
Plan   1 ──── 0..N Task        （Task 可以沒有 Plan）
Task   1 ──── 0..N ScheduledBlock
Task   1 ──── 0..N StudySession
```

- `Plan → 0..1 Goal`
- `Task → 0..1 Plan`：「明天帶講義」「買筆」這種不該被迫塞進某個 Plan
- `list_id` 表示「這是哪一科／分類」，`plan_id` 表示「這件事屬於哪個具體計畫」，兩者不可互相取代

### 6.3 Lifecycle

```
draft     → active
active    → completed
active    → archived
completed → archived
archived  → active      （僅使用者明確恢復時）
```

- **Plan completed ≠ 所有 Task 都 `completed=1`**：可能有 Task 被取消或排除。
  完成 Plan 時應先檢查 unresolved tasks，由使用者確認
- **Archive ≠ delete**，歷史保留
- Phase 2 **不提供 hard delete Plan**。未來若提供，必須是
  `tasks.plan_id → NULL`，**不得 cascade delete Task**

### 6.4 Plan mutation ≠ Schedule mutation

| 修改 | 是否觸發 schedule feasibility check |
|---|---|
| `start_date` / `target_date` / `status` | ✅ 要 |
| `name` / `description` | ❌ 不要，也不得產生新的 Schedule Version |

### 6.5 Schedule model

```ts
interface ScheduleVersion {
  id: number;
  user_id: number;                 // ← user-level，不是 Plan 的 child
  version_no: number;
  parent_version_id: number | null;
  reason: string;
  source: 'initial' | 'ai_replan' | 'restore' | 'manual';
  created_at: string;
}

interface ScheduledBlock {
  id: number;
  user_id: number;
  schedule_version_id: number;
  task_id: number;                 // ← Plan 由此間接取得
  date: string;
  start_time: string | null;
  end_time: string | null;
  planned_minutes: number | null;
}
```

**為什麼 ScheduleVersion 掛 user 而不是 Plan**：同一天可能同時在排段考 Plan、社團 Plan、
Python Plan。掛單一 Plan 的話跨 Plan 排程立刻出問題。
需要知道影響哪些 Plan 時，由 ScheduledBlock → Task → Plan 推導，
或另存 `affected_plan_ids`。

**為什麼 ScheduledBlock 不存 `plan_id`**：避免「Task 改了 Plan，但 Block 還記著舊 Plan」
這種 duplication。除非日後 profiling 證明需要 denormalization，否則不加。

### 6.6 Lock model

```ts
type LockType = 'task' | 'time' | 'day';

interface ScheduleLock {
  id: number;
  user_id: number;
  type: LockType;
  task_id: number | null;      // task lock 才有
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  created_at: string;
}
```

- Lock 是 **Scheduling domain，不是 Plan 的 child entity**
- Task Lock → Task → Plan 自然可得；Time / Day Lock 限制的是整體排程，不屬於任何 Plan
- **Lock 是 Hard Constraint：AI／排程引擎永遠不得自動刪除或繞過**

### 6.7 Study Session

現有 `pomo_sessions`（`user_id / task_id / date / minutes`）本質上已接近 Study Session。

```
StudySession → Task → Plan      （不 duplicate plan_id）
```

`task_id` 可為 NULL＝自由讀書紀錄；只有帶 `task_id` 的 session 能精確歸屬 Plan。

**ScheduledBlock ＝ 計畫要在什麼時候做；StudySession ＝ 實際做了什麼、多久。兩者不可混用。**

---

## 7. REST API

沿用專案既有的 Express + `requireAuth` + `/api` resource route 風格（同 `fixed_events`），不另造 RPC。

### `GET /api/plans`

Query：`status?`、`includeArchived?`

```json
[{
  "id": 12,
  "name": "第二次段考準備",
  "description": "",
  "goal_id": null,
  "primary_list_id": null,
  "start_date": "2026-08-17",
  "target_date": "2026-09-10",
  "status": "active",
  "source": "manual",
  "created_at": "...", "updated_at": "...",
  "completed_at": null, "archived_at": null,
  "task_count": 18,
  "completed_task_count": 7
}]
```

### `POST /api/plans`

驗證：`name` 必填｜`status` 須為合法 enum｜兩個日期都有時 `target_date >= start_date`｜
引用的 Goal / List 必須屬於當前使用者。

### `GET /api/plans/:id`

```json
{
  "plan": { },
  "tasks": [ ],
  "summary": {
    "total_tasks": 18, "completed_tasks": 7,
    "remaining_tasks": 11, "overdue_tasks": 2
  }
}
```

### `PATCH /api/plans/:id`

允許修改：`name`、`description`、`goal_id`、`primary_list_id`、`start_date`、`target_date`、`status`

Server 自有（客戶端不得指定）：`user_id`、`created_at`、`updated_at`、`completed_at`、`archived_at`、`source`

規則：

- `status=completed` → 設 `completed_at`；離開 completed → 清除
- `status=archived` → 設 `archived_at`；離開 archived → 清除
- 日期／狀態變更必須暴露給 scheduling layer 做 feasibility check
- 只改 `name` / `description` **不得**產生 Schedule Version

### 語意化端點

| 端點 | 行為 |
|---|---|
| `POST /api/plans/:id/complete` | 應回傳 unresolved tasks 供前端確認 |
| `POST /api/plans/:id/archive` | 封存但不刪 Task |
| `POST /api/plans/:id/restore` | archived → active |

### Task API 擴充

`POST /api/tasks`、`PATCH /api/tasks/:id` 接受 `plan_id`：

- `null` 合法
- 引用的 Plan 必須屬於當前使用者
- 指派到 archived / completed 的 Plan 應拒絕，除非日後有明確的產品決策

---

## 8. Phase 2 Schema

一次建齊，避免 Phase 2.5 又重構。功能可以後開，表先建好。

```sql
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  goal_id INTEGER,
  primary_list_id INTEGER,
  start_date TEXT,
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS schedule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  parent_version_id INTEGER,
  reason TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'initial',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduled_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  schedule_version_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  planned_minutes INTEGER
);

CREATE TABLE IF NOT EXISTS schedule_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  task_id INTEGER,
  date TEXT,
  start_time TEXT,
  end_time TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

欄位補丁（冪等，同既有風格）：

```js
try { await client.execute("ALTER TABLE tasks ADD COLUMN plan_id INTEGER"); } catch {}
try { await client.execute("ALTER TABLE tasks ADD COLUMN deadline_date TEXT"); } catch {}
```

---

## 9. 過渡期相容

讀取優先順序：

```
task.plan_id 有值          → 使用正式 Plan
task.plan_id 為 NULL       → 普通無 Plan Task
（僅 legacy fallback UI）   → 才使用舊 isPlanTask heuristic
```

Phase 2 起的排程精靈**必須直接建立 Plan 記錄並指派 `task.plan_id`**，
不得再靠 title / tag 讓前端猜。

前端 `client/src/tt/plans.js` 的 `usePlans()` 推導必須改成讀 API；
舊 heuristic 只能留在明確標示的相容路徑後面。

---

## 10. Phase 2 開工檢查清單

- [ ] 在正式 Turso 上跑完 §4 的三個查詢，回填數字
- [ ] 依 §5 判定採用條件 A 或 B，把結果寫回本文件
- [ ] 建 §8 的四張表 ＋ 兩個欄位補丁
- [ ] 實作 §7 的 Plan CRUD
- [ ] 執行 §5 的 legacy migration，產出誤判清單供人工檢視
- [ ] 前端 `usePlans()` 改讀 API
- [ ] 排程精靈改為建立 Plan ＋ 指派 `plan_id`
- [ ] `cd server && npm test`（26 項）、`cd client && npm test`（18 項）、`npm run build` 全綠
