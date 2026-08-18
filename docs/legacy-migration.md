# Legacy Plan migration

正式 Plan migration 目前受 production audit gate 保護。舊 Task 的 `tag=讀書計劃`、標題中的 `｜` 與 `list_id` 只可用來產出人工審核報告，**不能**推論「一科＝一個 Plan」，也不能拿 `created_at` 分群或把舊的 `due_date` 當成硬 deadline。

```bash
cd server
node src/scripts/legacy-plan-audit.mjs
```

報告不會寫資料。未取得正式 production audit approval 前，migration runner 一律拒絕執行；也不會有自動 production apply。備份、mapping 與 rollback strategy 必須在 audit gate 通過後另行核准。
