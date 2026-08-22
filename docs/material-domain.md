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

## 7. Material hierarchy 與不得建立假的 Section

正式 hierarchy 是：

- Book
  - Chapter
    - Section
    - Topic

**Section 與 Topic 是同一層級，兩者都直接掛在 Chapter。** Topic 不是 Section 的子層。
Section / Topic 底下可以直接承載範例／例題；Chapter 本身可以直接承載單元練習／歷屆試題。
不得為了讓 Chapter-level ContentItem「有 parent」而建立假的 Section。

| ContentItem 類型 | 學生看到的字 | 允許掛在 |
|---|---|---|
| `reading` | 課本內容 | chapter / section / topic |
| `example` | 範例 | section / topic |
| `example_problem` | 例題 | section / topic |
| `unit_exercise` | 單元練習 | **chapter** |
| `past_exam` | 歷屆試題 | **chapter** |

**`example`（範例）與 `example_problem`（例題）是兩種不同的東西**：範例是課本
講解過的示範，例題是要學生自己動手做的題目。它們必須是各自獨立的 ContentItem，
學生才能「只讀課本內容」「只做例題」或「全部一起排」。

`reading` 保留成獨立的 ContentItem —— **不要**把 Section / Topic 本身當成
completion identity。完成度的最小單位永遠是 ContentItem（§1）。

`material_content_items.kind` 是 `TEXT NOT NULL`，**沒有 CHECK constraint**，
所以擴充 kind 是純粹的 application-level enum 變更，不需要 schema migration。

單元練習與歷屆試題直接屬於章。為了「讓題目有個 parent」而生出假的節，會污染
每一個 derived 數字：章的完成率、tri-state、教材樹的層數。

節點層級固定為：章只能在書底下；Section 與 Topic 都只能在章底下。

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
| `material_nodes` | 章／節／主題的自我參照樹（`kind` + `parent_id`）；Section / Topic 都直接 reference Chapter |
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

---

## 11. Canonical Material Draft 與唯一的 full-tree writer

「一份還沒寫進資料庫的完整教材」有一個明確形狀（`server/src/material/draft.js`）：

```
{
  book: { title, publisher?, subject_list_id? },
  chapters: [{
    title, order?,
    content_items: [ … ],        // 章直屬：reading / unit_exercise / past_exam
    children: [{                 // Section 與 Topic 同層，都直接掛在章底下
      kind: 'section' | 'topic', title, order?,
      content_items: [ … ],      // reading / example / example_problem
    }],
  }],
}
```

draft **不帶任何 id**：它描述「要建立什麼」，不是「已經有什麼」。identity 一律由
commit 當下的 INSERT 決定，不從 title / path 猜。

canonical draft 禁止：Topic 巢狀在 Section 底下、為 chapter-level 內容造假的
Section、未知的 kind、任何 identity 猜測。

**只有一個 full-tree writer**：`writeDraftTree()`。import commit 與手動建立教材
都組出同一種 draft 再交給它——兩套 writer 遲早會分岔成「一邊擋得住、另一邊繞得過」。

```
圖片／PDF ──► parser ─┐
                     ├─► canonical draft ─► writeDraftTree()（單一 transaction）
手動建立 ────────────┘
```

驗證（`validateDraft`）與寫入（`writeDraftTree`）刻意分開：驗證擋掉的東西永遠到
不了交易裡，交易要防的是**驗證看不到的失敗**（DB 錯誤、併發刪除）。分開之後
rollback 才測得到。

### Import：preview → 確認 → commit

| 端點 | 行為 |
|---|---|
| `POST /api/material/import/preview` | 呼叫正式 parser，回 canonical draft 與統計。**完全不寫資料庫** |
| `POST /api/material/import/commit` | 把確認過的 draft 一次建立完整教材樹，全成功或全不做 |

正式 parser（`server/src/material/parser.js`）直接輸出 canonical draft，不先產
legacy TOC 形狀再讓前端轉——轉換寫在前端就等於把 hierarchy 契約複製一份到前端。

legacy 的 `POST /api/import/toc` 原樣保留：它的 prompt 要求「章 → 節 → 主題」
三層巢狀，與正式 hierarchy 正面衝突，直接改會讓既有資料的語意在一次部署之間改變。

## 12. Legacy 相容讀取層（read-only）

學生只看到一個「教材」的世界，看不到「教材庫／舊版目錄」兩個分頁。但這**不代表**
要把 `toc_items` migrate 成 Material——migration 不可逆，而且會把「猜出來的對應」
變成看起來像事實的資料。

所以只做投影（`server/src/material/legacy.js`，**只有 SELECT**）：

| | 正式 Material | Legacy |
|---|---|---|
| `source` | `'material'` | `'legacy'` |
| identity | `material_book_id` / `material_node_id` / `material_content_item_id` | `legacy_ref = { toc_id, path }` |
| 完成度 | 真的有 | `completion_supported: false` |

**兩者的 identity 永遠不互轉。** 不做 title matching、不做書名比對、不用 path 猜
Material identity、不 silent conversion、不 auto migration。

### 巢狀 Topic 的攤平

legacy 原始是 `Chapter → Section → Topic`；投影後 `Chapter → [Section, Topic, …]`。

**攤平只發生在呈現。** 每個節點都帶 `legacy_ref = { toc_id, path }`，path 是它在
原始 `sections` JSON 裡的索引路徑，所以指得回原本那一列的那個位置；被提上來的
Topic 另外帶 `legacy_flattened_from`，記得自己原本掛在誰底下。**不 UPDATE toc_items。**

### 「焦點」等對不上的 level

production 有 25 筆 `level = 焦點`，正式 Material 沒有對應的 kind。

**保守契約**：投影成 `kind: 'legacy_node'` 的顯示節點，原始 level 原樣保留在
`legacy_level`，並標明 `completion_supported: false`。它**不是**正式 Material 節點，
沒有 Material identity，也不會被猜成 `reading` / `example` / `example_problem` /
`unit_exercise`。猜錯就是把使用者的教材結構改掉，而且沒有回頭路。

只有明確對得上的 level 才投影：`節`/`小節`/`單元` → `section`，`主題`/`重點` → `topic`，
其餘一律 `legacy_node`。

### 統一讀取

`GET /api/study-materials`（可帶 `?plan_id=`）把兩個來源合成同一個形狀回傳，
前端不必再寫 `if (legacy) … if (material) …`。

`plan_id` 只影響**正式 Material** 的 selection：legacy 沒有 `plan_material_items`
可以指向，所以永遠沒有 selection，也不假裝有。legacy 沒有正式完成度時
**不得捏造 0%** 假裝語意相同——回 `completion_supported: false`，由呈現層自己決定
怎麼自然呈現。

## 13. 舊教材的 just-in-time 正式化

### 為什麼 legacy 不能直接被選取

`toc_items` 的欄位是 `id, user_id, list_id, title, level, sections, order_index,
book, publisher`。`sections` 的每個節點只有 `{ title, level, children }`。

**legacy 裡根本沒有 ContentItem。** 舊流程的「範例／例題／單元練習／歷屆試題」
是使用者在排程時當場勾的（`WizardView` 的 `TYPE_OPTIONS`／`typesBy`），
從來沒有落庫。而 `plan_material_items.content_item_id` 指向的是
`material_content_items.id` —— legacy 沒有任何 row 可以被指到。

所以：**結構（章／節／主題）deterministic；內容類型完全不存在於資料中。**
任何自動 mapping 都是無中生有。

### 正式化時機

**學生第一次真的要用這本舊教材時**，就地確認一次。不另外做教材管理頁的
「轉換」動作，也不是 migration wizard —— 學生看到的只有「確認這本教材裡有哪些內容」。

UI 不得出現：legacy、migration、formalization、identity、轉換成 Material。

```
教材 → 打開教材 → （還缺內容資訊時）一次性的「確認教材內容」→ 確認 → 回 Step 1 → 正常選取
```

系統 deterministic 帶入：教材名稱、publisher、subject、Chapter、Section／Topic
（含巢狀 Topic 的 presentation flatten 結果）。
系統**不猜**：ContentItem 的 kind，一律由學生確認。

對不上正式種類的節點（如「焦點」）不會進 draft，而是列在 `unsupported_nodes`
如實呈現 —— 硬塞成 section／topic 就是在猜。

### Provenance：`material_book_sources`

| 欄位 | 意義 |
|---|---|
| `book_id` | 正式 `material_books.id` |
| `source_kind` | `legacy_toc` |
| `source_row_id` | 實際來源的 `toc_items.id` |

一本正式教材通常對應**多列** `toc_items`（一章一列），所以是 1 對多。

`UNIQUE(user_id, source_kind, source_row_id)` 讓每一列 legacy 都能 deterministic
回答「我被正式化過了嗎」，同時擋下重複正式化 —— 重複會生出兩本內容相同、
完成度各自獨立的教材，而且沒有任何入口能合併回去。

**刻意不在 `material_books` 上放 `legacy_book` 之類的欄位**：書名是文字，會重複、
會改，拿它當長期 linkage 就是 title matching 的變形。

### 來源快照：commit 只能正式化使用者實際看過的那一份

preview 與 commit 之間，舊資料仍可能被新增／刪除／修改。若 commit 只靠
`(list_id, book)` 重新決定來源集合，preview 之後新增的那一列會被一起吃進
provenance 並從教材世界消失 —— 但使用者根本沒看過它。

所以 preview 回傳一份明確的來源快照：

```
source_snapshot: {
  source_kind: 'legacy_toc',
  list_id, book,                 // compatibility grouping，只用來「找出這一組」
  row_ids: [toc_items.id …],     // 授權依據
  fingerprint: '<sha256>',       // 涵蓋所有會影響 draft 的欄位
}
```

commit 必須把它原樣送回來。指紋涵蓋每一列的
`id / title / level / sections / order_index / publisher`，
所以改章名、改結構、改順序、改出版社都會被抓到。
`book` 刻意**不**放進指紋 —— 它是分組鍵，改了那一列就會離開這一組，
成員檢查先一步抓到。

commit 在**交易內**做三道各自必要的檢查：

1. 快照裡有沒有哪一列已經被正式化過 → 409
2. 目前這一組的成員是否與快照完全相同（group 查詢是 user-scoped，
   所以「成員完全相同」同時證明了每一列都存在、都屬於這位使用者、
   而且沒有多出／少掉）→ 不同就 409 stale
3. 指紋是否相同 → 不同就 409 stale

實際寫進 provenance 的永遠是**快照的 `row_ids`**，不是重新查出來的分組。

stale 時整筆不寫、不自動 retry、不靜默更新 draft。使用者重新 preview
（拿到新快照）之後可以正常完成 —— 不是死路。

### 原子性

教材樹與 provenance 在**同一筆 transaction** 內建立：

- 任一步失敗 → 整筆 rollback，不留下半本教材，也不留下孤兒 provenance
- 使用者取消 → 根本不會呼叫 commit，什麼都不會寫
- 重複正式化 → UNIQUE 擋下並整筆 rollback

`toc_items` 全程只被 SELECT，**不 UPDATE、不 DELETE**。

### 去重

`listStudyMaterials` 以 provenance 的 `source_row_id` 過濾掉已正式化的來源列，
**不是**書名比對 —— 同名但來源列不同的另一本舊教材不會被連坐隱藏。

### API

```
GET  /api/material/legacy-books/:listId/content-check?book=…   回 canonical draft（內容留空），不寫任何東西
POST /api/material/legacy-books/:listId/content-check          { book, draft } → atomic 建立正式教材 + provenance
```

正式化之後，Step 1 只使用正式的 `material_content_item_id`，
後續 `plan_material_items → Task → ScheduledBlock` 全部走既有正式路徑，
Plan / Schedule 契約一行未改。
