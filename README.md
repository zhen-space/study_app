# 讀書計劃 App

學生讀書計劃網站：自動排程精靈、每日待辦、讀書統計。

## 啟動
```bash
cd server && npm install && node src/index.js   # API :3001
cd client && npm install && npm run dev          # Web :5173
```

## 測試
排程演算法的回歸測試（截止日、模考獨佔、純題目規則、任務不遺失、總量、順序）：
```bash
cd server && npm test          # 全部（26 項）

# 只跑某一組（旗標要放在檔案之前，npm test -- 的寫法不會生效）
node --test --test-name-pattern="截止日" "test/**/*.test.mjs"
```
測試會自己開一台伺服器（隨機埠 ＋ 暫存 SQLite），不需要先啟動 server，
也不會動到 `data.sqlite` 或雲端資料庫。改完 `src/routes/schedule.js` 請務必跑過。

結果不受機器時區影響，`TZ=UTC`、`TZ=Asia/Taipei`、`TZ=America/New_York` 都應該是 26/26。
日期運算請一律用 `src/util/date.js`（UTC 進、UTC 出），不要混用
「本機時區解析 `new Date(ds + 'T00:00:00')` ＋ UTC 輸出 `toISOString()`」——這兩者在 UTC+N 會差一天。

## 功能
- Email 註冊/登入（JWT）
- 固定行程行事曆（單次/每週重複）＋睡眠、吃飯作息設定
- 排程精靈：確認作息（可調整）→ 選科目與範圍（預設 120 分/範圍，可改）→ 照順序或打散分配 → 預覽確認
- 每日待辦打勾完成
- 統計：週時數、科目分布、完成率、連續打卡
