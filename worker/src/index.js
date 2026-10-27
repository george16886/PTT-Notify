/**
 * PTT Notify — Cloudflare Workers + D1 + Telegram
 *
 * 追蹤 PTT 看板：標題關鍵字 / 特定作者 / 推文數門檻，符合時推播到 Telegram。
 * 規則用 Telegram 指令管理（/add、/list、/del…），資料存在 D1。
 *
 * Secrets（wrangler secret put）：
 *   TG_TOKEN           Telegram Bot token
 *   TG_CHAT_ID         接收通知、允許下指令的 chat id
 *   TG_WEBHOOK_SECRET  Telegram webhook 的 secret_token
 */

const PTT_BASE = 'https://www.ptt.cc';
const SEEN_KEEP_PER_RULE = 100;   // 每條規則保留的已通知紀錄數

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
/del 編號 — 刪除規則
/off 編號、/on 編號 — 暫停 / 恢復規則
/check — 立即檢查一次

新規則第一次檢查只記錄現有文章、不通知。`;

// 常駐選單按鈕 → 對應指令
const MENU = {
  '📋 規則列表': '/list',
  '➕ 新增規則': '/add',
  '🔄 立即檢查': '/check',
  '❓ 說明': '/help',
};
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📋 規則列表' }, { text: '➕ 新增規則' }],
    [{ text: '🔄 立即檢查' }, { text: '❓ 說明' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
// Telegram 左下角「Menu」的指令清單
const COMMANDS = [
  { command: 'list', description: '列出規則' },
  { command: 'add', description: '新增規則' },
  { command: 'check', description: '立即檢查一次' },
  { command: 'help', description: '說明' },
];
// 按「新增規則」後的提示；使用者回覆這則訊息時視為 /add
const ADD_PROMPT = '請回覆：看板 類型 條件值';
const ACTION_LABEL = { del: '已刪除', on: '已恢復', off: '已暫停' };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env));
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
    return new Response('PTT Notify');
  },
};

/* ---------- 定時檢查 ---------- */

async function check(env) {
  const { results: rules } = await env.DB.prepare('SELECT * FROM rules WHERE enabled = 1').all();
  if (!rules.length) return;

  const { results: seenRows } = await env.DB.prepare('SELECT rule_id, post_id FROM seen').all();
  const seen = new Set(seenRows.map(r => r.rule_id + '#' + r.post_id));

  const lists = await Promise.all(rules.map(rule =>
    fetchPosts(rule).catch(e => {
      console.warn(`抓取失敗 ${rule.board} ${rule.type}=${rule.value}: ${e.message}`);
      return null;
    })));

  const hits = new Map();   // 文章 id → { post, board, reasons, ruleIds }
  const newSeen = [];       // [rule_id, post_id]
  const inited = [];

  rules.forEach((rule, i) => {
    if (!lists[i]) return;
    lists[i].forEach(post => {
      if (rule.type === '推文數' && post.score < Number(rule.value)) return;
      if (seen.has(rule.id + '#' + post.id)) return;
      if (!rule.initialized) {
        newSeen.push([rule.id, post.id]);
        return;
      }
      const hit = hits.get(post.id) || { post, board: rule.board, reasons: [], ruleIds: [] };
      hit.reasons.push(`${rule.type}: ${rule.value}`);
      hit.ruleIds.push(rule.id);
      hits.set(post.id, hit);
    });
    if (!rule.initialized) inited.push(rule.id);
  });

  // 依發文時間排序，舊的先送
  const sorted = [...hits.values()].sort((a, b) => a.post.id.localeCompare(b.post.id));
  for (const hit of sorted) {
    if (await sendMessage(env, env.TG_CHAT_ID, formatPost(hit))) {
      hit.ruleIds.forEach(id => newSeen.push([id, hit.post.id]));
    }
  }

  const now = Date.now();
  const stmts = [
    ...newSeen.map(([ruleId, postId]) => env.DB
      .prepare('INSERT OR IGNORE INTO seen (rule_id, post_id, created_at) VALUES (?, ?, ?)')
      .bind(ruleId, postId, now)),
    ...inited.map(id => env.DB.prepare('UPDATE rules SET initialized = 1 WHERE id = ?').bind(id)),
  ];
  if (!stmts.length) return;
  // 每條規則只保留最新的 N 筆（文章 id 含時間戳，可直接排序）
  stmts.push(env.DB.prepare(`
    DELETE FROM seen WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (PARTITION BY rule_id ORDER BY post_id DESC) AS rn FROM seen
      ) WHERE rn > ?
    )`).bind(SEEN_KEEP_PER_RULE));
  await env.DB.batch(stmts);
}

/* ---------- PTT ---------- */

async function fetchPosts(rule) {
  const q = RULE_TYPES[rule.type](rule.value);
  const res = await fetch(`${PTT_BASE}/bbs/${encodeURIComponent(rule.board)}/search?q=${encodeURIComponent(q)}`, {
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

function formatPost({ post, board, reasons }) {
  return [
    `🔔 <b>[${esc(board)}]</b> ${esc(reasons.join('、'))}`,
    `<a href="${post.url}">${esc(post.title)}</a>`,
    `👍 ${post.nrec || '0'} · ${esc(post.author)} · ${post.date}`,
  ].join('\n');
}

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn(`Telegram ${method} 失敗: ` + await res.text());
    return false;
  }
  return true;
}

function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
  });
}

/** 規則列表與每條規則的暫停 / 刪除按鈕 */
async function renderList(env) {
  const { results } = await env.DB.prepare('SELECT * FROM rules ORDER BY id').all();
  if (!results.length) {
    return { text: '目前沒有規則，按「➕ 新增規則」或用 /add 新增', markup: { inline_keyboard: [] } };
  }
  return {
    text: results.map(r =>
      `#${r.id} ${r.enabled ? '✅' : '⏸'} [${esc(r.board)}] ${r.type}: ${esc(r.value)}`).join('\n'),
    markup: {
      inline_keyboard: results.map(r => [
        { text: `${r.enabled ? '⏸ 暫停' : '▶️ 恢復'} #${r.id}`, callback_data: `toggle:${r.id}` },
        { text: `🗑 刪除 #${r.id}`, callback_data: `delask:${r.id}` },
      ]),
    },
  };
}

/** 刪除 / 恢復 / 暫停規則，回傳是否有找到該規則 */
async function applyRuleAction(env, action, id) {
  const sqls = {
    del: ['DELETE FROM rules WHERE id = ?', 'DELETE FROM seen WHERE rule_id = ?'],
    // 恢復時重新「第一次執行」，避免暫停期間累積的文章一次洗版
    on: ['UPDATE rules SET enabled = 1, initialized = 0 WHERE id = ?'],
    off: ['UPDATE rules SET enabled = 0 WHERE id = ?'],
  }[action];
  const [res] = await env.DB.batch(sqls.map(sql => env.DB.prepare(sql).bind(id)));
  return res.meta.changes > 0;
}

async function handleCallback(cb, env) {
  const msg = cb.message;
  if (!msg || String(msg.chat.id) !== String(env.TG_CHAT_ID)) return;
  const [action, idStr] = (cb.data || '').split(':');
  const id = Number(idStr);
  const target = { chat_id: msg.chat.id, message_id: msg.message_id };

  if (action === 'delask') {
    await tg(env, 'editMessageReplyMarkup', {
      ...target,
      reply_markup: { inline_keyboard: [[
        { text: `✅ 確定刪除 #${id}`, callback_data: `del:${id}` },
        { text: '取消', callback_data: 'list' },
      ]] },
    });
    return tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
  }

  let notice = '';
  if (action === 'toggle' || action === 'del') {
    let act = 'del';
    if (action === 'toggle') {
      const rule = await env.DB.prepare('SELECT enabled FROM rules WHERE id = ?').bind(id).first();
      act = rule && rule.enabled ? 'off' : 'on';
    }
    notice = await applyRuleAction(env, act, id) ? `${ACTION_LABEL[act]} #${id}` : `找不到規則 #${id}`;
  }
  const view = await renderList(env);
  await tg(env, 'editMessageText', { ...target, text: view.text, parse_mode: 'HTML', reply_markup: view.markup });
  return tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: notice });
}

async function handleUpdate(update, env, ctx) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  if (chatId !== String(env.TG_CHAT_ID)) return; // 只接受指定 chat 的指令

  let text = msg.text.trim();
  if (MENU[text]) {
    text = MENU[text];
  } else if (!text.startsWith('/') && (msg.reply_to_message?.text || '').startsWith(ADD_PROMPT)) {
    text = '/add ' + text;
  }
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  const reply = (text, extra) => sendMessage(env, chatId, text, extra);

  switch (cmd) {
    case '/start':
      await tg(env, 'setMyCommands', { commands: COMMANDS });
      // fallthrough
    case '/help':
      return reply(HELP, { reply_markup: MAIN_KEYBOARD });

    case '/list': {
      const view = await renderList(env);
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
      try {
        await fetchPosts({ board, type, value });
      } catch (e) {
        return reply(`無法讀取看板 ${esc(board)}（${esc(e.message)}），請確認看板名稱`);
      }
      try {
        const row = await env.DB
          .prepare('INSERT INTO rules (board, type, value) VALUES (?, ?, ?) RETURNING id')
          .bind(board, type, value).first();
        return reply(`已新增 #${row.id} [${esc(board)}] ${type}: ${esc(value)}`);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return reply('這條規則已經存在');
        throw e;
      }
    }

    case '/del':
    case '/on':
    case '/off': {
      const id = parseInt(args[0], 10);
      if (!id) return reply(`用法：${cmd} 編號（用 /list 查看）`);
      const action = cmd.slice(1);
      if (!await applyRuleAction(env, action, id)) return reply(`找不到規則 #${id}`);
      return reply(`${ACTION_LABEL[action]} #${id}`);
    }

    case '/check':
      ctx.waitUntil(check(env));
      return reply('開始檢查…');

    default:
      return reply('不認得的指令，輸入 /help 查看用法');
  }
}
