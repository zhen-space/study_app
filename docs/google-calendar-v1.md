# Google Calendar v1（單向唯讀）— Migration 與部署說明

這份文件是給總控 audit 與 production apply 用的。**這支 PR 沒有、也不得自行執行任何 production migration。**

## 1. 這個功能做什麼、不做什麼

**做**：把 Google 日曆上「哪些時段是忙的」當成排程器的外部不可用時間。

**不做**（全部有測試釘住）：

- 不建立／修改／刪除 Google Calendar 事件
- 不把 ScheduledBlock 寫回 Google
- 不把 Google 事件變成 StudySession
- 不寫 Material completion、不改 Plan selection
- 不建立第二套 schedule state、不繞過 Lock / ScheduleVersion
- 不讀事件標題、地點、參與者（scope 根本拿不到）

方向永遠是 Google → Study App。

## 2. Schema impact

**一張 additive table，不動任何既有表：**

```sql
CREATE TABLE IF NOT EXISTS google_calendar_connections (
  user_id INTEGER PRIMARY KEY,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT NOT NULL,
  access_token_expires_at TEXT,
  scope TEXT NOT NULL,
  token_type TEXT,
  encryption_version INTEGER NOT NULL DEFAULT 1,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error_code TEXT
);
```

**刻意沒有建立**：`google_calendar_events`、`google_busy_events`、`google_schedule_versions`、任何 Google mirror ScheduledBlock。忙碌時段每次排程當下向 Google 查詢，**完全不落地** —— 不落地就不會有「資料庫那份過期了」的問題，也少一份可外洩的行程資料。有測試檢查這些表不存在。

## 3. Migration plan

- **形式**：純 additive `CREATE TABLE IF NOT EXISTS`，由既有的 `initSchema()` 在啟動時建立
- **無 backfill**、**無 UPDATE**、**無 DELETE**、**無既有資料轉換**
- **可重跑**：`IF NOT EXISTS`，已存在即 no-op
- **回滾**：這個 table 沒有任何既有功能依賴它。要回滾就是把程式碼 revert；table 留著不影響任何事（也可事後 `DROP TABLE google_calendar_connections`，只會讓已連結的使用者需要重新連結）

## 4. Production apply steps（等 audit 通過後由人工執行）

1. 先在 Render 的 Web Service 設好第 5 節的四個環境變數
2. 在 Google Cloud Console 把 Authorized redirect URI 設成與 `GOOGLE_REDIRECT_URI` **完全一致**
3. merge PR → Render 自動部署
4. 啟動時 `initSchema()` 會建立 table（additive，不需要另外跑 migration script）
5. 驗證：以測試帳號進「設定 → 連結 → 連結 Google 日曆」，走完授權後回到設定頁應顯示「已連結（主要日曆）」
6. 再跑一次排程，確認被 Google 佔用的時段沒有被排入

**不需要**執行任何 data migration、backfill 或修復腳本。

## 5. Render secrets（人工設定，不得進 repo）

Render → study-app Web Service → Environment：

| Key | 內容 |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `https://study-app-ppw2.onrender.com/api/integrations/google-calendar/callback` |
| `TOKEN_ENCRYPTION_KEY` | Base64 的 32 bytes 隨機金鑰 |

產生金鑰：

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**限制**：

- `TOKEN_ENCRYPTION_KEY` **不得**與 `JWT_SECRET` 或 `GOOGLE_CLIENT_SECRET` 共用。三者用途、輪替節奏與外洩後果都不同，混用等於把風險綁在一起
- 四者都**不是** `VITE_*`，前端 bundle 不需要、也拿不到任何一個
- 不得出現在 repo、log、螢幕截圖或 API 回應

環境變數沒設好時：`/status` 會回 `configured: false`，前端顯示「這個功能還沒在伺服器上啟用」而不是給一顆按了必定失敗的按鈕；`/connect` 回 503 `NOT_CONFIGURED`。**既有排程完全不受影響。**

## 6. Security 摘要

| 面向 | 做法 |
|---|---|
| OAuth scope | 只有 `calendar.freebusy`。拿不到事件內容 |
| 日曆範圍 | 只有 `primary`，v1 不做多日曆 |
| Token 儲存 | AES-256-GCM，每次隨機 12-byte IV + authentication tag；`encryption_version` 留給金鑰輪替 |
| Token 外洩面 | 不進 log、不進 API 回應、不進前端、不進 localStorage、不進 URL。`statusFor()` 是白名單欄位 |
| callback 身分 | 伺服器簽的短效 state（HMAC-SHA256，10 分鐘）。**不採信前端送的 user_id** |
| CSRF | state 驗簽 + 用途欄位 + 過期檢查 |
| 使用者隔離 | 所有查詢都帶 `user_id`；A 不能讀、也不能中斷 B 的連結 |
| Token 交換 | 一律 server → Google，authorization code 不經前端 |
| 中斷連結 | best-effort revoke；**無論 remote revoke 成敗，本地憑證一定刪除** |

## 7. Fail closed

連結了 Google 但讀不到（網路失敗、token 失效、Google 回錯誤）時，`POST /api/schedule/preview` 回：

```json
HTTP 503
{ "error": "暫時無法讀取 Google Calendar", "code": "GOOGLE_CALENDAR_UNAVAILABLE" }
```

**不產生一份沒有考慮 Google 忙碌時段的排程。** 靜默忽略是最危險的失敗方式：會產出一份看起來完全可行、實際上跟真實行程撞滿的安排，而使用者不會知道。

沒有連結 Google 的使用者完全不受影響 —— 有測試確認排程行為與這個功能不存在時一致。

## 8. 時區

排程與日期邊界一律 **Asia/Taipei**（後端既定 contract）。

- FreeBusy 查詢窗：`timeMin = 起日 00:00:00+08:00`、`timeMax = 迄日次日 00:00:00+08:00`、`timeZone = Asia/Taipei`
- Google 回的 RFC3339 區間換算成台灣時間後，依**本地日期**切成 `date → [起分, 迄分]`；跨午夜自動拆成兩天，整天表示為 `[0, 1440]`
- **不用 UTC 的 `.slice(0,10)` 決定日期** —— 在 UTC+8 會整個差一天，這正是先前「AI 讀錯日期」那一類問題的根源

同時修正了設定頁原本「跟著裝置時區」的錯誤說明；裝置時區與排程時區不同時會另外列出來，讓使用者知道為什麼日期看起來有落差。**沒有因此新增任何 timezone schema。**

## 9. v1 明確不做

多日曆選擇、CalendarList、事件標題／內容匯入、Google → `fixed_events` 落地、ScheduledBlock → Google、雙向同步、背景 sync daemon、webhook/watch channel、syncToken event mirror。
