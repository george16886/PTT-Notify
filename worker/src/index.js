/**
 * PTT Notify — Cloudflare Workers + D1 + Telegram
 *
 * 追蹤 PTT 看板：標題關鍵字 / 特定作者 / 推文數門檻，符合時推播到 Telegram。
 * 規則用 Telegram 指令與按鈕管理，資料存在 D1。
 * 可多人共用：其他人傳訊息給 bot 會送出申請，管理員核准後即可使用（每人各自的規則）。
 *
 * Secrets（wrangler secret put）：
 *   TG_TOKEN           Telegram Bot token
 *   TG_CHAT_ID         管理員的 chat id
 *   TG_WEBHOOK_SECRET  Telegram webhook 的 secret_token（只能用英數字、_、-）
 *
 * 部署後打開 https://<worker 網址>/setup?key=<TG_WEBHOOK_SECRET> 設定 webhook 與指令選單。
 */

const PTT_BASE = 'https://www.ptt.cc';
const SEEN_KEEP_PER_RULE = 100;   // 每條規則保留的已通知紀錄數
const MAX_RULES_PER_USER = 10;    // 一般使用者的規則上限（管理員不限）
// 可選的檢查間隔（分鐘），都能整除 60，排程每分鐘觸發時以「分鐘數 % 間隔」判斷是否輪到
const INTERVALS = [1, 2, 5, 10, 15, 30, 60];

// 類型 → PTT 搜尋語法
const RULE_TYPES = {
  '關鍵字': v => v,
  '作者': v => 'author:' + v,
  '推文數': v => 'recommend:' + v,
};
const TYPE_ALIASES = {
  keyword: '關鍵字', kw: '關鍵字',
  author: '作者',
  recommend: '推文數', push: '推文數',
};

const HELP = `<b>PTT Notify</b>
用下方按鈕操作，或輸入指令：
/list — 列出規則（可直接按按鈕暫停 / 刪除）
/add 看板 類型 條件值 — 新增規則
　類型：關鍵字 / 作者 / 推文數
　例：<code>/add Stock 關鍵字 台積電</code>
　　　<code>/add Stock 推文數 50</code>
/del 序號 — 刪除規則（序號見 /list）
/off 序號、/on 序號 — 暫停 / 恢復規則
/check — 立即檢查一次
/interval — 設定自動檢查頻率

新規則第一次檢查只記錄現有文章、不通知。`;
const ADMIN_HELP = `\n\n<b>管理員</b>\n/users — 管理使用者（核准 / 停用、檢查頻率下限）`;

// 常駐選單按鈕 → 對應指令
const MENU = {
  '📋 規則列表': '/list',
  '➕ 新增規則': '/add',
  '🔄 立即檢查': '/check',
  '⏱ 檢查頻率': '/interval',
  '❓ 說明': '/help',
  '👥 使用者': '/users',
};
const keyboard = admin => ({
  keyboard: [
    [{ text: '📋 規則列表' }, { text: '➕ 新增規則' }],
    [{ text: '🔄 立即檢查' }, { text: '⏱ 檢查頻率' }],
    [{ text: '❓ 說明' }, ...(admin ? [{ text: '👥 使用者' }] : [])],
  ],
  resize_keyboard: true,
  is_persistent: true,
});
// Telegram 左下角「Menu」的指令清單
const COMMANDS = [
  { command: 'list', description: '列出規則' },
  { command: 'add', description: '新增規則' },
  { command: 'check', description: '立即檢查一次' },
  { command: 'interval', description: '設定檢查頻率' },
  { command: 'help', description: '說明' },
];
const ADMIN_COMMANDS = [...COMMANDS, { command: 'users', description: '管理使用者' }];
// 按「新增規則」後的提示；使用者回覆這則訊息時視為 /add
const ADD_PROMPT = '請回覆：看板 類型 條件值';
const ACTION_LABEL = { del: '已刪除', on: '已恢復', off: '已暫停' };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env, { now: event.scheduledTime }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/telegram') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        await handleUpdate(await request.json(), env, ctx);
      } catch (e) {
        console.error('處理 Telegram 訊息失敗', e);
      }
      return new Response('ok'); // 一律回 200，避免 Telegram 重送
    }
    if (url.pathname === '/setup') return setup(env, url);
    return new Response('PTT Notify');
  },
};

/** 設定 webhook 與指令選單：GET /setup?key=<TG_WEBHOOK_SECRET> */
async function setup(env, url) {
  const secret = env.TG_WEBHOOK_SECRET || '';
  if (!secret || url.searchParams.get('key') !== secret) return new Response('forbidden', { status: 403 });
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    return new Response('TG_WEBHOOK_SECRET 只能包含英數字、_、-，請重新設定', { status: 400 });
  }
  await ensureAdmin(env);
  const result = {
    setWebhook: await tg(env, 'setWebhook', {
      url: `${url.origin}/telegram`, secret_token: secret, allowed_updates: ['message', 'callback_query'],
    }),
    setMyCommands: await tg(env, 'setMyCommands', { commands: COMMANDS }),
    setAdminCommands: await tg(env, 'setMyCommands', {
      commands: ADMIN_COMMANDS, scope: { type: 'chat', chat_id: env.TG_CHAT_ID },
    }),
  };
  return Response.json(result, { status: Object.values(result).every(r => r.ok) ? 200 : 500 });
}

/* ---------- 使用者 ---------- */

const isAdmin = (env, chatId) => String(chatId) === String(env.TG_CHAT_ID);

async function hasAccess(env, chatId) {
  if (isAdmin(env, chatId)) return true;
  const user = await env.DB.prepare('SELECT status FROM users WHERE chat_id = ?').bind(String(chatId)).first();
  return user?.status === 'allowed';
}

/** 確保管理員在 users 有一列（存檢查間隔），並把舊版（單人）沒有擁有者的規則歸給管理員 */
function ensureAdmin(env) {
  const admin = String(env.TG_CHAT_ID);
  return env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO users (chat_id, name, status, interval_min, min_interval)
      VALUES (?, '管理員', 'admin', 1, 1)`).bind(admin),
    env.DB.prepare('UPDATE rules SET chat_id = ? WHERE chat_id IS NULL').bind(admin),
  ]);
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** 使用者自己的檢查頻率設定畫面（只能選管理員設定的下限以上） */
async function renderInterval(env, chatId) {
  const u = await env.DB.prepare('SELECT interval_min, min_interval FROM users WHERE chat_id = ?').bind(chatId).first();
  const limit = u.min_interval > 1 ? `（管理員設定最快 ${u.min_interval} 分鐘）` : '';
  return {
    text: `⏱ 目前每 ${u.interval_min} 分鐘自動檢查一次${limit}\n選擇新的檢查頻率：`,
    markup: {
      inline_keyboard: chunk(INTERVALS.filter(n => n >= u.min_interval).map(n => ({
        text: `${n === u.interval_min ? '✓ ' : ''}${n} 分`, callback_data: `interval:${n}`,
      })), 4),
    },
  };
}

/** 管理員設定某位使用者的檢查頻率下限；使用者目前的間隔比下限快時一併調慢 */
async function setMinInterval(env, chatId, minutes) {
  const user = await env.DB.prepare(`
    UPDATE users SET min_interval = ?, interval_min = MAX(interval_min, ?)
    WHERE chat_id = ? AND status != 'admin' RETURNING *`).bind(minutes, minutes, chatId).first();
  if (user) {
    await sendMessage(env, chatId,
      `⏱ 管理員將你的最快檢查頻率設為 ${minutes} 分鐘，目前每 ${user.interval_min} 分鐘檢查一次`);
  }
  return user;
}

function chatName(chat) {
  if (chat.title) return `${chat.title}（群組）`;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || String(chat.id);
  return chat.username ? `${name} (@${chat.username})` : name;
}

async function requestAccess(env, chat) {
  const chatId = String(chat.id);
  const name = chatName(chat);
  await env.DB.prepare('INSERT OR IGNORE INTO users (chat_id, name) VALUES (?, ?)').bind(chatId, name).run();
  await sendMessage(env, chatId, '👋 這是私人的 PTT 通知 bot，已替你送出使用申請，管理員核准後會通知你。');
  await sendMessage(env, env.TG_CHAT_ID, `🙋 新的使用申請：${esc(name)}\nchat id：<code>${chatId}</code>`, {
    reply_markup: { inline_keyboard: [[
      { text: '✅ 核准', callback_data: `allow:${chatId}` },
      { text: '⛔ 拒絕', callback_data: `block:${chatId}` },
    ]] },
  });
}

/** 變更使用者狀態，回傳使用者（找不到則為 null） */
async function setUserStatus(env, chatId, status) {
  const user = await env.DB.prepare(`UPDATE users SET status = ? WHERE chat_id = ? AND status != 'admin' RETURNING *`)
    .bind(status, chatId).first();
  if (user && status === 'allowed') {
    await sendMessage(env, chatId, '✅ 管理員已核准，傳 /start 開始使用');
  }
  return user;
}

async function renderUsers(env) {
  const { results } = await env.DB.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM rules r WHERE r.chat_id = u.chat_id) AS rule_count
    FROM users u WHERE u.status != 'admin' ORDER BY u.created_at`).all();
  if (!results.length) return { text: '目前沒有其他使用者', markup: { inline_keyboard: [] } };
  const icon = { pending: '⏳', allowed: '✅', blocked: '⛔' };
  return {
    text: results.map((u, i) => `${i + 1}. ${icon[u.status] || '❔'} ${esc(u.name)}`
      + `（${u.rule_count} 條規則，每 ${u.interval_min} 分／最快 ${u.min_interval} 分）`).join('\n'),
    markup: {
      inline_keyboard: results.map((u, i) => [
        u.status === 'allowed'
          ? { text: `⛔ 停用 ${i + 1}`, callback_data: `block:${u.chat_id}` }
          : { text: `✅ 核准 ${i + 1}`, callback_data: `allow:${u.chat_id}` },
        { text: `⏱ 下限 ${i + 1}`, callback_data: `minask:${u.chat_id}` },
      ]),
    },
  };
}

/* ---------- 定時檢查 ---------- */

/**
 * 執行一次檢查，回傳統計（給 /check 的摘要用）。
 * 定時觸發：只檢查這一分鐘輪到的使用者（分鐘數 % 間隔 = 0）；/check：只檢查指定的 chat。
 */
async function check(env, { chat = null, now = Date.now() } = {}) {
  const stats = { rules: 0, sent: 0, sendFailed: 0, initedRules: 0, initedPosts: 0, fetchFailed: [] };

  await ensureAdmin(env);
  // 管理員與已核准使用者的規則
  let sql = `SELECT r.* FROM rules r JOIN users u ON u.chat_id = r.chat_id
    WHERE r.enabled = 1 AND u.status IN ('allowed', 'admin')`;
  const binds = [];
  if (chat) {
    sql += ' AND r.chat_id = ?';
    binds.push(chat);
  } else {
    sql += ' AND ? % u.interval_min = 0';
    binds.push(Math.round(now / 60000));
  }
  const { results: rules } = await env.DB.prepare(sql).bind(...binds).all();
  stats.rules = rules.length;
  if (!rules.length) return stats;

  const { results: seenRows } = await env.DB.prepare('SELECT rule_id, post_id FROM seen').all();
  const seen = new Set(seenRows.map(r => r.rule_id + '#' + r.post_id));

  // 相同的搜尋條件（不同使用者）只抓一次
  const queryKey = rule => `${rule.board.toLowerCase()}|${rule.type}|${rule.value}`;
  const pending = new Map();
  rules.forEach(rule => {
    const key = queryKey(rule);
    if (!pending.has(key)) pending.set(key, fetchPosts(rule).catch(e => ({ error: e.message })));
  });
  const lists = new Map(await Promise.all([...pending].map(async ([key, p]) => [key, await p])));

  const hits = new Map();   // chat_id#文章 id → { chatId, post, board, reasons, ruleIds }
  const newSeen = [];       // [rule_id, post_id]
  const inited = [];

  rules.forEach(rule => {
    const list = lists.get(queryKey(rule));
    if (list.error) {
      console.warn(`抓取失敗 ${rule.board} ${rule.type}=${rule.value}: ${list.error}`);
      stats.fetchFailed.push(`${ruleLabel(rule)}（${list.error}）`);
      return;
    }
    list.forEach(post => {
      if (rule.type === '推文數' && post.score < Number(rule.value)) return;
      if (seen.has(rule.id + '#' + post.id)) return;
      if (!rule.initialized) {
        newSeen.push([rule.id, post.id]);
        stats.initedPosts++;
        return;
      }
      const key = rule.chat_id + '#' + post.id;
      const hit = hits.get(key) || { chatId: rule.chat_id, post, board: rule.board, reasons: [], ruleIds: [] };
      hit.reasons.push(`${rule.type}: ${rule.value}`);
      hit.ruleIds.push(rule.id);
      hits.set(key, hit);
    });
    if (!rule.initialized) {
      inited.push(rule.id);
      stats.initedRules++;
    }
  });

  // 依發文時間排序，舊的先送
  const sorted = [...hits.values()].sort((a, b) => a.post.id.localeCompare(b.post.id));
  for (const hit of sorted) {
    if (await sendMessage(env, hit.chatId, formatPost(hit))) {
      hit.ruleIds.forEach(id => newSeen.push([id, hit.post.id]));
      stats.sent++;
    } else {
      stats.sendFailed++;
    }
  }

  const stmts = [
    ...newSeen.map(([ruleId, postId]) => env.DB
      .prepare('INSERT OR IGNORE INTO seen (rule_id, post_id, created_at) VALUES (?, ?, ?)')
      .bind(ruleId, postId, now)),
    ...inited.map(id => env.DB.prepare('UPDATE rules SET initialized = 1 WHERE id = ?').bind(id)),
  ];
  if (!stmts.length) return stats;
  // 每條規則只保留最新的 N 筆（文章 id 含時間戳，可直接排序）
  stmts.push(env.DB.prepare(`
    DELETE FROM seen WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (PARTITION BY rule_id ORDER BY post_id DESC) AS rn FROM seen
      ) WHERE rn > ?
    )`).bind(SEEN_KEEP_PER_RULE));
  await env.DB.batch(stmts);
  return stats;
}

function formatSummary(s) {
  if (!s.rules) return 'ℹ️ 目前沒有啟用中的規則';
  const ok = !s.fetchFailed.length && !s.sendFailed;
  const lines = [`${ok ? '✅' : '⚠️'} 檢查完成：${s.rules} 條規則，${s.sent ? `${s.sent} 篇新文章` : '沒有新文章'}`];
  if (s.initedRules) lines.push(`新規則 ${s.initedRules} 條已記錄現有 ${s.initedPosts} 篇（不通知）`);
  s.fetchFailed.forEach(f => lines.push('抓取失敗：' + esc(f)));
  if (s.sendFailed) lines.push(`通知傳送失敗 ${s.sendFailed} 則，下次檢查會重試`);
  return lines.join('\n');
}

/* ---------- PTT ---------- */

async function fetchPosts(rule) {
  const q = RULE_TYPES[rule.type](rule.value);
  // ptt.cc 的 CDN 會把搜尋結果快取很久（實測超過一小時），加時間戳避開快取
  const url = `${PTT_BASE}/bbs/${encodeURIComponent(rule.board)}/search?q=${encodeURIComponent(q)}&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { Cookie: 'over18=1', 'User-Agent': 'ptt-notify (+https://github.com/george16886/PTT-Notify)' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return parseList(await res.text());
}

/** 解析看板列表 / 搜尋結果頁，回傳文章陣列（已刪除的文章會略過） */
function parseList(html) {
  // 置底文前有分隔線，只取分隔線之前的部分
  html = html.split('<div class="r-list-sep"></div>')[0];
  return html.split('<div class="r-ent">').slice(1).map(chunk => {
    const link = chunk.match(/<div class="title">\s*<a href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!link) return null;
    const nrec = ((chunk.match(/<div class="nrec">(?:<span[^>]*>)?([^<]*)/) || [])[1] || '').trim();
    const author = (chunk.match(/<div class="author">([^<]*)/) || [])[1] || '';
    const date = (chunk.match(/<div class="date">([^<]*)/) || [])[1] || '';
    const path = link[1];
    return {
      id: path.split('/').pop().replace('.html', ''),
      url: PTT_BASE + path,
      title: decodeEntities(link[2].trim()),
      author: author.trim(),
      date: date.trim(),
      nrec,
      score: parseScore(nrec),
    };
  }).filter(Boolean);
}

/** 推文數欄位：'' → 0、'爆' → 100、'X3' → -30、'XX' → -100 */
function parseScore(nrec) {
  if (!nrec) return 0;
  if (nrec === '爆') return 100;
  if (nrec === 'XX') return -100;
  if (nrec[0] === 'X') return -10 * Number(nrec.slice(1));
  return Number(nrec) || 0;
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/* ---------- Telegram ---------- */

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ruleLabel = r => `[${r.board}] ${r.type}: ${r.value}`;

function formatPost({ post, board, reasons }) {
  return [
    `🔔 <b>[${esc(board)}]</b> ${esc(reasons.join('、'))}`,
    `<a href="${post.url}">${esc(post.title)}</a>`,
    `👍 ${post.nrec || '0'} · ${esc(post.author)} · ${post.date}`,
  ].join('\n');
}

/** 呼叫 Telegram Bot API，回傳 API 的回應（失敗時 ok 為 false） */
async function tg(env, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) console.warn(`Telegram ${method} 失敗: ${data.description}`);
    return data;
  } catch (e) {
    console.warn(`Telegram ${method} 失敗: ${e.message}`);
    return { ok: false, description: e.message };
  }
}

async function sendMessage(env, chatId, text, extra = {}) {
  const data = await tg(env, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
  });
  return data.ok;
}

/** 某個 chat 的規則列表與暫停 / 刪除按鈕；顯示連續序號，按鈕內部用資料庫 id */
async function renderList(env, chatId) {
  const { results } = await env.DB.prepare('SELECT * FROM rules WHERE chat_id = ? ORDER BY id').bind(chatId).all();
  if (!results.length) {
    return { text: '目前沒有規則，按「➕ 新增規則」或用 /add 新增', markup: { inline_keyboard: [] } };
  }
  return {
    text: results.map((r, i) => `${i + 1}. ${r.enabled ? '✅' : '⏸'} ${esc(ruleLabel(r))}`).join('\n'),
    markup: {
      inline_keyboard: results.map((r, i) => [
        { text: `${r.enabled ? '⏸ 暫停' : '▶️ 恢復'} ${i + 1}`, callback_data: `toggle:${r.id}` },
        { text: `🗑 刪除 ${i + 1}`, callback_data: `delask:${r.id}` },
      ]),
    },
  };
}

/** 刪除 / 恢復 / 暫停規則（限該 chat 自己的規則），回傳該規則（找不到則為 null） */
async function applyRuleAction(env, action, id, chatId) {
  const rule = await env.DB.prepare('SELECT * FROM rules WHERE id = ? AND chat_id = ?').bind(id, chatId).first();
  if (!rule) return null;
  const sqls = {
    del: ['DELETE FROM rules WHERE id = ?', 'DELETE FROM seen WHERE rule_id = ?'],
    // 恢復時重新「第一次執行」，避免暫停期間累積的文章一次洗版
    on: ['UPDATE rules SET enabled = 1, initialized = 0 WHERE id = ?'],
    off: ['UPDATE rules SET enabled = 0 WHERE id = ?'],
  }[action];
  await env.DB.batch(sqls.map(sql => env.DB.prepare(sql).bind(id)));
  return rule;
}

async function handleCallback(cb, env) {
  const msg = cb.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const [action, arg, arg2] = (cb.data || '').split(':');
  const target = { chat_id: msg.chat.id, message_id: msg.message_id };
  const answer = (text = '') => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text });
  const showUsers = async () => {
    const view = await renderUsers(env);
    await tg(env, 'editMessageText', { ...target, text: view.text, parse_mode: 'HTML', reply_markup: view.markup });
  };

  // 管理員：設定使用者的檢查頻率下限
  if (action === 'minask' || action === 'minset' || action === 'users') {
    if (!isAdmin(env, chatId)) return answer();
    if (action === 'minask') {
      await tg(env, 'editMessageReplyMarkup', {
        ...target,
        reply_markup: { inline_keyboard: [
          ...chunk(INTERVALS.map(n => ({ text: `最快 ${n} 分`, callback_data: `minset:${arg}:${n}` })), 4),
          [{ text: '取消', callback_data: 'users' }],
        ] },
      });
      return answer('選擇這位使用者最快可以多久檢查一次');
    }
    let notice = '';
    if (action === 'minset') {
      const minutes = Number(arg2);
      const user = INTERVALS.includes(minutes) && await setMinInterval(env, arg, minutes);
      notice = user ? `${user.name}：最快 ${minutes} 分鐘` : '找不到這位使用者';
    }
    await showUsers();
    return answer(notice);
  }

  // 管理員：核准 / 停用使用者（申請通知或使用者列表上的按鈕）
  if (action === 'allow' || action === 'block') {
    if (!isAdmin(env, chatId)) return answer();
    const user = await setUserStatus(env, arg, action === 'allow' ? 'allowed' : 'blocked');
    const result = user ? `${action === 'allow' ? '✅ 已核准' : '⛔ 已停用'} ${user.name}` : '找不到這位使用者';
    if ((msg.text || '').startsWith('🙋')) {
      await tg(env, 'editMessageText', { ...target, text: `${msg.text}\n\n${result}` });
    } else {
      await showUsers();
    }
    return answer(result);
  }

  if (!await hasAccess(env, chatId)) return answer();

  // 使用者：設定自己的檢查頻率（不能比管理員設定的下限快）
  if (action === 'interval') {
    const minutes = Number(arg);
    const user = INTERVALS.includes(minutes) && await env.DB.prepare(`
      UPDATE users SET interval_min = ? WHERE chat_id = ? AND min_interval <= ? RETURNING *`)
      .bind(minutes, chatId, minutes).first();
    const notice = user ? `已改為每 ${minutes} 分鐘檢查一次` : '無法設定這個頻率';
    const view = await renderInterval(env, chatId);
    await tg(env, 'editMessageText', { ...target, text: view.text, reply_markup: view.markup });
    return answer(notice);
  }

  const id = Number(arg);

  if (action === 'delask') {
    await tg(env, 'editMessageReplyMarkup', {
      ...target,
      reply_markup: { inline_keyboard: [[
        { text: '✅ 確定刪除', callback_data: `del:${id}` },
        { text: '取消', callback_data: 'list' },
      ]] },
    });
    return answer();
  }

  let notice = '';
  if (action === 'toggle' || action === 'del') {
    let act = 'del';
    if (action === 'toggle') {
      const rule = await env.DB.prepare('SELECT enabled FROM rules WHERE id = ? AND chat_id = ?').bind(id, chatId).first();
      act = rule && rule.enabled ? 'off' : 'on';
    }
    const rule = await applyRuleAction(env, act, id, chatId);
    notice = rule ? `${ACTION_LABEL[act]} ${ruleLabel(rule)}` : '找不到這條規則，可能已被刪除';
  }
  const view = await renderList(env, chatId);
  await tg(env, 'editMessageText', { ...target, text: view.text, parse_mode: 'HTML', reply_markup: view.markup });
  return answer(notice);
}

async function handleUpdate(update, env, ctx) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  const admin = isAdmin(env, chatId);
  const reply = (text, extra) => sendMessage(env, chatId, text, extra);

  if (admin) {
    await ensureAdmin(env);
  } else {
    const user = await env.DB.prepare('SELECT status FROM users WHERE chat_id = ?').bind(chatId).first();
    if (!user) return requestAccess(env, msg.chat);
    if (user.status === 'pending') return reply('⏳ 申請審核中，請等待管理員核准');
    if (user.status !== 'allowed') return; // 已停用：不回應
  }

  let text = msg.text.trim();
  if (MENU[text]) {
    text = MENU[text];
  } else if (!text.startsWith('/') && (msg.reply_to_message?.text || '').startsWith(ADD_PROMPT)) {
    text = '/add ' + text;
  }
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');

  switch (cmd) {
    case '/start':
    case '/help':
      return reply(HELP + (admin ? ADMIN_HELP : ''), { reply_markup: keyboard(admin) });

    case '/list': {
      const view = await renderList(env, chatId);
      return reply(view.text, { reply_markup: view.markup });
    }

    case '/users': {
      if (!admin) return reply('不認得的指令，輸入 /help 查看用法');
      const view = await renderUsers(env);
      return reply(view.text, { reply_markup: view.markup });
    }

    case '/interval': {
      const view = await renderInterval(env, chatId);
      return reply(view.text, { reply_markup: view.markup });
    }

    case '/add': {
      if (!args.length) {
        return reply(`${ADD_PROMPT}\n類型：關鍵字 / 作者 / 推文數\n例：<code>Stock 關鍵字 台積電</code>`, {
          reply_markup: { force_reply: true, input_field_placeholder: 'Stock 關鍵字 台積電' },
        });
      }
      if (args.length < 3) return reply('格式：看板 類型 條件值\n例：<code>Stock 關鍵字 台積電</code>');
      const board = args[0];
      const type = TYPE_ALIASES[args[1].toLowerCase()] || args[1];
      const value = args.slice(2).join(' ');
      if (!/^[A-Za-z0-9_-]+$/.test(board)) return reply('看板名稱格式不正確');
      if (!RULE_TYPES[type]) return reply('類型必須是：關鍵字 / 作者 / 推文數');
      if (type === '推文數' && !(Number.isInteger(+value) && +value >= 1 && +value <= 100)) {
        return reply('推文數請填 1～100 的整數（爆 = 100）');
      }
      if (!admin) {
        const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM rules WHERE chat_id = ?').bind(chatId).first();
        if (n >= MAX_RULES_PER_USER) return reply(`每人最多 ${MAX_RULES_PER_USER} 條規則，請先刪除不需要的規則`);
      }
      try {
        await fetchPosts({ board, type, value });
      } catch (e) {
        return reply(`無法讀取看板 ${esc(board)}（${esc(e.message)}），請確認看板名稱`);
      }
      try {
        await env.DB.prepare('INSERT INTO rules (chat_id, board, type, value) VALUES (?, ?, ?, ?)')
          .bind(chatId, board, type, value).run();
        return reply(`已新增 ${esc(ruleLabel({ board, type, value }))}`);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return reply('這條規則已經存在');
        throw e;
      }
    }

    case '/del':
    case '/on':
    case '/off': {
      // 序號 → 資料庫 id（序號即 /list 的排列順序）
      const pos = parseInt(args[0], 10);
      if (!(pos >= 1)) return reply(`用法：${cmd} 序號（用 /list 查看）`);
      const row = await env.DB.prepare('SELECT id FROM rules WHERE chat_id = ? ORDER BY id LIMIT 1 OFFSET ?')
        .bind(chatId, pos - 1).first();
      const action = cmd.slice(1);
      const rule = row && await applyRuleAction(env, action, row.id, chatId);
      if (!rule) return reply(`找不到第 ${pos} 條規則`);
      return reply(`${ACTION_LABEL[action]} ${esc(ruleLabel(rule))}`);
    }

    case '/check':
      await reply('開始檢查…');
      ctx.waitUntil(check(env, { chat: chatId })
        .then(stats => reply(formatSummary(stats)))
        .catch(e => reply('❌ 檢查失敗：' + esc(e.message))));
      return;

    default:
      return reply('不認得的指令，輸入 /help 查看用法');
  }
}
