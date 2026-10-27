# PTT Notify — Cloudflare Workers 版

追蹤 PTT 看板，符合條件時用 Telegram 通知你：

- **關鍵字**：標題包含指定文字
- **作者**：指定 ID 發文
- **推文數**：推文數 ≥ 指定數字（`爆` = 100）

特色：

- 用 Telegram 按鈕 / 指令管理規則，不需要任何網頁或試算表
- 每分鐘檢查一次，跑在 Cloudflare 免費方案上
- **可以多人共用**：朋友傳訊息給你的 bot 會送出申請，你核准後他就能設定自己的規則

## 使用方式

傳 `/start` 給 bot，輸入框下方會出現常駐按鈕：

| 按鈕 | 說明 |
|---|---|
| 📋 規則列表 | 列出你的規則，每條旁有「⏸ 暫停 / ▶️ 恢復」「🗑 刪除」按鈕 |
| ➕ 新增規則 | bot 會請你回覆「看板 類型 條件值」，例如 `Stock 關鍵字 台積電` |
| 🔄 立即檢查 | 馬上檢查一次你的規則，完成後回覆摘要 |
| ⏱ 檢查頻率 | 選擇自動檢查的間隔（1／2／5／10／15／30／60 分鐘） |
| ❓ 說明 | 顯示說明 |
| 👥 使用者 | （僅管理員）核准 / 停用其他使用者、設定每人的檢查頻率下限 |

也可以直接輸入指令：

| 指令 | 說明 |
|---|---|
| `/list` | 列出規則 |
| `/add 看板 類型 條件值` | 新增規則，類型：`關鍵字` / `作者` / `推文數`（也可用 `keyword` / `author` / `push`） |
| `/del 序號` | 刪除規則（序號為 `/list` 的排列順序） |
| `/off 序號`、`/on 序號` | 暫停 / 恢復規則 |
| `/check` | 立即檢查一次 |
| `/interval` | 設定自動檢查頻率 |
| `/users` | （僅管理員）管理使用者 |

例：`/add Stock 關鍵字 台積電`、`/add Stock 推文數 50`、`/add Gossiping 作者 someone`

- 新規則（以及恢復的規則）第一次檢查只記錄現有文章、不通知，避免洗版。
- 只比對**標題**，不含內文。

### 多人共用

- 其他人傳任何訊息給 bot，會自動送出申請，你（管理員）會收到通知，按「✅ 核准」或「⛔ 拒絕」。
- 每個人只看得到、也只能管理自己的規則，通知也只送給自己。
- **檢查頻率**：管理員預設每 1 分鐘；新使用者預設每 5 分鐘。管理員可在「👥 使用者」按「⏱ 下限」設定每人最快能多快，
  使用者再用「⏱ 檢查頻率」在下限以上自選。間隔會對齊整點分鐘（例如 5 分鐘 = :00、:05、:10…）。
- 一般使用者最多 10 條規則（`src/index.js` 的 `MAX_RULES_PER_USER`），管理員不限。
- 也可以把 bot 加進 Telegram 群組，整個群組共用一組規則（同樣需要核准）。
  群組裡請用 `/list@你的bot` 這類指令；常駐按鈕在群組中需要到 @BotFather 關閉 bot 的 Group Privacy 才會生效。
- 你身為管理員可以在資料庫看到所有人的規則，開放給別人前請讓對方知道。

## 自己架一套

全部免費，大約 15 分鐘。需要：

- [Node.js](https://nodejs.org/) 18 以上、[Git](https://git-scm.com/)
- [Cloudflare 帳號](https://dash.cloudflare.com/sign-up)（免費，**註冊後記得驗證 email**，否則無法部署 Workers）
- Telegram 帳號

### 1. 建立 Telegram bot

1. 在 Telegram 搜尋 [@BotFather](https://t.me/BotFather)，傳 `/newbot`，依指示取名。
2. 記下它給你的 **token**（像 `123456789:AAH...`）。
3. 對你的新 bot 傳一則訊息（隨便打）。
4. 用瀏覽器打開 `https://api.telegram.org/bot<token>/getUpdates`（`<token>` 整段換成你的 token，不要留角括號），
   找到 `"chat":{"id":123456789` 這段，這個數字就是你的 **chat id**。

### 2. 下載程式並登入 Cloudflare

```sh
git clone https://github.com/george16886/PTT-Notify.git
cd PTT-Notify/worker
npm install
npx wrangler login          # 會開瀏覽器，按 Allow
```

### 3. 建立資料庫

```sh
npx wrangler d1 create ptt-notify
```

把輸出中的 `database_id` 貼到 `wrangler.jsonc`，取代原本的值。接著建立資料表：

```sh
npm run db:migrate
```

### 4. 設定 secrets

```sh
npx wrangler secret put TG_TOKEN            # 貼上 bot token
npx wrangler secret put TG_CHAT_ID          # 貼上你的 chat id（你就是管理員）
npx wrangler secret put TG_WEBHOOK_SECRET   # 自訂一串英數字，只能用 A-Z a-z 0-9 _ -
```

需要隨機字串可以用：

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 5. 部署

```sh
npm run deploy
```

記下輸出的網址，例如 `https://ptt-notify.<你的子網域>.workers.dev`。
第一次部署若提示要註冊 workers.dev 子網域，到 Cloudflare 後台 Workers & Pages 設定一個即可。

### （選用）設定 bot 頭像

到 @BotFather 傳 `/setuserpic`，選擇你的 bot，上傳 [`assets/logo.png`](../assets/logo.png)（以「照片」傳送，不要用檔案）。

### 6. 連接 Telegram

用瀏覽器打開（換成你的網址和 `TG_WEBHOOK_SECRET`）：

```
https://ptt-notify.<你的子網域>.workers.dev/setup?key=<TG_WEBHOOK_SECRET>
```

看到三個 `"ok":true` 就完成了。到 Telegram 對 bot 傳 `/start` 開始使用。

> 設定 webhook 後，第 1 步的 `getUpdates` 網址就不能用了，這是正常的。

## 更新

```sh
git pull
npm install
npm run db:migrate   # 有新的資料表變更時
npm run deploy
```

更新後若指令選單沒有變化，再打開一次 `/setup` 網址。

## 疑難排解

| 狀況 | 解法 |
|---|---|
| 部署時出現 `verify your email address` | 到信箱點 Cloudflare 的驗證信 |
| `/setup` 顯示 `forbidden` | 網址的 `key` 和 `TG_WEBHOOK_SECRET` 不一致 |
| `/setup` 顯示 secret 只能包含英數字 | 重新 `wrangler secret put TG_WEBHOOK_SECRET`，只用英數字、`_`、`-` |
| 傳訊息給 bot 沒反應 | 打開 `https://api.telegram.org/bot<token>/getWebhookInfo` 看 `url` 和 `last_error_message` |
| 管理員收不到申請通知 | `TG_CHAT_ID` 填錯；重新 `wrangler secret put TG_CHAT_ID` |
| 想看執行紀錄 | `npx wrangler tail`，或 Cloudflare 後台 → ptt-notify → Logs |

## 設定

- **排程**：`wrangler.jsonc` 的 `triggers.crons` 維持 `* * * * *`（每分鐘觸發），每人實際的檢查頻率在 Telegram 裡設定。
- **免費方案限制**：每次執行最多 50 個對外請求（抓 PTT + 傳 Telegram）。相同的搜尋條件會合併成一次請求，
  不重複的條件超過約 40 個時，請升級 Workers Paid 方案或減少規則。

## 開發

```sh
cp .dev.vars.example .dev.vars   # 填入測試用的值
npm run db:migrate:local
npm run dev
```

手動觸發定時檢查：`curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"`
