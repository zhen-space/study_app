# 讀書計劃 App

學生讀書計劃網站：自動排程精靈、每日待辦、讀書統計。

## 啟動
```bash
cd server && npm install && node src/index.js   # API :3001
cd client && npm install && npm run dev          # Web :5173
```

## 功能
- Email 註冊/登入（JWT）
- 固定行程行事曆（單次/每週重複）＋睡眠、吃飯作息設定
- 排程精靈：確認作息（可調整）→ 選科目與範圍（預設 120 分/範圍，可改）→ 照順序或打散分配 → 預覽確認
- 每日待辦打勾完成
- 統計：週時數、科目分布、完成率、連續打卡
