# PTT Notify — Cloudflare Workers 版

跟 GAS 版功能相同（關鍵字 / 作者 / 推文數），差別：

- **用 Telegram 指令管理規則**，不需要試算表
- 資料存在 **D1**（Cloudflare 的 SQLite）
- 每分鐘檢查一次（免費方案即可）

## 操作

傳 `/start` 後，輸入框下方會出現常駐按鈕：📋 規則列表、➕ 新增規則、🔄 立即檢查、❓ 說明。

- **規則列表**：每條規則旁有「⏸ 暫停 / ▶️ 恢復」與「🗑 刪除」按鈕（刪除會再確認一次）
- **新增規則**：bot 會請你回覆「看板 類型 條件值」，例如 `Stock 關鍵字 台積電`

也可以直接輸入指令：

| 指令 | 說明 |
|---|---|
| `/list` | 列出規則 |
| `/add 看板 類型 條件值` | 新增規則，類型：`關鍵字` / `作者` / `推文數`（也可用 `keyword` / `author` / `push`） |
| `/del 序號` | 刪除規則（序號為 `/list` 的排列順序） |
| `/off 序號`、`/on 序號` | 暫停 / 恢復規則 |
| `/check` | 立即檢查一次，完成後回覆摘要（新文章數、抓取失敗等） |

例：`/add Stock 關鍵字 台積電`、`/add Stock 推文數 50`、`/add Gossiping 作者 someone`

新規則（以及 `/on` 恢復的規則）第一次檢查只記錄現有文章、不通知，避免洗版。
只有 `TG_CHAT_ID` 這個 chat 傳的指令會被處理。

## 部署

需要 Cloudflare 帳號（免費）。以下指令都在 `worker/` 資料夾執行。

1. 安裝並登入（會開瀏覽器）：
   ```sh
   npm install
   npx wrangler login
   ```
2. 建立 D1 資料庫，把輸出的 `database_id` 填進 `wrangler.jsonc`：
   ```sh
   npx wrangler d1 create ptt-notify
   ```
3. 建立資料表：
   ```sh
   npm run db:migrate
   ```
4. 設定 secrets（每個會提示你輸入值）：
   ```sh
   npx wrangler secret put TG_TOKEN
   npx wrangler secret put TG_CHAT_ID
   npx wrangler secret put TG_WEBHOOK_SECRET   # 自訂一串隨機字（英數、_、-）
   ```
5. 部署，記下輸出的網址（`https://ptt-notify.<你的子網域>.workers.dev`）：
   ```sh
   npm run deploy
   ```
6. 設定 Telegram webhook，在瀏覽器打開（替換三個值）：
   ```
   https://api.telegram.org/bot<TG_TOKEN>/setWebhook?url=https://ptt-notify.<子網域>.workers.dev/telegram&secret_token=<TG_WEBHOOK_SECRET>
   ```
   看到 `"ok":true` 即完成。到 Telegram 對 bot 傳 `/help` 測試。

> 同一個 bot 設了 webhook 後，GAS 版的 `getChatId()`（getUpdates）就不能用了。
> 兩個版本同時跑會重複通知，請只啟用一個。

## 開發

```sh
cp .dev.vars.example .dev.vars   # 填入測試用的值
npm run db:migrate:local
npm run dev
```

手動觸發定時檢查：`curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"`

檢查頻率改 `wrangler.jsonc` 的 `triggers.crons`（UTC），再重新部署。
