/**
 * PTT Alerter — Google Apps Script + Telegram
 *
 * 追蹤 PTT 看板：標題關鍵字 / 特定作者 / 推文數門檻，符合時推播到 Telegram。
 * 可綁定在 Google Sheet 上，或用獨立專案（setup() 會自動建立試算表），設定寫在「設定」工作表。
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   TG_TOKEN    Telegram Bot token（向 @BotFather 申請）
 *   TG_CHAT_ID  要接收通知的 chat id（可執行 getChatId() 取得）
 */

const PTT_BASE = 'https://www.ptt.cc';
const CONFIG_SHEET = '設定';
const SEEN_SHEET = '已通知';
const MAX_SEEN = 5000;          // 已通知紀錄保留筆數
const TRIGGER_MINUTES = 5;      // 檢查頻率（1, 5, 10, 15, 30）

// 類型 → PTT 搜尋語法
const RULE_TYPES = {
  '關鍵字': v => v,
  '作者': v => 'author:' + v,
  '推文數': v => 'recommend:' + v,
};

/** 觸發器進入點 */
function main() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 上一輪還沒跑完
  try {
    run_();
  } finally {
    lock.releaseLock();
  }
}

function run_() {
  const ss = getSpreadsheet_();
  const rules = loadRules_(ss);
  if (!rules.length) return;

  const seenSheet = ss.getSheetByName(SEEN_SHEET);
  const seen = loadSeen_(seenSheet);
  const props = PropertiesService.getScriptProperties();
  const inited = new Set(JSON.parse(props.getProperty('INIT_RULES') || '[]'));

  const responses = UrlFetchApp.fetchAll(rules.map(buildRequest_));
  const hits = new Map();   // 文章 id → { post, reasons, keys }
  const silent = [];        // 新規則第一次執行：只記錄、不通知，避免一次洗版

  responses.forEach((res, i) => {
    const rule = rules[i];
    const code = res.getResponseCode();
    if (code !== 200) {
      console.warn(`抓取失敗 ${rule.board} ${rule.type}=${rule.value}: HTTP ${code}`);
      return;
    }
    const firstRun = !inited.has(rule.key);
    parseList_(res.getContentText()).forEach(post => {
      if (rule.type === '推文數' && post.score < Number(rule.value)) return;
      const seenKey = rule.key + '#' + post.id;
      if (seen.has(seenKey)) return;
      if (firstRun) {
        silent.push(seenKey);
        return;
      }
      const hit = hits.get(post.id) || { post, board: rule.board, reasons: [], keys: [] };
      hit.reasons.push(`${rule.type}: ${rule.value}`);
      hit.keys.push(seenKey);
      hits.set(post.id, hit);
    });
    inited.add(rule.key);
  });

  const newSeen = silent.slice();
  // 依發文時間排序，舊的先送
  [...hits.values()]
    .sort((a, b) => a.post.id.localeCompare(b.post.id))
    .forEach(hit => {
      if (sendTelegram_(formatMessage_(hit))) newSeen.push(...hit.keys);
      Utilities.sleep(100);
    });

  saveSeen_(seenSheet, newSeen);
  props.setProperty('INIT_RULES', JSON.stringify([...inited]));
}

/* ---------- 設定 / 紀錄 ---------- */

/** 綁定在試算表上就用該試算表；獨立專案則用 setup() 建立的試算表（指令碼屬性 SHEET_ID） */
function getSpreadsheet_() {
  const active = SpreadsheetApp.getActive();
  if (active) return active;
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('找不到試算表，請先執行 setup()');
  return SpreadsheetApp.openById(id);
}

function loadRules_(ss) {
  const sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues()
    .filter(([enabled, board, type, value]) =>
      enabled === true && board && RULE_TYPES[type] && String(value).trim() !== '')
    .map(([, board, type, value]) => {
      board = String(board).trim();
      value = String(value).trim();
      return { board, type, value, key: `${board.toLowerCase()}|${type}|${value}` };
    });
}

function loadSeen_(sheet) {
  if (sheet.getLastRow() < 1) return new Set();
  return new Set(sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(r => r[0]));
}

function saveSeen_(sheet, keys) {
  if (!keys.length) return;
  const now = new Date();
  sheet.getRange(sheet.getLastRow() + 1, 1, keys.length, 2)
    .setValues(keys.map(k => [k, now]));
  const overflow = sheet.getLastRow() - MAX_SEEN;
  if (overflow > 0) sheet.deleteRows(1, overflow);
}

/* ---------- PTT ---------- */

function buildRequest_(rule) {
  const q = RULE_TYPES[rule.type](rule.value);
  return {
    url: `${PTT_BASE}/bbs/${encodeURIComponent(rule.board)}/search?q=${encodeURIComponent(q)}`,
    headers: { Cookie: 'over18=1' },
    muteHttpExceptions: true,
  };
}

/** 解析看板列表 / 搜尋結果頁，回傳文章陣列（已刪除的文章會略過） */
function parseList_(html) {
  // 置底文前有分隔線，只取分隔線之前的部分
  html = html.split('<div class="r-list-sep"></div>')[0];
  return html.split('<div class="r-ent">').slice(1).map(chunk => {
    const link = chunk.match(/<div class="title">\s*<a href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!link) return null;
    const nrec = (chunk.match(/<div class="nrec">(?:<span[^>]*>)?([^<]*)/) || [])[1] || '';
    const author = (chunk.match(/<div class="author">([^<]*)/) || [])[1] || '';
    const date = (chunk.match(/<div class="date">([^<]*)/) || [])[1] || '';
    const path = link[1];
    return {
      id: path.split('/').pop().replace('.html', ''),
      url: PTT_BASE + path,
      title: decodeEntities_(link[2].trim()),
      author: author.trim(),
      date: date.trim(),
      nrec: nrec.trim(),
      score: parseScore_(nrec.trim()),
    };
  }).filter(Boolean);
}

/** 推文數欄位：'' → 0、'爆' → 100、'X3' → -30、'XX' → -100 */
function parseScore_(nrec) {
  if (!nrec) return 0;
  if (nrec === '爆') return 100;
  if (nrec === 'XX') return -100;
  if (nrec[0] === 'X') return -10 * Number(nrec.slice(1));
  return Number(nrec) || 0;
}

function decodeEntities_(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/* ---------- Telegram ---------- */

function formatMessage_({ post, board, reasons }) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    `🔔 <b>[${esc(board)}]</b> ${esc(reasons.join('、'))}`,
    `<a href="${post.url}">${esc(post.title)}</a>`,
    `👍 ${post.nrec || '0'} · ${esc(post.author)} · ${post.date}`,
  ].join('\n');
}

function sendTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TG_TOKEN');
  const chatId = props.getProperty('TG_CHAT_ID');
  if (!token || !chatId) throw new Error('請先在指令碼屬性設定 TG_TOKEN 與 TG_CHAT_ID');
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    console.warn('Telegram 傳送失敗: ' + res.getContentText());
    return false;
  }
  return true;
}

/* ---------- 手動執行的工具函式 ---------- */

/** 建立工作表與定時觸發器（第一次手動執行一次） */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss = SpreadsheetApp.getActive();
  if (!ss && props.getProperty('SHEET_ID')) ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  if (!ss) {
    ss = SpreadsheetApp.create('PTT Alerter');
    props.setProperty('SHEET_ID', ss.getId());
  }
  let config = ss.getSheetByName(CONFIG_SHEET);
  if (!config) {
    const blank = ss.getSheets().length === 1 && ss.getSheets()[0].getLastRow() === 0 ? ss.getSheets()[0] : null;
    config = ss.insertSheet(CONFIG_SHEET);
    if (blank) ss.deleteSheet(blank);
    config.getRange(1, 1, 1, 5).setValues([['啟用', '看板', '類型', '條件值', '備註']]).setFontWeight('bold');
    config.getRange(2, 1, 3, 5).setValues([
      [true, 'Stock', '關鍵字', '台積電', '標題含關鍵字'],
      [false, 'Gossiping', '作者', 'someone', '特定作者發文'],
      [true, 'Stock', '推文數', '50', '推文數 ≥ 50'],
    ]);
    config.getRange('A2:A200').insertCheckboxes();
    config.getRange('C2:C200').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(RULE_TYPES)).build());
    config.setFrozenRows(1);
  }
  if (!ss.getSheetByName(SEEN_SHEET)) ss.insertSheet(SEEN_SHEET);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'main')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('main').timeBased().everyMinutes(TRIGGER_MINUTES).create();
  console.log(`完成：已建立工作表與每 ${TRIGGER_MINUTES} 分鐘的觸發器`);
  console.log('設定請到這個試算表編輯：' + ss.getUrl());
}

/** 測試 GAS 能否連到 PTT */
function testFetch() {
  const res = UrlFetchApp.fetch(`${PTT_BASE}/bbs/Gossiping/index.html`,
    { headers: { Cookie: 'over18=1' }, muteHttpExceptions: true });
  console.log('HTTP ' + res.getResponseCode());
  parseList_(res.getContentText()).slice(0, 5).forEach(p => console.log(JSON.stringify(p)));
}

/** 先對 bot 傳一則訊息，再執行這個函式，從 log 找到 chat id */
function getChatId() {
  const token = PropertiesService.getScriptProperties().getProperty('TG_TOKEN');
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  JSON.parse(res.getContentText()).result.forEach(u => {
    const chat = (u.message || u.channel_post || {}).chat;
    if (chat) console.log(`chat id: ${chat.id}  (${chat.title || chat.username || chat.first_name})`);
  });
}

function sendTestMessage() {
  console.log(sendTelegram_('✅ PTT Alerter 測試訊息') ? '已送出' : '失敗，請看 log');
}

/** 清除所有紀錄（重新開始時用） */
function resetState() {
  PropertiesService.getScriptProperties().deleteProperty('INIT_RULES');
  getSpreadsheet_().getSheetByName(SEEN_SHEET).clear();
}
