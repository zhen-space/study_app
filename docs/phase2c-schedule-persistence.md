# Phase 2C：Schedule Persistence

> 狀態：**2C-1 已定案，尚未實作。** 2C-2 之後尚未設計。
> Plan domain 契約另見 [`phase2-plan-domain.md`](phase2-plan-domain.md)。
> 基準 commit：`32fed0e`（Phase 2A 合併後）
> 最後更新：2026-08-16

---

## 0. 這個階段在解決什麼

Phase 2A 建立了正式 Plan domain，但留下一個**已知的架構破口**：

`scheduled_blocks` 表建好了卻是空的，Plan Task 的時間仍然只存在 `tasks.due_date`。
這是 `phase2-plan-domain.md` §5B 2A-1 明載的**有期限過渡例外**。

Phase 2C 的任務就是關掉它。2C 完成時，該例外連同那段文字一起刪除。

### 子階段

| | 內容 | 狀態 |
|---|---|---|
| **2C-1** | ScheduleVersion / ScheduledBlock schema、active version 契約、bootstrap | ✅ **已定案**（本文件 §1–§8） |
| **2C-2** | 版本恢復（restore）＋ feasibility | ⬜ 未設計 |
| **2C-3** | Lock 持久化 | ⬜ 未設計 |
| **2C-4** | 重排 diff（moved / added / removed） | ⬜ 未設計 |

---

## 1. 核心架構

```
ScheduleVersion = 某個時間點，使用者「未來排程」的一份 immutable snapshot
ScheduledBlock  = 隸屬某個 ScheduleVersion 的實際任務配置
```

**舊版本的 block 永遠不能被更新。** 任何真正的排程改變都產生新版本。

```
V1 初始排程
├─ 8/17 數學
├─ 8/17 英文
└─ 8/18 化學
        │  數學未完成 → 重排
        ▼
V2
├─ 8/17 英文
├─ 8/18 數學
└─ 8/18 化學

V1 永遠保留。
```

### 1.1 不變式

| # | 不變式 |
|---|---|
| 1 | **ScheduleVersion 是 immutable future-schedule snapshot**，建立後不得修改 |
| 2 | **ScheduledBlock 是 Plan Task 排定時間的唯一 source of truth** |
| 3 | **ScheduledBlock 只能指向 Task，不得直接指向 Plan**（延續 Plan domain §1-3，避免 `plan_id` duplication） |
| 4 | **`due_date` 永遠只能 block → task 單向鏡射**，絕不反向 |
| 5 | **Plan Task 沒有 active block ＝ unplaced**，`due_date` 必為 NULL |
| 6 | **ScheduleVersion metadata ＋ 全部 blocks ＋ active pointer 切換必須 atomic** |

---

## 2. Schema

三張表在 Phase 2A 已建立（`CREATE TABLE IF NOT EXISTS`，目前是空的），
2C-1 補欄位與索引。一律沿用 `init.js` 冪等 `try-ALTER` 風格。

### 2.1 `schedule_versions`

```sql
-- 2A 既有：id, user_id, version_no, parent_version_id, reason, source, created_at
ALTER TABLE schedule_versions ADD COLUMN effective_from TEXT;      -- 這一版涵蓋哪一天起
ALTER TABLE schedule_versions ADD COLUMN block_count INTEGER DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sv_user_no ON schedule_versions(user_id, version_no);
```

`source` enum：`bootstrap | initial | manual | ai_replan | restore`

`block_count` 是**刻意的冗餘**。版本列表要顯示「這一版有幾項」，不該為此對每一版 count blocks。
它是 immutable snapshot 的屬性，寫入後永不改變，所以不會有不同步問題
（與 Plan 的 progress 不同——那個會隨任務完成而變，所以不存）。

### 2.2 `scheduled_blocks`

```sql
-- 2A 既有：id, user_id, schedule_version_id, task_id, date, start_time, end_time, planned_minutes
ALTER TABLE scheduled_blocks ADD COLUMN task_title_snapshot TEXT;
ALTER TABLE scheduled_blocks ADD COLUMN subject_name_snapshot TEXT;
CREATE INDEX IF NOT EXISTS idx_sb_version_date ON scheduled_blocks(schedule_version_id, date);
CREATE INDEX IF NOT EXISTS idx_sb_task ON scheduled_blocks(task_id);
```

**兩個 snapshot 欄位不是第二份 domain identity**（見 §5）。

**不加** `UNIQUE(schedule_version_id, task_id)`。目前生成器保證一個任務在一版裡只有一個
block，但那是**生成器的不變式，不是 schema 的**——之後若要支援「一個任務拆成兩段時間」，
schema 不該擋路。這條由測試守。

### 2.3 `user_schedule_state`（新表）

```sql
CREATE TABLE IF NOT EXISTS user_schedule_state (
  user_id INTEGER PRIMARY KEY,
  active_version_id INTEGER,
  last_replan_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

獨立成表而不是塞進 `users`，因為之後還會放 `planning_mode` / `timezone` 之類的排程狀態。

只放現在真的會用到的三欄。有了獨立的表，加欄位是一行 `try-ALTER`；
先塞進去反而是憑空猜規格。

---

## 3. Snapshot 的邊界

**一個版本只涵蓋 `effective_from` 當天起的 blocks，不含過去。**

版本建立時若把昨天的 blocks 一起複製進來，等於讓「歷史」變成可被新版本改寫的東西，
直接與「恢復不能改歷史」衝突。過去不進 snapshot，歷史就**在結構上**不可改，
而不是靠 restore 時的規則去擋。

### 代價（必須知道）

「8/10 那天原本排了什麼」這種歷史查詢，不能只讀 active version，要往回找當時生效的版本。

**2C-1 明確不做這件事。** 歷史顯示目前走 `tasks.due_date` ＋ 完成狀態 ＋ `pomo_sessions`，
那條路徑不受影響、繼續用。2C-1 只負責**現在與未來的排程**與**版本恢復**。

歷史排程查詢是 2C-2 之後的獨立題目，不混進來。

---

## 4. Active version 契約

### 4.1 怎麼找

```
user_schedule_state.active_version_id
```

**單一來源，不做 fallback 推導。** 不用「取 `version_no` 最大的那一版」當備援——
那會讓 restore（把 active 指回舊版）行為錯亂。

沒有 state 列或 `active_version_id IS NULL` ＝ **這個使用者還沒有持久化排程**，
讀取端一律走 legacy 路徑（`tasks.due_date`）。這是 2A→2C 的正常過渡狀態，不是錯誤。

### 4.2 切換 active 是唯一會改變「現在的排程」的動作

建立版本本身不改變任何東西。流程一律是：

```
① 建立 version metadata
② 寫入全部 blocks
③ 切換 active_version_id
④ 同步 due_date 鏡射
```

**四步必須在同一個交易裡**（見 §7）。

### 4.3 `due_date` 鏡射（正式關掉 2A-1 過渡例外）

active 切換後，對該版本涵蓋的每個 Plan Task：

```
task.due_date  ← block.date
task.due_time  ← block.start_time     （timed 模式才有）
```

**單向，永遠 block → task。**

### 4.4 Unplaced 是正式狀態

> **對 Plan Task，只要 active ScheduleVersion 裡沒有對應的 ScheduledBlock，
> `tasks.due_date` 必須設為 NULL。**

```
有 active block  → block.date → task.due_date
沒有 active block → task.due_date = NULL
```

**不得保留舊值。** 保留就等於讓 `due_date` 變回「沒有 block 背書的第二個排程真相」，
2C 就白做了。

UI **必須明確承認 unplaced 是正式狀態，不是資料缺失**：

```
此計畫還有 3 項尚未排入行程
```

非 Plan Task 的 `due_date` 不受本節影響，語意完全不變。

---

## 5. 歷史 block 不因 Task 刪除而消失

若舊版本裡的 block 在任務被硬刪後只留下 orphan、讀取時濾掉，會產生一個矛盾結果：

> 資料庫 technically immutable，但使用者查看 V12 時，那個項目憑空不見了。

那還是破壞了「歷史版本」的語意。

**正式規則：ScheduledBlock 永遠保留，並保存最小的 display snapshot。**

```
block → task → plan            正常情況

block.task_id 找不到對應 task  → 歷史畫面改用 snapshot 顯示
                                 可標示「已刪除的任務」，但仍顯示：
                                 數學講義 Ch.3｜8/20 16:00–17:00
```

`task_title_snapshot` / `subject_name_snapshot` 回答的是
**「建立這個版本當下，這個 block 顯示的是什麼？」**——是顯示用的歷史留影，
不是 domain identity。**仍然不 duplicate `plan_id`**（不變式 §1-3 不變）。

### 5.1 連帶規則：優先軟刪除

> **Phase 2C 起，一般使用者刪除 Task 一律走 soft delete（`tasks.deleted = 1`）。
> Hard delete 只保留給 legacy cleanup / maintenance 等特殊流程。**

`tasks.deleted` 早就存在，沒必要讓一般刪除繼續製造 orphan block。

⚠️ **實作時要處理的既有衝突**（2C 實作的必辦項目）：

| 端點 | 現況 | 2C 要怎麼辦 |
|---|---|---|
| `DELETE /api/tasks/:id` | 預設軟刪除，`?hard=1` 才硬刪 | ✅ 已符合 |
| `DELETE /api/plans/:id/tasks?incomplete=1` | **硬刪除** | 要改成軟刪除，或明確認定為 maintenance 流程 |
| `DELETE /api/plan-tasks`（legacy） | **硬刪除** | legacy-only，維持現狀但不得被新流程呼叫 |

Phase 2A 建立的 Plan-scoped 刪除目前是硬刪，實作 2C 時必須先解決這一項，
否則重新排程會持續製造 orphan block。

---

## 6. 什麼行為產生新版本

| 行為 | 新版本 | `source` |
|---|---|---|
| 2A → 2C 第一次搬移 | ✅ | `bootstrap` |
| 排程精靈產生正式排程 | ✅ | `initial` |
| AI／使用者要求重排 | ✅ | `ai_replan` |
| 恢復舊版本 | ✅（新版本，不是回寫） | `restore` |
| 手動移動已排定的任務 | ✅ | `manual` |
| **固定行程／課表變更** | ❌ | — |

### 6.1 手動單筆調整也開新版本

拖 10 次＝10 版。替代方案是引入「可變的暫存版本」，但那等於在 immutable 模型上挖一個洞，
之後所有 restore / diff 邏輯都要處理這個特例。

**版本很便宜（一列 metadata ＋ 一批 blocks），洞很貴。**
UI 用 `source` 過濾，預設只顯示重排。

### 6.2 固定行程變更不自動產生版本

> **Calendar truth changed ≠ Schedule automatically changed.**

改課表就自動搬動任務，是在使用者沒同意的情況下改他的計畫。
正確做法是標記「排程可能需要調整」，直到使用者真的接受重排才建立新版本。

那個標記怎麼算、放哪裡，屬於 **2C-2（feasibility）**。

---

## 7. 交易邊界與併發

### 7.1 建立 ScheduleVersion 是 transaction boundary

**ScheduleVersion metadata ＋ 全部 ScheduledBlocks ＋ active pointer 切換
必須是一個 atomic operation。**

絕不能發生：

```
V12 建好了
  ↓
blocks 寫到一半失敗
  ↓
user_schedule_state 已經指向 V12
```

這比版本重號嚴重得多——使用者會看到一份殘缺的排程，而且沒有任何跡象顯示它是壞的。

專案既有的 `q.batch()` 就是單一交易，實作時整批一起送。

### 7.2 `version_no` 併發

```sql
CREATE UNIQUE INDEX idx_sv_user_no ON schedule_versions(user_id, version_no);
```

建立版本的流程：

```
1. 讀取 MAX(version_no) + 1
2. 嘗試 transaction 建立 version + blocks + 切換 active
3. 若唯一鍵衝突
4. 重新讀取 MAX + 1
5. bounded retry，最多 3 次
6. 仍失敗 → 整筆操作失敗，不建立半套 ScheduleVersion
```

不是只重試一次——競爭來源不只兩個分頁，還有 Web ＋ 手機、AI 重排 ＋ 手動操作、
請求重送。**最壞情況是慢一點並回報失敗，絕不是產生半套版本。**

---

## 8. Cutover bootstrap（2A → 2C）

第一次需要版本而 `user_schedule_state` 是空的時候：

- 建立 V1
- `source = 'bootstrap'`（專用值，不跟 `initial` 混用）
- `parent_version_id = NULL`
- `reason` 固定寫：**「從既有 due_date 建立的初始快照，不代表原始排程歷史」**

### 8.1 哪些 Plan Task 會變成 block

```
Plan Tasks
├─ 有 due_date 且 date >= 今天  → 建立 V1 的 ScheduledBlock
├─ 沒有 due_date                → unplaced（不建立 block）
└─ due_date 在過去              → 不建立 block（見下）
```

**過去的 `due_date` 不補成 block**——那會憑空捏造從未存在過的排程歷史。

**沒有 `due_date` 的 Plan Task 不會因此消失**，它成為正式的 unplaced 狀態
（§4.4），只是沒有 ScheduledBlock。

沒有 Plan 的一般任務不進 blocks——它們本來就不歸排程管。

`source='bootstrap'` 讓任何人查版本歷史時一眼看得出「V1 不是真的排程，是搬過來的」。

---

## 9. 已知的擴充性問題（retention policy pending）

**Phase 2C 採用：所有版本永久保存，不設上限。**

現在連真實使用者一個月會產生幾版都不知道，直接訂「保留最近 50 版」只是拍腦袋，
而且會製造一個更麻煩的問題：

```
V80 是 restore from V12，但 V12 已經被清掉
```

### 要觀察的三個數字

有真實資料之後才決定要不要處理，以及怎麼處理：

| 指標 | |
|---|---|
| versions per user / month | 手動拖曳會不會讓版本數暴增 |
| blocks per version | 大計畫的單版大小 |
| schedule storage per active user | Turso 配額壓力 |

### 可能的處理方向（現在不要提前優化）

- 壓縮舊版本
- 只保存 diff
- snapshot ＋ delta 混合
- retention policy

> **這是正式列管的 Known scalability concern，不是被忽略的問題。**

---

## 10. 2C-1 不做的事

- 版本恢復的實際邏輯 → **2C-2**
- feasibility（排程是否仍可行、固定行程變動後的標記）→ **2C-2**
- Lock 持久化與版本化 → **2C-3**（傾向 Lock 不隨版本回滾，理由屆時再定）
- 重排 diff（moved / added / removed）→ **2C-4**
- 歷史排程查詢（§3 說明的取捨）
- **排程演算法本身完全不動** —— 2C-1 只是把它算出來的結果持久化

---

## 11. 2C-1 實作檢查清單（尚未開始）

- [ ] `schedule_versions` 兩個欄位 ＋ 唯一索引
- [ ] `scheduled_blocks` 兩個 snapshot 欄位 ＋ 兩個索引
- [ ] `user_schedule_state` 建表
- [ ] 建立版本的 atomic 流程（§7.1）＋ bounded retry（§7.2）
- [ ] active version 解析與 `due_date` 單向鏡射（§4）
- [ ] unplaced 規則：沒有 block 的 Plan Task `due_date = NULL`（§4.4）
- [ ] UI 顯示 unplaced 數量（§4.4）
- [ ] bootstrap（§8）
- [ ] **先解決 §5.1 的硬刪除衝突**，否則會持續製造 orphan block
- [ ] 測試：immutability（舊版 block 不可改）、atomic 失敗不留半套、
      併發不重號、unplaced → NULL、bootstrap 不捏造過去、
      block 只指向 Task、task 硬刪後歷史版本仍顯示得出來
- [ ] 2C 全部完成後，**刪除 `phase2-plan-domain.md` §5B 2A-1 的過渡例外**
