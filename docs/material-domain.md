# Material Domain 契約（Backend Foundation）

教材是「長期存在的東西」，Plan 是「這一次要做的事」。這份文件是兩者交界處的
hard contract，實作與測試都以這裡為準。動任何一行 material 相關的 code 之前先讀。

本輪只做 backend/domain foundation。**沒有** legacy `toc_items` 的 migration／
backfill，**沒有** 猜測既有 Task 與教材的對應關係，**沒有** 改寫排程器。

---

## 1. Completion 的最小單位是 ContentItem

完成度只寫在 `material_progress`，一個使用者對一個 ContentItem 最多一列
（由 `idx_material_progress_one` 這條 unique index 保證）。

Chapter / Section / Topic **沒有** 完成欄位，也沒有任何 API 可以寫。它們的完成度
一律由 `material/tree.js` 的 `buildTree()` 從子孫 ContentItem 現算。

> 沒有列 = 尚未完成。不需要為了表示「未完成」而預先寫滿整本書。

## 2. 手動完成，且 Task reopen 不回捲

- `PUT /api/material/content-items/:id/completion` 可以明確標記完成／未完成
  （`source='manual'`）
- Task 完成時，若該 Task 綁著 ContentItem，會帶起教材完成（`source='task'`，
  並記下 `source_task_id` 作為 provenance）
- **Task reopen 不會把教材改回未完成。** 重開一個 Task 不是「教材沒讀過」的證據；
  使用者可能已經在別處讀完了。要改回未完成只能由使用者在 Material 層明確操作
- 取消 Task 不是完成，同樣不動教材進度

## 3. 跨 Plan 的全域狀態與 reconciliation

Completion 是跨 Plan 的長期狀態。一份教材在任何地方完成之後，其他 Plan 就不該
再把它當成待排程工作。

reconciliation 刻意複用既有 lifecycle 的「取消」：

- 取消的語意本來就是「這件工作不再做」，而且既有的 `transitionTaskOutcome`
  已經會安全地讓 Task 退出 active ScheduleVersion 並尊重 Lock
- **不偽造其他 Plan 的 `completed` 歷史**——那會污染 Plan 完成率與 Goal 進度

已完成的 ContentItem 也不能再長出新的 Task（`POST /api/tasks` 回 409）。

### Lock × completion（鎖定的產品決策）

> Material completion 是使用者「這份教材內容已完成」的**長期事實狀態**，
> **優先於**其他 Plan 的 Task / Schedule reconciliation。
> Lock 的語意是保護既有 Task／排程不被自動調整，
> **不得阻止 Material completion 本身被記錄。**

因此執行順序是固定的：

1. Material completion **先成功寫入**
2. 其他 Plan 中同一個 ContentItem 的 open Task 再進行 reconciliation
3. 未被阻擋者安全取消／退出 active schedule，且**不得偽造 completed history**
4. 被阻擋者**保留原狀**並回報在 `reconciliation.blocked[]`
5. 前端必須把 `blocked[]` 當成**需要使用者處理的真實衝突**，不可靜默忽略

`blocked[]` 每一筆帶 `task_id`、`plan_id`、`error`，有 lock 衝突時另帶 `conflicts`。

**實作現況（重要）**：在目前的 schedule lifecycle 語意下，Lock 並不會擋下
「取消這個 Task」本身——取消會先把 Task 標為 `cancelled`，此時它自己的 Task Lock
已不再 effective（`effectiveLocks` 的 `live()` 要求 task 未取消），而 Day / Slice
Lock 比較時兩邊都會濾掉該 task 的 block。所以實務上 reconciliation 幾乎都會成功，
`blocked[]` 是**防禦性通道**：只有在重建 active version 真的失敗時才會有內容。

這不改變上面的契約——契約規定的是「completion 優先、被擋住的要回報而不是靜默
略過」，而不是「一定要有東西被擋住」。前端仍必須處理 `blocked[]` 非空的情況。

## 4. 取消選取 ≠ 教材完成，也 ≠ 刪除

Edit Plan 取消選取某個 ContentItem 時：

- `material_progress` 完全不動
- selection 列保留，只是 `selected=0` 並記下 `removed_at`
- 已產生但尚未完成的 Task **不 hard delete**，而是走既有 lifecycle 取消，
  安全退出 active schedule；Task 本身與 `material_content_item_id` 都還在，
  歷史查得到

## 5. Book 刪除的正常語意是封存

`DELETE /api/material/books/:id` 預設是 archive。

只有 `progress`、`plan_selections`、`tasks`、`categories` 四項 reference 全部為 0 的
書才允許 `?hard=1` 真的刪除；否則回 409 並附上卡在哪裡的數字。硬刪一本有歷史的
書，等於偽造「這件事沒發生過」。

## 6. Wizard checkbox 的意思

| 狀態 | 意思 |
|---|---|
| checked | 尚未完成＋本次 Plan 要排 |
| unchecked | 尚未完成＋本次 Plan 不排 |
| completed | 教材真的已完成，**不用普通 selection checkbox 表示** |

已完成的項目不能被選取（單筆選取回 409；節點批次選取安靜跳過，因為使用者點的是
「整章」，本來就不是在對已完成的項目表態）。

Chapter / Section / Topic 的 checkbox 只能做 tri-state 批次 selection：實際寫入的
永遠是底下的 ContentItem selection，不可能改到任何 completion。

tri-state 的計算只看**尚未完成**的項目：

- `all` → 底下每一個未完成項目都被選取
- `some` → 部分選取
- `none` → 都沒選，**或整章都已完成**（沒有東西可以排時不該畫出「已全選」的勾）

已完成卻仍留著 selection 列的殘留狀態（先選取、之後在別處完成）不計入 selection。

## 7. 不得建立假的 Section

| ContentItem 類型 | 允許掛在 |
|---|---|
| `reading` 內文 | chapter / section / topic |
| `example` 範例／例題 | section / topic |
| `unit_exercise` 單元練習 | **chapter** |
| `past_exam` 歷屆試題 | **chapter** |

單元練習與歷屆試題直接屬於章。為了「讓題目有個 parent」而生出假的節，會污染
每一個 derived 數字：章的完成率、tri-state、教材樹的層數。

節點層級：章只能在書底下，節只能在章底下，主題只能在節底下。

## 8. Category ↔ Book 是 many-to-many

`material_category_books` 只存 reference。同一本書可以同時屬於多個分類，而且永遠
是同一本書——**不複製**，所以進度不會分裂成兩份。移出分類只解除 reference。

## 9. Selection 與 Progress 分離

`plan_material_items`（這次要排什麼）與 `material_progress`（教材完成度）互不寫入
對方。同一個項目可以是「已選取但未完成」，也可以是「已完成但未選取」。

## 10. 排程仍然是 Task-centric

ScheduledBlock / ScheduleVersion / Replan / History / StudySession 完全沒有 material
欄位，也沒有因為這次改造而重寫。

Material 層要讓某個 Task 退出未來排程時，一律呼叫既有的
`transitionTaskOutcome`，不另外寫一套排程寫入路徑。純 material 操作
（標記完成、調整選取）本身不會產生新的 ScheduleVersion，除非它連帶取消了某個
Task——那是既有 lifecycle 的正常行為。

---

## Schema

| 表 | 用途 |
|---|---|
| `material_books` | 教材本體。`archived` / `archived_at` 撐起封存語意 |
| `material_nodes` | 章／節／主題的自我參照樹（`kind` + `parent_id`） |
| `material_content_items` | 完成度的最小單位，掛在某個 node 底下 |
| `material_progress` | 跨 Plan 的全域完成度，唯一真相 |
| `material_categories` | 分類 |
| `material_category_books` | 分類 ↔ 書 的 many-to-many reference |
| `plan_material_items` | Plan 這一次的選取（含已移除的歷史列） |
| `tasks.material_content_item_id` / `tasks.material_book_id` | Task ↔ Material 指向 |

## API

```
GET    /api/material/books                      ?archived=1 才含已封存
POST   /api/material/books
PATCH  /api/material/books/:id
GET    /api/material/books/:id/tree             ?plan_id= 時附帶 tri-state selection
GET    /api/material/books/:id/references       可否 hard delete 的判準
DELETE /api/material/books/:id                  預設 archive；?hard=1 才嘗試真刪
POST   /api/material/books/:id/unarchive

POST   /api/material/nodes
POST   /api/material/content-items
PUT    /api/material/content-items/:id/completion    { completed: boolean }

GET    /api/material/categories
POST   /api/material/categories
PUT    /api/material/categories/:id/books/:bookId
DELETE /api/material/categories/:id/books/:bookId

GET    /api/plans/:id/material-items
POST   /api/plans/:id/material-items                 { content_item_ids[], selected }
POST   /api/plans/:id/material-nodes/:nodeId         { selected }  tri-state 批次
```

節點**沒有** completion 端點，這是刻意的（見 §1）。
