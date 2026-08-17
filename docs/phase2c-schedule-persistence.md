# Phase 2C：Schedule Persistence

> 狀態：**2C-1、2C-2、2C-3 已定案，尚未實作。** 2C-4 尚未設計。
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
| **2C-2** | 版本恢復（restore）＋ feasibility | ✅ **已定案**（§12–§19） |
| **2C-3** | Lock 持久化 ＋ feasibility 整合 | ✅ **已定案**（§22–§31） |
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

