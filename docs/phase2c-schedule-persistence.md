# Phase 2C：Schedule Persistence

> 狀態：**2C-1、2C-2、2C-3、2C-4 全部已定案，尚未實作。**
> Plan domain 契約另見 [`phase2-plan-domain.md`](phase2-plan-domain.md)。
> 基準 commit：`32fed0e`（Phase 2A 合併後）
> 最後更新：2026-08-17

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
| **2C-2** | 版本恢復（restore）＋ feasibility | ✅ **已定案**（§12–§19） |
| **2C-3** | Lock 持久化 ＋ feasibility 整合 | ✅ **已定案**（§22–§31） |
| **2C-4** | 重排 diff ＋ stale preview protection | ✅ **已定案**（§33–§49） |

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

它們有兩個用途，都只跟「顯示」有關：

1. 任務被刪掉之後，歷史版本仍然看得懂當時排了什麼
2. diff 的顯示來源（2C-4 §35）

> **identity 永遠是 `task_id`。** diff 的比對、restore 的對應、lock 的判定，
> 一律不得用 snapshot 標題或科目名去猜——那正是 Phase 2B 一路拔掉的東西。

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

### 4.4.1 已完成 Plan Task 的歷史鏡射例外

已完成的 Plan Task 不屬於 active future schedule。即使 active version 沒有 block，
也**不得**清除其既有 `due_date` / `due_time`：這兩欄在此時是歷史顯示相容資料。

> active ScheduledBlock mirror 只治理**未完成、未刪除**的 Plan Task；completed Plan Task
> 不因 active version 缺 block 而被清空。

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
| `DELETE /api/plans/:id/tasks?incomplete=1` | **硬刪除** | ✅ **已裁決：改成軟刪除**（見 §5.2） |
| `DELETE /api/plan-tasks`（legacy） | **硬刪除** | legacy-only，維持現狀但不得被新流程呼叫 |

### 5.2 裁決：Plan-scoped 刪除改為軟刪除

> **重新排程是正常使用者流程，不是 maintenance。正常流程就不該破壞歷史版本的可讀性。**

```
Plan-scoped remove incomplete tasks
  → tasks.deleted = 1
  → 不 hard delete
  → 舊 ScheduledBlock 保留
  → 歷史版本仍可用 snapshot 顯示
```

舊的 `DELETE /api/plan-tasks` 可以繼續維持 hard delete，但必須**真的只剩 legacy-only**，
2C 新流程永遠不得呼叫它。

### 5.3 ⛔ Implementation prerequisite（不是可選項）

> **在第一個 ScheduledBlock 真正寫入 production 之前，
> 必須先把 Plan-scoped incomplete delete 改成 soft delete。**

順序反過來的話，每次重新排程都會製造一批指向已消失任務的 block，
而 §5 剛規定歷史 block 必須留著——等於一上線就開始累積無法修復的髒資料。

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

那個標記怎麼算、放哪裡，見 **§18（feasibility）**。

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

### 7.2.1 ⚠️ 兩種併發衝突長得像，處理方式相反

同一個 transaction 裡會遇到兩種衝突，**絕對不能用同一套處理**：

| 衝突 | 意思 | 處理 |
|---|---|---|
| `version_no` 唯一鍵衝突 | 只是號碼被別人先用走了 | **bounded retry**：重讀 MAX+1 再試 |
| `base_version_id` 不符（2C-4 §38） | 使用者看到的排程已經不是現在的排程 | **絕對不可 retry**，直接 409 |

差別在於「使用者看到的東西還算不算數」。

號碼衝突不影響語意——candidate 的內容沒變，換個號碼寫進去就好。
但 `base_version_id` 不符表示**世界在 preview 之後被改過了**：使用者當初看到的 diff
是拿 V5 算的，現在已經是 V6。這時候 retry 等於「把他沒看過的變更靜默套用下去」。

> 實作時最容易寫錯的地方，就是把兩者一起塞進同一個 `catch` 然後一律重試。
> 正確做法是分開判斷：號碼衝突重試，stale base 直接往上拋 409。

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
- 重排 diff（moved / added / removed）→ **2C-4**（§33–§49，已定案）
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
- [ ] ⛔ **先做 §5.3 prerequisite**：Plan-scoped incomplete delete 改成軟刪除
      （必須早於第一個 ScheduledBlock 寫入 production）
- [ ] 測試：immutability（舊版 block 不可改）、atomic 失敗不留半套、
      併發不重號、unplaced → NULL、bootstrap 不捏造過去、
      block 只指向 Task、task 硬刪後歷史版本仍顯示得出來
- [ ] 2C 全部完成後，**刪除 `phase2-plan-domain.md` §5B 2A-1 的過渡例外**

### 2C-2 追加（見 §12–§21）

- [ ] `schedule_versions` 增補 `restored_from_version_id`（§12.1）
- [ ] `GET /api/schedule/versions/:id/restore-preview`
- [ ] `POST /api/schedule/versions/:id/restore`（執行時重新驗證，§19.4）
- [ ] 六種衝突判定 ＋ 兩層 feasibility（§13、§17）
- [ ] 測試：restore 不啟用舊版而是產生新版、過去／已完成／已刪除被 skip、
      Lock 與固定行程優先、**新增的 Task 不被 restore 弄不見**、
      `nothing_to_restore` 不建立版本、preview 過期時不默默照做
- [ ] ⚠️ 注意 §21 的實作相依：Lock 檢查需要 2C-3

---
---

# Part 2：2C-2 — Restore ＋ Feasibility

> 狀態：**已定案，尚未實作。**

---

## 12. Restore 的本質

> **Restore 不是「把 `active_version_id` 指回舊版」。**
>
> Restore 是：**拿舊版當「目標模板」，用現在世界的 hard constraints 驗證後，
> 產生一個新的 ScheduleVersion。**

```
現在 active = V3
使用者選「恢復 V1」
  → 讀 V1 當模板
  → 用現在的世界驗證
  → 產生 V4（source = restore）

不是：active_version_id = V1
```

理由：V1 是**過去某一刻**對未來的安排。現在的世界已經不同了——時間過去了、
任務完成了、課表改了、鎖加上去了。直接啟用 V1 會讓使用者的排程回到一個
**已經不成立**的狀態。

### 12.1 版本血緣：兩個不同的欄位

Restore 產生的 V4，`parent_version_id` 該指誰？V3（前一版）還是 V1（模板）？

**兩個都要記，但語意不同。** 建議增補：

```sql
ALTER TABLE schedule_versions ADD COLUMN restored_from_version_id INTEGER;
```

| 欄位 | 語意 |
|---|---|
| `parent_version_id` | **血緣**：這一版接在誰後面 → V3 |
| `restored_from_version_id` | **模板**：這一版是照誰恢復的 → V1 |

只記其中一個都會壞事：只記 V1 → 版本鏈斷掉，「上一版是什麼」查不出來；
只記 V3 → 使用者看不出這版是從哪裡恢復的。

### 12.2 `effective_from`

> **Restore 產生的新版本，`effective_from` 是「操作當下的 planning day」，
> 不是舊版的 `effective_from`。**

今天 8/17 恢復 8/10 建立的版本 → V4 的 `effective_from = 8/17`，不能寫 8/10。
V4 是今天產生的新未來 snapshot，不是把時間倒回去。

---

## 13. 六種衝突

### 13.1 過去時間

```
block 已經過去 → 永遠不可恢復
```

判定分兩種模式（**目前排程有 timed 與非 timed 兩種，規則不同**）：

| 模式 | 判定 |
|---|---|
| **timed**（有 `start_time` / `end_time`） | `block.end <= now` → 不可恢復 |
| **非 timed**（只有 `date`） | `block.date < 今天` → 不可恢復；`block.date == 今天` → **可以恢復**（今天還沒過完） |

**跨過現在的 timed block（例如 15:30–16:30，現在 16:00）整段視為不可恢復。**

不能偷偷截成 16:00–16:30——那已經不是原本那個 block 了。Restore 的語意是
「把原安排放回去」，截斷就變成了另一種安排。

`type = 'past'`

### 13.2 任務已完成

```
task.completed = true → skip
```

**這不是 error，是「已經不需要恢復」。** UI 顯示：

```
1 項因已完成而略過
```

### 13.3 任務已刪除或不存在

```
task 已軟刪除，或 task_id 找不到對應資料 → skip
```

**Restore 是恢復 schedule，不是復活 domain entity。**
即使只剩 `task_title_snapshot`，也**不得**據此重新建立 Task。

歷史畫面仍可用 snapshot 顯示（§5），但那是「看得到」，不是「拿得回來」。

### 13.4 現在的 Lock 衝突

> Lock 的完整契約見 **§22–§31**。以下只是 restore 視角的摘要。

```
V1 想把數學放 18:00–19:00
現在有 🔒 18:00–21:00
→ 不可恢復
```

**Lock 不隨 ScheduleVersion 回滾**（2C-3 定案方向）。
所以 **Restore 永遠服從「現在的」Lock**，這是 hard conflict。

`type = 'lock'`

### 13.5 現在的固定行程／課表衝突

```
V1：數學 18:00–19:00
現在：補習 18:00–21:00
→ 不可恢復
```

與 Lock 同屬 current-world hard conflict，但**來源必須分開**，因為 UI 解法不同：

- **Lock** → 可以提示使用者自行解鎖
- **固定行程** → 通常不能叫排程引擎把課表移開

`type = 'fixed_event'`

### 13.6 任務 constraint 已改變

**這一項最容易被漏掉。**

```
V1 當時：數學 deadline = 8/20，block 排在 8/19  ✅ 當時合法
現在：   數學 deadline 已改成 8/18
→ 即使 8/19 沒有撞任何東西，也不可恢復
```

同理，作息或可讀時段改變（原本可晚上讀，現在只能早上）→ 舊 block 的晚上時段也不可恢復。

> **Restore 必須服從「目前」的 Task / Plan / constraint 狀態，
> 不是舊版當時的 constraint snapshot。**
>
> 舊 constraint snapshot 只能用來**解釋歷史**，不能推翻現在的規則。

`type = 'task_constraint'` / `type = 'deadline'`

---

## 14. Restore 的三種結果

| 結果 | 條件 |
|---|---|
| **`full`** | 所有「仍有意義」的舊 block 都可恢復 |
| **`partial`** | 部分可恢復，部分有衝突 |
| **`impossible`** | 全部無法恢復，或恢復後整體排程明確無效 |

**被 skip 的（已完成、已刪除）不算失敗。**

```
10 個舊 block
 2 個已完成 → skip
 8 個全部可恢復
→ status = 'full'（恢復成功）
```

### 14.1 補一個邊界狀態：`nothing_to_restore`

上面的定義有個空隙：**10 個 block 全部因為已完成而 skip，restorable = 0，
conflicts = 0** —— 這算 `full` 還是 `impossible`？

按定義是 `full`（沒有衝突），但前端顯示「恢復成功」而畫面什麼都沒變，
使用者會以為壞掉了。

**建議增加第四種 status：**

```
'nothing_to_restore'   restorable = 0 且 conflicts = 0
```

UI 訊息：「這一版的內容都已經完成了，沒有需要恢復的項目。」
**不建立新版本**——沒有任何改變就不該產生版本。

### 14.2 `partial` 必須先 preview

`partial` **不得自動執行**。先給預覽：

```
可恢復 8 項
2 項無法恢復（列出原因）
```

使用者選「恢復可恢復的部分」，才建立新版本。

---

## 15. Partial restore 時，其他排程怎麼辦

**這是 2C-2 最容易做錯的地方。**

```
現在 active V3：        要恢復的 V1：
  數學 8/18               數學 8/17
  英文 8/19               英文 8/18
  化學 8/20             （V1 不知道有化學）
```

化學怎麼辦？

> **Restore 的目標不是「把 V1 的 blocks 疊在 V3 上」，
> 而是以 V1 作為 snapshot baseline，再套上現在的現實。**

```
Restored version =
      舊版本中可恢復的 blocks
    + 現在存在但舊版本不知道的 Task → unplaced（不是刪掉）
```

規則：

| 情況 | 處理 |
|---|---|
| 已完成 | 不排 |
| 已刪除 | 不排 |
| V1 有、現在仍有效 | 嘗試恢復原位置 |
| **V1 沒有、現在新加入的 Task** | **保留為 unplaced，不得刪除** |

最後一條特別重要——否則恢復 V1 會把後來新增的任務**莫名其妙弄不見**。

---

## 16. Restore 不自動重新最佳化

假設 V1 有兩個 block 撞到現在的補習。

**Restore 不得自己說「那我把它們搬到明天」。** 那就不是 restore 了。

> **Restore 只做一件事：判斷「原位置能不能保留」。**
> 不能保留的標為 **unplaced**。

之後使用者若點「幫我重新安排這 2 項」，才進入 AI replan，產生另一個版本：

```
V4  source = restore
    → 恢復能恢復的
    → 2 個任務 unplaced

V5  source = ai_replan
    → 才替那 2 個任務找新位置
```

語意乾淨：**restore 管「放回去」，replan 管「重新安排」，兩件事不混。**

---

## 17. Feasibility 分兩層

**不能只看 block collision。**

### 17.1 Block-level feasibility

逐一檢查舊 block 本身：

- 是否已過去（§13.1）
- 是否撞固定行程（§13.5）
- 是否撞 Lock（§13.4）
- 是否違反目前的 task constraint（§13.6）
- 任務是否已完成／已刪除（§13.2、§13.3）

### 17.2 Schedule-level feasibility

恢復**完之後**再整體檢查：

- 同一時間是否兩個 block 撞在一起
- 是否超過每日容量
- 是否讓某個 Task 超過 deadline
- 是否出現 constraint competition
- 是否出現 unplaced tasks
- 整體是否仍可完成

> **兩層必須分開。**
> 每一個 block 單獨都合法，**不代表**整份 restore 後的 schedule 有解。

### 17.3 非 timed 模式的特殊處理

非 timed 的 block 只有日期、沒有時間，所以**「撞固定行程」在 block-level 根本判斷不了**。

規則：

| 模式 | 「撞固定行程」在哪一層判斷 |
|---|---|
| timed | **block-level**（時間區間直接比對） |
| 非 timed | **schedule-level**（那天的可用時間總量是否還夠） |

實作時建議**復用既有能力**而不是重寫：`POST /api/schedule/preview` 回傳的
`check.subjects`（含 `availDays` / `wantDays`）已經在做類似的容量判斷。

---

## 18. Feasibility 標記（固定行程變更後）

§6.2 定了「固定行程變更不自動產生版本」，只標記「排程可能需要調整」。

該標記**不落庫**，改為**讀取時計算**：查 active version 的 blocks 與目前固定行程／Lock
是否衝突。理由：落庫就要維護失效時機（改課表、改鎖、改任務都要更新），
而這個判斷本來就很便宜。

若日後量測顯示太慢，再考慮把結果快取進 `user_schedule_state`。

---

## 19. 資料結構

### 19.1 `RestorePreview`

```ts
interface RestorePreview {
  source_version_id: number;          // 要恢復的舊版
  restorable_blocks: ScheduledBlock[];
  skipped_completed: number[];        // task_id
  skipped_deleted: number[];          // task_id
  conflicts: RestoreConflict[];
  unplaced_task_ids: number[];        // 恢復後會變成 unplaced 的（含新增的 Task）
  status: 'full' | 'partial' | 'impossible' | 'nothing_to_restore';
}
```

### 19.2 `RestoreConflict`

```ts
interface RestoreConflict {
  task_id: number;
  block_id: number;
  type: 'past'
      | 'fixed_event'
      | 'lock'
      | 'task_constraint'
      | 'schedule_collision'
      | 'deadline';
  message: string;                    // 繁中，直接給使用者看
}
```

`type` 分這麼細是為了讓前端能**真的解釋**發生什麼事，而不是只說「無法恢復」。
`lock` 可以提示解鎖、`fixed_event` 要改課表、`deadline` 要延期——三種解法完全不同。

### 19.3 API 形狀（建議）

```
GET  /api/schedule/versions/:id/restore-preview   → RestorePreview
POST /api/schedule/versions/:id/restore           → 新的 ScheduleVersion
```

### 19.4 ⚠️ Preview 會過期，執行時必須重新驗證

Preview 算完到使用者按下確認之間，世界可能已經變了——在另一個分頁完成了任務、
加了固定行程、上了鎖。

> **`POST .../restore` 不得信任 preview 的結果，必須重新完整驗證一次。**

「重新驗證」需要一個明確的判斷依據，不能只靠重算後憑感覺比對。
2C-4 §38 把它正式化成 **`base_version_id` 樂觀鎖**：preview 回傳當時的
`base_version_id`，apply 時帶回來，在 transaction 內用**條件式 UPDATE**
確認 active pointer 仍然是同一版；不符就回 409，**不得 retry**（§7.2.1）。

restore 與一般 apply 走同一套保護，沒有例外。

若重算結果與 preview 不同（可恢復數量變了、多了新衝突），**不要默默照做**，
回報差異並要求重新確認。

建立 restore version 一樣是 **atomic transaction**（§7.1），
一樣要 bounded retry（§7.2）。

---

## 20. 2C-2 定案總表

| # | 定案 |
|---|---|
| 1 | **Restore 永遠產生新 ScheduleVersion**，舊版只作 template，不重新啟用 |
| 2 | 過去、已完成、已刪除**不恢復** |
| 3 | 現在的 Lock、固定行程、Task constraint **永遠優先** |
| 4 | Restore **不自動移動**衝突的 block |
| 5 | 無法恢復的有效 Task → **unplaced** |
| 6 | 後來新增、舊版不知道的 Task **保留成 unplaced，不得刪除** |
| 7 | `partial` **必須先 preview**，由使用者確認 |
| 8 | Feasibility 分 **block-level** 與 **schedule-level** 兩層 |
| 9 | 建立 restore version 仍需 **atomic transaction** |
| 10 | `effective_from` = **操作當下**的 planning day，不是舊版的 |

### 本輪補充（設計時發現）

| # | 補充 |
|---|---|
| 11 | `parent_version_id`（血緣）與 `restored_from_version_id`（模板）**分開記** |
| 12 | 新增第四種 status **`nothing_to_restore`**，且不建立版本 |
| 13 | 「過去」的判定**分 timed / 非 timed**；跨過現在的 timed block 整段不可恢復 |
| 14 | 非 timed 的固定行程衝突只能在 **schedule-level** 判斷 |
| 15 | **Preview 會過期**，執行時必須重新驗證，結果不同要重新確認 |

---

## 21. 2C-2 實作相依（順序警告）

⚠️ **2C-2 的實作依賴 2C-3（Lock 持久化）。**

§13.4 要求 restore 檢查「現在的 Lock」，但 Lock 目前只有空表、沒有寫入路徑。

兩種可行順序：

- **建議**：實作順序改為 **2C-3 先於 2C-2**（契約順序不變）
- 或：2C-2 先實作，Lock 表為空時視為「無鎖」，並在 2C-3 完成後補測試

**契約定案的順序（2C-1 → 2C-2 → 2C-3 → 2C-4）不等於實作順序。**

---
---

# Part 3：2C-3 — Lock 持久化 ＋ Feasibility 整合

> 狀態：**已定案，尚未實作。**

---

## 22. 三個核心不變式

| # | 不變式 |
|---|---|
| **L1** | **Task Lock 是 identity-based constraint**——只存 `task_id`，**不存日期時間** |
| **L2** | **Time / Day Lock 是 schedule-space constraint**——是否仍有效**由目前時間推導** |
| **L3** | **所有 Lock 都是 Hard Constraint。** candidate schedule 違反任何有效 Lock，就**不能回傳 success** |

L3 展開成一句可以直接拿去寫測試的話：

> **任何 candidate schedule，只要讓有效 Task Lock 對應的 Task 被移動、拆改、
> 或變成 unplaced，該 candidate 必須被 feasibility 判為 hard conflict，
> 不得當作成功排程。**

Lock 是「使用者現在的意圖」，不是歷史 schedule snapshot 的一部分，所以：

```
ScheduleVersion = immutable schedule history
ScheduleLock    = current hard constraints
```

兩個 domain 分離。**Lock 不進 ScheduleVersion，也不隨 restore 回滾**（§26）。

---

## 23. Schema

2A 已建 `schedule_locks(id, user_id, type, task_id, date, start_time, end_time, created_at)`，
2C-3 只補兩個欄位與索引：

```sql
ALTER TABLE schedule_locks ADD COLUMN released_at TEXT;
ALTER TABLE schedule_locks ADD COLUMN release_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_locks_user_live ON schedule_locks(user_id, released_at);
CREATE INDEX IF NOT EXISTS idx_locks_task ON schedule_locks(task_id);
-- 同一個 task 同時只能有一個未釋放的 task lock
CREATE UNIQUE INDEX IF NOT EXISTS idx_locks_task_one
  ON schedule_locks(user_id, task_id) WHERE type='task' AND released_at IS NULL;
```

### 23.1 三種 type 的欄位使用是互斥的

| `type` | `task_id` | `date` | `start_time` / `end_time` |
|---|---|---|---|
| `task` | 必填 | **必須 NULL** | **必須 NULL** |
| `day` | 必須 NULL | 必填 | 必須 NULL |
| `time` | 必須 NULL | 必填 | 必填 |

Task Lock **不存日期時間**（L1）。存了就變成偽裝的 Time Lock，重排後會不知道該信哪一個。

⚠️ SQLite **不能對既有表加 CHECK constraint**（要整表重建）。表目前雖然是空的，
重建仍違背專案冪等 `try-ALTER` 的慣例。**改由 API 層驗證 ＋ 測試守住**，不動 schema。

---

## 24. 有效性：兩種 lifecycle，不共用欄位

> **這兩種 lifecycle 不要混成同一套欄位。**

### 24.1 Task Lock

```
effective(task lock) =
      released_at IS NULL          ← 使用者主動解鎖（實際寫入，不推導）
  AND task 存在
  AND task.deleted  = false
  AND task.completed = false
```

### 24.2 Time / Day Lock

```
effective(day lock)  = released_at IS NULL AND date >= 今天
effective(time lock) = released_at IS NULL
                       AND (date > 今天 OR (date = 今天 AND end_time > 現在))
```

### 24.3 為什麼完成／刪除用推導，而不是寫 `released_at`

**因為要可逆。**

如果任務完成就寫 `released_at`，使用者**取消完成**之後鎖不會回來——他原本的鎖定意圖
被不可逆地丟掉了。推導版本是對稱的：取消完成，鎖自動恢復效力；從垃圾桶還原，鎖也回來。

反過來，**使用者主動解鎖必須真的寫入**（`released_at` ＋ `release_reason='user'`），
不能靠推導——那是一個明確的意圖表達，必須留下紀錄。

保留列而不是硬刪除，是為了之後 debug「這個鎖後來怎麼了」。

### 24.4 關於 Plan archive

**不需要額外條款。** Plan 封存不刪任務、不清 `plan_id`，任務仍可能在 active version 裡，
所以鎖繼續有效是一致的：封存管的是 Plan 的生命週期，不是 Task 的排程。
Plan 之後恢復時，鎖也原封不動——正好符合「不要因為 context 改變就丟掉使用者設定」。

### 24.5 過期的 Day / Time Lock 不自動清除

查詢有效 constraints 時直接排除**已完全位於過去**的 Lock。管理頁預設只顯示有效的，
另提供「顯示過去的鎖定」。

**不要 cron，也不要 read-time mutation**——前者要多養一個排程器，後者會讓一次讀取
產生寫入副作用，兩個都比留著幾列無害的舊資料糟。

---

## 25. Task Lock 凍結的到底是什麼

Task Lock 鎖的是**該 Task 在 active ScheduleVersion 裡目前的整組 block 配置**。

未來若支援「一個 Task 拆成兩段時間」，鎖的是**整組 block set**，不是只鎖第一塊。

### 25.1 可比較的簽章

```
blockSignature(taskId, blocks) =
    該 task 的所有 block，取 (date, start_time, end_time, planned_minutes)，
    排序後的序列
```

**不能用 block id 比對**——每個版本都是新的資料列，id 必然不同。

非 timed 模式沒有時間欄位，簽章實際上只比 `date`。

### 25.2 基準是「評估當下的 active version」

不是建立 lock 當時的版本。這樣簽章自我更新，lock 也就不需要存位置（L1）。

---

## 26. 衝突判定

```
active    = blockSignature(taskId, activeVersionBlocks)
candidate = blockSignature(taskId, candidateBlocks)

candidate 為空          → LOCKED_TASK_UNPLACED   severity: hard
candidate ≠ active      → LOCKED_TASK_MOVED      severity: hard
candidate = active      → ok
```

`UNPLACED` 技術上是 `MOVED` 的特例，**但必須分開回報**——UI 的解法完全不同：
一個要延長範圍或解鎖，一個是位置被別的東西占走。

### 26.1 Time / Day Lock 的判定

| Lock | 凍結什麼 |
|---|---|
| **Time Lock** | 該時段**目前的 schedule slice**。原本空白 → 不准塞東西進來；原本有兩個 block → 那兩個不准動 |
| **Day Lock** | 整天的 **day snapshot**。原本有什麼不准搬，原本空的地方不准塞 |

**兩者都不是單純的 "unavailable"，而是 freeze。** 這點跟固定行程不一樣——
固定行程是「這段時間被占用」，Lock 是「這段時間現在長什麼樣，就維持什麼樣」。

衝突類型：`LOCKED_SLICE_CHANGED`（time）、`LOCKED_DAY_CHANGED`（day），皆為 `hard`。

### 26.2 ⚠️ 必須豁免已完成／已刪除的任務

**這一條不加，系統很快就會變成無法重排。**

Day Lock 鎖住 8/20，那天有三個任務。使用者**完成**其中一個 → 它的 block 合理地不該再出現。
若不豁免，之後**每一次重排都會被判 hard conflict**，因為「這天的內容跟鎖定當下不一樣了」。

所以三種 Lock 的比對都必須先排除：

```
task.completed = true
task.deleted   = true
```

與 2C-2 restore 的 skip 語意一致（§13.2、§13.3）。**完成一件事不該讓排程系統癱瘓。**

---

## 27. 建立 Lock 的前置條件（三種不一樣）

| type | 可否在「空的」狀態下建立 | 理由 |
|---|---|---|
| **task** | ❌ **不行** | Task Lock 的語意是「固定目前位置」，unplaced 的任務根本沒有位置可固定，會產生語意不完整的 constraint |
| **day** | ✅ **可以** | 「這天我要休息」＝ freeze empty day，**不准塞新東西進來**，這是有意義的 |
| **time** | ✅ **可以** | 同上，freeze 一段空白時段 |

這個不對稱是刻意的：**Task Lock 錨定在既有配置上，Day / Time Lock 錨定在時間本身。**

對 unplaced 任務建立 Task Lock，API 回 400：

```
這個任務尚未排入時間，請先安排後再鎖定
```

---

## 28. 使用者手動拖曳被鎖的 Task：禁止

> **被鎖 Task 的 active block set 永遠不變，直到使用者先解除 Task Lock。**

手動拖曳一個被鎖的任務 → **拒絕**，提示先解鎖。

允許的話會有兩個後果：

1. feasibility 必須判斷「是誰移動的」——等於把**意圖**耦合進本來純粹的比對邏輯
2. 鎖就再也擋不住任何東西，因為使用者隨時可以繞過

禁止之後，**AI 重排、手動拖曳、restore 三條路徑走完全相同的 feasibility 規則**，
不需要任何 provenance 判斷。這是這條規則真正的價值。

---

## 29. 🔴 與排程演算法的整合：事前釘住，不是事後驗證

`server/src/routes/schedule.js` 是純生成器——吃 items 產出 blocks，沒有任何 Lock 概念。

### 29.1 為什麼不能只做事後驗證

生成完再比對、違反就拒絕，會讓 Lock **實質無用**：排程演算法本來就會把所有項目
重新分配，任何一次重排幾乎必定移動被鎖的任務 → 每次重排都失敗。

使用者體驗會變成「我鎖了一個任務，然後就再也不能重排了」。
**那是把 Hard Constraint 降級成裝飾。**

### 29.2 採用：事前釘住 ＋ 事後驗證

**不改排程演算法內部**，只改組裝輸入的那一層：

```
① 被鎖任務不放進 items（不參與重新分配）
② 它們占用的日期／時段先從可用容量扣掉
③ 生成完，把被鎖任務的原 block 原樣併回 candidate
④ 再跑事後驗證當安全網
```

可以復用的既有機制：

| Lock | 復用什麼 |
|---|---|
| Day Lock | `excludeDates`（已存在） |
| Time Lock | `freeSlotsForDay()` 已經在為固定行程挖時段，走同一條路徑 |
| Task Lock | 該任務占用的日期／時段比照上面兩者扣掉 |

**改的是 caller，不是 algorithm**——符合 2C-1「排程演算法完全不動」的約束。

事後驗證仍然保留，作為安全網：釘住的邏輯若有 bug，寧可整批失敗，也不要靜靜地
產生一個違反 Lock 的版本。

---

## 30. 與 2C-2 Restore 的互動

Restore 想把任務放回舊版位置，但該任務現在被鎖住 → **鎖優先**。

```
被鎖任務不參與 restore，保持目前位置
舊版對它的安排不同 → RestorePreview 回報 type: 'lock'（2C-2 §19.2 已有此類型）
```

理由回到 §22：**Lock 是現在的意圖，ScheduleVersion 是過去的歷史。**
恢復歷史不該推翻現在的意圖。

---

## 31. 實作形狀

### 31.1 Pure module（開始拆 `schedule.js`）

新開 `server/src/schedule/locks.js`，匯出**不碰 DB 的純函式**：

```js
effectiveLocks(locks, tasks, now)             // 濾出目前真正有效的
blockSignature(taskId, blocks)                // 可比較的簽章
checkLocks(candidate, active, locks, tasks)   // → conflicts[]
```

好處有三個：

1. 可以單獨測，不用起伺服器
2. **2C-2 restore、2C-3 lock、之後的 AI replan 共用同一套 validator**
3. 這是 `schedule.js`（865 行）拆檔的第一塊——本來就在技術債清單上

比在 route 裡一路堆判斷式好得多。

### 31.2 衝突型別（併入 2C-2 §19.2）

```ts
type ConflictType =
  | 'past' | 'fixed_event' | 'lock' | 'task_constraint'
  | 'schedule_collision' | 'deadline'
  | 'LOCKED_TASK_UNPLACED'      // 被鎖任務在候選排程裡沒有位置
  | 'LOCKED_TASK_MOVED'         // 被鎖任務位置改變
  | 'LOCKED_SLICE_CHANGED'      // Time Lock 涵蓋的時段內容改變
  | 'LOCKED_DAY_CHANGED';       // Day Lock 涵蓋的整天內容改變
```

後四種一律 `severity: 'hard'`。

### 31.3 API 形狀（沿用既有 REST 風格）

```
GET    /api/schedule/locks              有效的（?includeExpired=1 才含過去的）
POST   /api/schedule/locks              建立（依 §27 驗證）
DELETE /api/schedule/locks/:id          使用者主動解鎖 → 寫 released_at + release_reason='user'
```

`DELETE` 不硬刪列（§24.3）。

---

## 32. 2C-3 實作檢查清單（尚未開始）

- [ ] `schedule_locks` 兩個欄位 ＋ 三個索引（含 partial unique）
- [ ] API 層驗證三種 type 的欄位互斥（§23.1）
- [ ] `server/src/schedule/locks.js` 純函式模組（§31.1）
- [ ] 有效性推導：Task Lock 與 Time/Day Lock 兩套 lifecycle 分開（§24）
- [ ] 事前釘住的輸入組裝（§29.2）＋ 事後驗證安全網
- [ ] 手動拖曳被鎖任務 → 拒絕（§28）
- [ ] Restore 讓被鎖任務保持原位並回報 `lock` 衝突（§30）
- [ ] Lock CRUD API（§31.3）
- [ ] 測試：
      - 被鎖任務在重排後位置不變
      - 被鎖任務變 unplaced → `LOCKED_TASK_UNPLACED`，結果不得為 success
      - 被鎖任務被移動 → `LOCKED_TASK_MOVED`，結果不得為 success
      - **完成該任務後重排不再報衝突**（§26.2 豁免）
      - **取消完成後鎖恢復效力**（§24.3 可逆性）
      - unplaced 任務不能建立 Task Lock；空白的 day/time **可以**上鎖
      - Day Lock 的空白日不准被塞入新 block
      - 過去的 day/time lock 不影響未來排程，且**沒有被自動刪除**
      - 手動拖曳被鎖任務被拒絕
      - restore 時 Lock 優先於舊版位置


---

# Part 4：2C-4 — Schedule Diff 契約

> 狀態：**✅ 定案，尚未實作**
>
> 這一部分只定契約。不實作 production persistence，也不實作 UI。

## 33. 為什麼需要正式 diff

「套用新版安排」這個動作，使用者按下去之前必須看得懂**到底會改什麼**。

前端拿兩版資料自己比對是行不通的：它沒有 Lock、沒有 feasibility、沒有
`effective_from` 的概念，而且會退化成「照標題猜」——那正是 Phase 2B 一路在拔掉的東西。

所以 diff 必須跟版本系統**屬於同一個真相**：由後端從 immutable snapshot 算出來，
前端只負責 render。

而且——這條比 moved/added/removed 本身更重要——

> **Preview 到 Apply 之間，世界可能已經變了。**
> 基於 V5 算出來的候選版本，絕對不能覆蓋一個已經變成 V6 的世界。

§38 的 stale protection 就是在解這件事。

---

## 34. 比較對象與 `comparison_from`

```
base      = 操作開始時的 active ScheduleVersion
candidate = 即將建立（或已建立）的新 ScheduleVersion
```

適用於 AI replan、Wizard edit／regenerate、手動單筆調整（2C-1 §6.1）、restore。

### 34.1 只比較 `effective_from` 當天起

```
comparison_from = candidate.effective_from

before = base 之中 date >= comparison_from 的 blocks
after  = candidate 之中 date >= comparison_from 的 blocks
```

這條是**必要的**，不是最佳化。舉例：

```
V3 effective_from = 8/15，涵蓋 8/15、8/16、8/17…
V4 effective_from = 8/17
```

V4 依定義不包含 8/15、8/16 —— 那兩天已經是歷史（2C-2 §12.2：`effective_from`
是操作當下的 planning day）。如果不裁掉，8/15、8/16 的每一項都會被算成 **REMOVED**，
使用者會看到「這次調整移除了 12 項」，而其實一項都沒動。

> **歷史不進 diff。** 過去的 block 屬於 base 版本的紀錄，不屬於這次變更。

---

## 35. Identity：只用 `task_id`

Diff 的比對身分**一律**是 `task_id`。

明確禁止：

- 標題比對
- 科目＋標題的啟發式
- block id 比對（block 是每一版重新產生的，id 必然不同，比了永遠是全部換掉）
- 前端自己猜

`task_title_snapshot` / `subject_name_snapshot`（2C-1 §2.2）**只作顯示**。
它們存在的理由是「任務被刪掉之後歷史版本還看得懂」，不是第二份身分。

---

## 36. 四種狀態

每個 `task_id` 在 `comparison_from` 之後的排程位置，分成：

| type | 定義 | 學生看到的意思 |
|---|---|---|
| `unchanged` | before 與 after 的 canonical placement 完全相同 | （通常不顯示） |
| `moved` | 兩邊都有，但位置不同 | 時間有調整 |
| `added` | before 沒有，after 有 | 新安排 |
| `removed` | before 有，after 沒有 | 移出目前安排／尚未安排 |

### 36.1 語意邊界（很容易被誤解，必須寫死）

- **`added` 不代表 Task 是新建立的。** 它只表示「這項任務進入了未來排程」。
  一個存在很久、之前 unplaced 的任務被排進來，就是 `added`。
- **`removed` 不代表 Task 被刪除。** 它只表示「這項任務不在這一版的未來排程裡」。
  如果它仍是有效的 Plan Task，它的正式狀態是 **unplaced**（2C-1 §4.4）。

UI 文案不得把 `removed` 講成「刪除」。§43 有對照表。

### 36.2 哪些改變**不算** move

placement 的比較欄位**只有**：

```
date, start_time, end_time, planned_minutes
```

以下都**不算** scheduling move：

- Task 改名（`task_title_snapshot` 變了）
- 科目改名或改顏色（`subject_name_snapshot` 變了）
- Task 的 priority / notes / tags 改變
- block id 不同（必然不同）

理由：diff 回答的是「排程改了什麼」，不是「任務資料改了什麼」。
把改名算成 move，會讓使用者以為 AI 動了他的時間表。

---

## 37. `change_flags` 與多 block

### 37.1 `change_flags`

`moved` 項目另外回傳：

```
change_flags: { date_changed, time_changed, duration_changed }
```

讓 UI 能直接顯示「8/18 → 8/19」或「19:00 → 20:00」，**不需要前端再算一次 diff**。

`time_changed` 指 `start_time` 或 `end_time` 任一改變；`duration_changed` 指
`planned_minutes` 改變。三者可以同時為真。

### 37.2 多 block 必須從一開始就撐住

2C-1 §2.2 刻意**沒有**加 `UNIQUE(schedule_version_id, task_id)`：目前生成器保證
一個任務一版只有一個 block，但那是生成器的不變式，不是 schema 的。

所以 diff engine 的核心資料結構是 **list**，不是單一 block：

```
before_blocks[]   after_blocks[]
```

比較方式：兩邊各自做 **canonical sort**，再逐項比對整個序列。

```
canonical sort key: date → start_time → end_time → planned_minutes
```

- 序列長度不同 → `moved`
- 任一位置的四個欄位不同 → `moved`
- 完全相同 → `unchanged`

`start_time` / `end_time` 在非 timed 模式是 NULL；排序時 NULL 一律排在最前面，
兩邊都是 NULL 視為相等。

> 一個任務**部分** block 消失（2 個變 1 個）是 **`moved`，不是 `removed` ＋ `added`**。
> type 由「before/after 是否為空」決定，只有整組消失才是 `removed`。

API 為了 UI 方便，可以額外提供單一 `before` / `after` 摘要欄位（取 canonical 第一個），
但**核心演算法不得假設只有一個 block**。這條由測試守（§42）。

---

## 38. 🔴 Stale preview protection（本輪最重要的一條）

2C-2 §19.4 已經說過「preview 不可信任，執行時必須重新驗證」。2C-4 把它正式化成
一個**樂觀鎖 token**。

### 38.1 流程

```
1. preview / diff 回傳     base_version_id
2. 使用者確認
3. client apply 時必須帶回 base_version_id
4. 在 transaction 內確認 user_schedule_state.active_version_id 仍 == base_version_id
5. 不相等 → 拒絕，回 409 stale_schedule
```

### 38.2 實作機制（不是「先讀再寫」）

先 `SELECT` 再 `UPDATE` 中間仍有窗口。切換 active pointer 必須是**條件式更新**：

```sql
UPDATE user_schedule_state
   SET active_version_id = :new_version_id, updated_at = CURRENT_TIMESTAMP
 WHERE user_id = :user_id
   AND active_version_id = :base_version_id;   -- ← 樂觀鎖就在這裡
```

`rowsAffected === 0` → 有人搶先改了 → **整筆交易 rollback**，回 409。

這一步和 §7.1 的 version＋blocks 寫入必須在**同一個 transaction boundary** 內。

### 38.3 UI 該怎麼反應

收到 409 之後：重新取得 active schedule → 重新 preview → 讓使用者再確認一次。
**不得**自動重試套用——使用者剛才看到的 diff 已經不是現在的事實了。

### 38.4 首次建立的邊界

使用者還沒有任何排程時，`active_version_id` 是 NULL。此時 apply 帶 `base_version_id: null`，
條件式更新用 `active_version_id IS NULL`。這一樣是樂觀鎖，不是特例豁免。

---

## 39. Lock 與 feasibility 都在 diff 之前

### 39.1 Lock

2C-3 §29.2 已定案「事前釘住 ＋ 事後驗證」。對 diff 的意涵是：

> **候選版本如果動到任何 locked placement，candidate 根本不成立。**

不能是「先接受 candidate → diff 顯示 locked item moved → 使用者自己發現鎖失效」。
Lock 驗證發生在 diff **之前**，成功 candidate 的 diff 中，locked item 原則上只會是
`unchanged`。

可以在 item 上加 `locked: true` 作 UI 標註（顯示一個小鎖），但那是註記，不是驗證。

> 例外只有一種：任務在此期間已完成或已刪除，依 2C-3 §26.2 豁免——此時它本來就
> 不再參與排程，不會出現在 after，也不該被當成違反鎖。

### 39.2 Feasibility

正式 diff **只針對完整、可成立的 candidate**。

feasibility 失敗時：

- 不建立 ScheduleVersion
- `active_version_id` 不變
- **不回傳一份假裝可套用的正式 diff**

回傳 feasibility problems / solutions（2C-2 §17），`diff = null`。

> 半套排程不是 candidate。給使用者看一份他按下去也不會成立的 diff，比不給更糟。

---

## 40. Restore 重用同一個 engine

Restore **不是**「舊版 vs 舊版」。

```
base      = 現在的 active version
candidate = 用舊版當模板、套上現在的 hard constraints 之後產生的 restore candidate
```

版本血緣沿用 2C-2 §12.1 的兩個欄位：

```
parent_version_id        = 操作前的 active version   ← diff 的 base
restored_from_version_id = 模板版本
```

`comparison_from` 一樣是 candidate 的 `effective_from`（2C-2 §12.2：操作當下的
planning day，不是舊版的）。

`nothing_to_restore`（2C-2 §14.1）不建立版本 → 沒有 candidate → `diff = null`。

---

## 41. 版本歷史 diff

```
GET /api/schedule/versions/:id/diff
```

比較該版本與它的 `parent_version_id`，`comparison_from` 使用 **child 的**
`effective_from`。

因為 ScheduleVersion 與 ScheduledBlock 都是 immutable，歷史 diff **永遠可以重算**，
不需要前端保存，也不需要新增 diff table 或 JSON blob。

### 41.1 Audit：immutable snapshot 夠不夠重建 diff？

逐一檢查 diff response 需要的每個欄位：

| 需要的資訊 | 來源 | 可重建？ |
|---|---|---|
| `comparison_from` | `schedule_versions.effective_from` | ✅ |
| before / after blocks | `scheduled_blocks`（immutable） | ✅ |
| `task_id` | `scheduled_blocks.task_id` | ✅ |
| 顯示用標題／科目 | `task_title_snapshot` / `subject_name_snapshot` | ✅ |
| base 是哪一版 | `parent_version_id` | ✅ |
| `locked` 標註 | ⚠️ 見下 | ❌ |

**唯一重建不了的是 `locked` 標註。** `schedule_locks` 是**現在**的狀態，不是快照；
查一個三週前的版本時，當時鎖了什麼已經無從得知。

裁決：**不為此新增欄位。**
`locked` 只在「即將套用的 candidate diff」出現（那時 lock 狀態就是現在的狀態，正確），
歷史 diff 一律省略 `locked` 欄位。歷史畫面顯示鎖沒有實際價值，
為它加一張 snapshot 表是把 immutable 模型弄髒。

### 41.2 沒有 parent 的版本

bootstrap / initial（`parent_version_id IS NULL`）沒有 baseline。

裁決：回傳 `base_version_id: null`、`is_initial: true`、`items: []`，
summary 只有 `added` 計數等於 `block_count`。

**不**把每一個 block 都展成 `added` item——語意上雖然成立（before 是空集合），
但那會讓 UI 把「初次建立 40 項」渲染成「新增 40 項」，跟真的新增 40 項長得一樣。
UI 應該顯示「初次建立」。

> ⚠️ 這一條是我在設計時做的取捨，需要你確認。如果你希望 initial 版本也能逐項展開，
> 改成回傳完整 `added` items ＋ 保留 `is_initial: true` 讓 UI 自己決定文案也可以。

---

## 42. 回傳格式

```jsonc
{
  "base_version_id": 12,          // null = 初次建立
  "candidate_version_id": null,   // preview 階段還沒建立；歷史 diff 才有值
  "comparison_from": "2026-08-17",
  "is_initial": false,
  "summary": { "unchanged": 18, "moved": 4, "added": 2, "removed": 1 },
  "items": [
    {
      "task_id": 3312,
      "type": "moved",
      "task_title_snapshot": "物理｜新大滿貫｜單元3｜節2｜範例+例題",
      "subject_name_snapshot": "物理",
      "locked": false,                       // candidate diff 才有；歷史 diff 省略
      "before_blocks": [
        { "date": "2026-08-18", "start_time": "19:00", "end_time": "20:00", "planned_minutes": 60 }
      ],
      "after_blocks": [
        { "date": "2026-08-19", "start_time": "19:00", "end_time": "20:00", "planned_minutes": 60 }
      ],
      "change_flags": { "date_changed": true, "time_changed": false, "duration_changed": false }
    }
  ]
}
```

欄位名稱可以再調，但**語意不得退化成只有 `changed_count`**。UI 必須能直接 render，
不得再自己拿兩版資料做啟發式比對。

`unchanged` 項目是否放進 `items`：預設**放**（UI 可以自己過濾），但 API 應支援
`?include_unchanged=0` 讓大排程的 response 不必背 400 個沒變的項目。

### 42.1 排序必須 deterministic

```
排序鍵：min(after_blocks 的 date+time)，after 為空則用 min(before_blocks)
      → 再比 task_id
```

同一份 diff 每次呼叫的 response 順序必須一致，否則測試會飄、UI 會跳。

### 42.2 跨使用者

所有版本查詢一律帶 `user_id` 條件。base 與 candidate 若不屬於同一個使用者，
一律 404（**不是** 403——不要洩漏「這個 id 存在」）。

---

## 43. UI 語意對照

API 用 `unchanged / moved / added / removed`，學生介面不照字翻：

| API | 學生看到 |
|---|---|
| `moved` | 時間有調整 |
| `added` | 新安排 |
| `removed` | 移出目前安排（會回到「尚未安排」） |
| `unchanged` | 不變（通常收合或不顯示） |

**`removed` 絕對不能寫成「刪除」。**

---

## 44. `due_date` 不參與 diff

Diff **永遠**比較 `ScheduledBlock`。

`tasks.due_date` 在 2C 之後只是 active block 的鏡射（2C-1 §4.3），是衍生資料。
禁止用 task 的 `due_date` 差異去推測排程 diff——鏡射有延遲、有例外（unplaced 任務
的 due_date 是 NULL），拿它當真相會得到錯的答案。

---

## 45. Apply 的交易邊界

Diff preview 本身**不改任何資料**。

正式 apply 必須在同一個 transaction boundary 內完成：

```
1. 驗證 base_version_id（§38.2 條件式更新）
2. feasibility / lock validation
3. 建立 ScheduleVersion
4. 寫入全部 ScheduledBlocks
5. 寫入 block_count
6. 更新 due_date / due_time 鏡射
7. 切換 active_version_id
```

任何一步失敗 → **active version 完全不變**。沿用 §7.1 的 `q.batch()`
與 §7.2 的 bounded retry。

---

## 46. 契約測試矩陣（2C-4）

- [ ] 日期改變 → `moved` ＋ `date_changed`
- [ ] 同日時間改變 → `moved` ＋ `time_changed`
- [ ] 時長改變 → `moved` ＋ `duration_changed`
- [ ] 完全相同 → `unchanged`
- [ ] before 沒有、after 有 → `added`
- [ ] before 有、after 沒有 → `removed`
- [ ] **`effective_from` 往前推進，過去的 block 不得被算成 `removed`**
- [ ] Task 改名不算 `moved`
- [ ] 科目顯示名稱改變不算 `moved`
- [ ] 一個 task 兩個 block 變一個 → `moved`（不是 removed ＋ added）
- [ ] 兩個 block 完全相同（順序不同）→ `unchanged`（canonical sort 生效）
- [ ] 非 timed 模式（start_time 為 NULL）兩邊相等 → `unchanged`
- [ ] locked block 被修改 → candidate rejected，**不產出正式 diff**
- [ ] locked 任務已完成 → 依 §26.2 豁免，不算違反
- [ ] infeasible candidate → `diff = null`，不建立版本，active 不變
- [ ] restore diff 比較的是 current active → candidate（不是舊版 vs 舊版）
- [ ] `nothing_to_restore` → 不建立版本，`diff = null`
- [ ] stale `base_version_id` → apply 被拒，回 409，active 不變
- [ ] `base_version_id: null` 且已存在 active → 一樣被拒
- [ ] 別人的 version id → 404
- [ ] 同一份 diff 連續呼叫兩次，items 順序完全相同
- [ ] 歷史 diff（`GET /versions/:id/diff`）可從 immutable snapshot 重算
- [ ] `parent_version_id IS NULL` → `is_initial: true`，不展成一堆 `added`

---

## 47. 2C-1～2C-4 一致性 audit

逐項檢查是否互相矛盾：

| 檢查點 | 結果 |
|---|---|
| `effective_from`（2C-2 §12.2）vs `comparison_from`（§34） | ✅ 一致：都是操作當下的 planning day |
| `parent_version_id` / `restored_from_version_id`（2C-2 §12.1） | ✅ 一致：diff base 用 parent，不用 template |
| Restore 產生新版本（2C-2 §20-1） | ✅ 一致：restore 走同一個 engine |
| Lock 事前釘住（2C-3 §29.2） | ✅ 一致：lock 驗證在 diff 之前（§39.1） |
| Lock 對已完成／已刪除豁免（2C-3 §26.2） | ✅ 一致，§39.1 明文引用 |
| Feasibility 兩層（2C-2 §17） | ✅ 一致：schedule-level 失敗即無 candidate |
| `due_date` 鏡射（2C-1 §4.3） | ✅ 一致：§44 明文禁止用它做 diff |
| Unplaced 是正式狀態（2C-1 §4.4） | ✅ 一致：`removed` 的正式落點就是 unplaced |
| Transaction boundary（2C-1 §7.1） | ✅ 一致，§45 沿用並補上樂觀鎖 |
| `version_no` bounded retry（2C-1 §7.2） | ⚠️ 見下 |
| 無 `UNIQUE(version_id, task_id)`（2C-1 §2.2） | ✅ 一致：§37.2 的 list 比較就是為它設計 |
| `block_count` 冗餘欄位（2C-1 §2.1） | ✅ 一致：§41.2 用它當 initial 的 summary |

### 47.1 需要對既有 2C-1～2C-3 做的文字修正（三處）

1. **2C-2 §19.4 需要補一句指向 §38。**
   §19.4 目前只說「preview 不可信任，必須重新驗證」，沒有定義驗證的 token。
   2C-4 把它正式化成 `base_version_id` 樂觀鎖，§19.4 應加註「見 2C-4 §38」。

2. **2C-1 §7.2 的 bounded retry 與 §38 的樂觀鎖有互動，必須寫清楚順序。**
   `version_no` 唯一鍵衝突時要 retry；但 `base_version_id` 不符時**絕對不能 retry**。
   兩者長得像（都是併發衝突）但處理方式相反：
   前者重讀 MAX+1 再試，後者直接放棄並回 409 讓使用者重看一次。
   建議在 §7.2 補一段區分。

3. **2C-1 §2.2 的 snapshot 欄位說明可以補一句**：
   除了「任務被刪掉後歷史版本還看得懂」，它們也是 diff 的顯示來源（§35），
   但**不是** diff 的身分依據。

> 這三處都是補充說明，不改變任何既有裁決。等你確認後我再改 PR #6 的文字，
> 不在這一批擅自動既有段落。

---

## 48. 2C-4 實作檢查清單（尚未開始）

- [ ] `server/src/schedule/diff.js` 純函式模組（輸入兩組 blocks，輸出 diff，不碰 DB）
- [ ] canonical sort ＋ 序列比較（§37.2）
- [ ] `comparison_from` 裁切（§34.1）
- [ ] `change_flags` 計算（§37.1）
- [ ] deterministic ordering（§42.1）
- [ ] `?include_unchanged=0`（§42）
- [ ] apply 端的條件式更新樂觀鎖（§38.2）＋ 409 錯誤型別
- [ ] `GET /schedule/versions/:id/diff`（§41）
- [ ] `is_initial` 邊界（§41.2）
- [ ] 跨使用者一律 404（§42.2）
- [ ] §46 的全部契約測試

---

## 49. 2C 整體實作順序（更新）

```
1. 2C-1  schema ＋ active version ＋ bootstrap
2. 2C-3  schedule_locks ＋ 事前釘住      ← 必須在 2C-2 之前
3. 2C-2  feasibility ＋ restore
4. 2C-4  diff engine ＋ stale protection
5. 前端  Schedule Version / Restore / Lock UI（UI-R 線之後）
```

2C-3 排在 2C-2 之前的理由見 §36（2C-2 §21）：restore 需要 Lock 已經存在才驗得完整。

2C-4 排最後，因為它依賴前三者的資料結構全部就位；但它的**契約**必須在
2C-1 開工前就定案——`effective_from` 的裁切規則會影響 schema 的使用方式。

---

# Part 5：2C-P6-A — 手動調整 AI 排程

## 50. 為什麼手動調整必須是一個新版本

「AI 排完可以自己改」在資料上不是編輯，是**再排一次**，只是這次的決策者
是使用者而不是演算法。

ScheduleVersion 是 immutable snapshot（§7.1）。如果手動調整就地改 active 那一版：

- 版本歷史會出現一段沒人負責的變化（V5 現在的內容不是當初存進去的 V5）
- §41 的歷史 diff 會失真：child ↔ parent 比出來的東西不再對應任何一次決策
- Restore 會恢復到一個「曾經存在但沒被記錄過」的狀態

所以手動調整一律建立 `source='manual'` 的新版本，parent 指向調整前的 active。
使用者在版本紀錄上看得到「這一版是我自己改的」，也隨時可以恢復回去。

## 51. 以 block 為單位，不是以 task 為單位

`moves` 用 `block_id` 指定要調整的對象。

timed 模式下一個任務可能被切成好幾個 chunk block。如果用 `task_id` 當單位，
「把星期三那 40 分鐘挪到星期五」就會連帶把使用者沒碰到的其他 chunk 一起重置。
block_id 是使用者在畫面上真正點到的那一格。

## 52. candidate 是整份 snapshot

手動調整的 candidate ＝ 目前 active version 的**全部** block，其中被指定的那幾個
換上新位置。其餘 block（含其他 Plan 的）原封不動。

這個形狀讓幾件事變成結構上的必然，而不是要靠記得寫檢查：

- **跨 Plan 碰撞**：其他 Plan 的 block 就在 candidate 裡，撞到就是撞到
- **其他 Plan 不會變 unplaced**：§4.3 的鏡射是照整份 active 算的，
  candidate 少帶誰，誰的 due_date 就會被清成 NULL
- **Lock**：`checkLocks` 比對的是整份 candidate 對整份 active，
  它本來就需要看到全貌

## 53. 沒有 force：手動不代表可以違法

手動調整**沒有** `force` / `bypass` 參數。以下一律擋下（409），不提供
「我知道，還是要放」的出口：

| 情況 | type | 理由 |
|---|---|---|
| 搬到已經過去的時間 | `past` | 未來排程不能包含過去 |
| 超過任務的 `deadline_date` | `deadline` | 硬性截止日不是排程可以覆寫的東西（§2） |
| 撞到固定行程 | `fixed_event` | 那個時段學生本來就不在 |
| 撞到任何其他安排 | `schedule_collision` | 含其他 Plan、含本次其他 move |
| 違反 Lock | `LOCKED_*` | §39：Lock 是 hard constraint，對所有寫入路徑一致 |
| 任務已完成／已刪除 | `completed` / `deleted` | 已經退出未來排程 |

要放得下，就得先把擋路的東西改掉（改期限、刪固定行程、解鎖）。
讓使用者繞過去，等於讓 App 產生一份它自己知道做不到的計畫。

**Restore 與手動調整共用同一份規則**（`schedule/feasibility.js`）。
兩邊各寫一份遲早會分岔，變成「恢復擋得住、手動繞得過」。
判定共用，但**文案不共用**：Restore 說「無法恢復」，手動說「不能放在這裡」。

## 54. Stale：`base_version_id` 對不上一律 409

跟 §38 完全相同的規則，理由也相同：使用者是對著他當下看到的那一版做調整。
底變了就表示他沒看過現在的排程，此時寫下去等於把別的變更靜默蓋掉。

**這不是可重試的衝突**，不得進入 `withVersionNoRetry` 的 retry 分支。

## 55. `dry_run`

`POST /api/schedule/manual` 帶 `dry_run: true` 時只回 `{ ok, conflicts, blocks }`，
不寫任何東西、不佔用寫入佇列、不建立版本。

用途是讓 UI 在使用者按下確定之前就說得出「這裡放不下，因為…」。

**preview 是 UX，不是防線。** 正式套用時後端會在 transaction 內用同一份規則
重算一次，`dry_run` 通過不代表套用一定會成功（中間可能有別的變更）。

## 56. 契約測試矩陣（2C-P6-A）

| # | 測項 | 守什麼 |
|---|---|---|
| 1 | 調整產生新的 `manual` 版本，parent 指向原 active | §50 |
| 2 | 舊版本內容不變 | immutable snapshot |
| 3 | 未被碰到的 block（含其他 Plan）原封不動帶過去 | §52 |
| 4 | `due_date` / `due_time` 鏡射到新位置 | §4.3 |
| 5 | 只調日期不給時間也可以 | 純待辦模式 |
| 6 | 過去 / deadline / 固定行程 / 跨 Plan 碰撞 / 本次內部碰撞 → 409 | §53 |
| 7 | Task Lock、Day Lock 都擋得住手動調整 | §39 |
| 8 | `base_version_id` 對不上 → 409，且不留下新版本 | §54 |
| 9 | 別人的 block_id、格式錯誤、重複 block → 400 | 輸入驗證 |
| 10 | `dry_run` 不建立版本，判定與正式套用一致 | §55 |
| 11 | diff 認得出手動搬動是 `moved` | §36 |

## 57. 已修正：`checkLocks` 的整列比對

`locks.js` 的 `slice()` 原本把 DB row 整列 `JSON.stringify` 起來比較。
呼叫端只要多帶一個欄位（例如 restorable block 帶著 `id` 與 snapshot），
或順序不同，**沒有變動的位置也會被判成違反鎖定**。

已改為先投影成 placement（date / start / end / minutes / task_id）再排序後比較。

這個 bug 讓 §46 的一條 restore 測試在錯誤的理由下通過：它斷言
「恢復當前 active 的同一份內容會違反 day lock」，但那其實不是變更，
本來就不該衝突。該測試已改寫成真正會違反鎖定的情境，並新增一條
反向斷言，確保「位置沒變」永遠不會被報成鎖定衝突。

## 58. UI 入口（P6-A）

兩個入口，共用同一個 `AdjustBlockSheet`：

- **Today「接下來」** — 每一段已排定的讀書時段右側一個安靜的「調整」。
  固定行程沒有這個入口：那不是 AI 排的，要改得去行事曆改。
- **計畫明細** — 日期本身就是入口（虛線底線），不再多長一顆按鈕出來擠版面。
  已完成的項目不給調整：它已經退出未來排程，那個日期是歷史紀錄。

還沒有 active version（尚未進入 2C）時，兩處都不長出調整入口，畫面照常。

面板行為：日期／時間一停下來就打一次 `dry_run`（debounce 400ms），
放不下時直接說原因並停用「儲存新安排」。**沒有「還是要放」的按鈕。**
Lock 的 `LOCKED_*` 機器碼在前端翻成人話，其餘原因一律照後端的訊息顯示，
前端不自己重算一套可行性。

`due_date` / `due_time` 由後端鏡射，前端任何路徑都不得直接寫這兩個欄位。
