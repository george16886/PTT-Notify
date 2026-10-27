# PTT Alerter（Google Apps Script + Telegram）

追蹤 PTT 看板，符合條件時推播到 Telegram：

- **關鍵字**：標題包含指定文字
- **作者**：指定 ID 發文
- **推文數**：推文數 ≥ 指定數字（`爆` = 100）

## 安裝

1. **建立 Telegram Bot**：在 Telegram 找 `@BotFather` → `/newbot`，記下 token。
2. **建立專案**：新增一個空白試算表 → 擴充功能 → Apps Script。
   （也可以在 script.google.com 直接建獨立專案，`setup` 會自動建立一個「PTT Alerter」試算表，網址印在執行紀錄裡。）
3. **貼上程式**：把 `src/Code.gs` 的內容貼進編輯器並存檔。
   （選用）專案設定 → 勾選「在編輯器中顯示 appsscript.json」，貼上 `src/appsscript.json` 讓時區為台北。
   之後想用 GitHub 自動部署，見下方[自動部署](#自動部署clasp--github-actions)。
4. **設定 token**：專案設定 → 指令碼屬性 → 新增 `TG_TOKEN` = 你的 bot token。
5. **取得 chat id**：在 Telegram 對你的 bot 傳任意一則訊息，回到編輯器執行 `getChatId`，
   從執行紀錄複製 chat id，新增指令碼屬性 `TG_CHAT_ID`。
6. **測試**：
   - 執行 `testFetch` → 確認 HTTP 200 且有列出文章（確認 Google 沒被 PTT 擋）
   - 執行 `sendTestMessage` → 確認手機收到訊息
7. **啟用**：執行 `setup` → 會建立「設定」「已通知」工作表與每 5 分鐘一次的觸發器。
   第一次執行會要求授權，照指示允許即可。

## 設定追蹤條件

在「設定」工作表每列一條規則：

| 啟用 | 看板 | 類型 | 條件值 | 備註 |
|---|---|---|---|---|
| ☑ | Stock | 關鍵字 | 台積電 | |
| ☑ | Gossiping | 作者 | someone | |
| ☑ | Stock | 推文數 | 50 | |

- 隨時可以新增 / 修改 / 取消勾選，下一輪自動生效。
- **新規則第一次執行不會通知**，只會記下目前已有的文章，避免一次洗版。之後才通知新出現的符合文章。
- 同一篇文章符合多條規則時會合併成一則通知；但若之前因「關鍵字」通知過，之後推文數衝過門檻仍會再通知一次（每條規則各自去重）。

## 其他函式

- `resetState`：清除所有已通知紀錄，所有規則重新「第一次執行」。
- 檢查頻率改 `Code.gs` 頂端的 `TRIGGER_MINUTES`，再重新執行 `setup`。

## 自動部署（clasp + GitHub Actions）

push 到 `main` 且 `src/` 有變動時，GitHub Actions 會用 [clasp](https://github.com/google/clasp) 把程式推到 Apps Script。
觸發器跑的是最新程式碼，所以不需要另外建立「部署」。

一次性設定：

1. 開啟 Apps Script API：<https://script.google.com/home/usersettings> → 開啟。
2. 本機登入 clasp（會開瀏覽器授權）：
   ```sh
   npm install
   npx clasp login
   ```
   登入後會產生 `~/.clasprc.json`（Windows 為 `%USERPROFILE%\.clasprc.json`）。
3. 到 Apps Script 專案設定複製「指令碼 ID」。
4. 設定 repo secrets（Settings → Secrets and variables → Actions，或用 gh CLI）：
   ```sh
   gh secret set CLASPRC_JSON < ~/.clasprc.json
   gh secret set SCRIPT_ID --body "<指令碼 ID>"
   ```
5. 到 Actions 頁面手動執行一次「Deploy to Apps Script」確認成功。

注意：

- `clasp push` 會**覆蓋整個專案**，線上編輯器的修改會被蓋掉，之後請一律改 repo 裡的檔案。
  原本線上的「程式碼.gs」會被 `Code.gs` 取代。
- `.clasprc.json` 是你 Google 帳號的登入憑證，只能放在 secrets，**絕對不要 commit**。
- 本機想直接推送：建立 `.clasp.json`（已在 `.gitignore`）
  ```json
  {"scriptId":"<指令碼 ID>","rootDir":"src"}
  ```
  然後 `npm run push`。

## 限制

- 只比對**標題**，不含內文。
- 每條規則每次只看搜尋結果第一頁（最新 20 篇），檢查頻率 5 分鐘綽綽有餘。

> 請合理設定檢查頻率（建議 ≥ 5 分鐘），避免對 PTT 造成負擔。

## License

[MIT](LICENSE)
