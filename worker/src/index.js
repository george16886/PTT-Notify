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

const HELP = `<b>PTT Notify 指令</b>
/list — 列出規則
/add 看板 類型 條件值 — 新增規則
　類型：關鍵字 / 作者 / 推文數
　例：<code>/add Stock 關鍵字 台積電</code>
　　　<code>/add Stock 推文數 50</code>
/del 編號 — 刪除規則
/off 編號、/on 編號 — 暫停 / 恢復規則
/check — 立即檢查一次

新規則第一次檢查只記錄現有文章、不通知。`;

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

async function sendMessage(env, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) {
    console.warn('Telegram 傳送失敗: ' + await res.text());
    return false;
  }
  return true;
}

async function handleUpdate(update, env, ctx) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  if (chatId !== String(env.TG_CHAT_ID)) return; // 只接受指定 chat 的指令

  const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  const reply = text => sendMessage(env, chatId, text);

  switch (cmd) {
    case '/start':
    case '/help':
      return reply(HELP);

    case '/list': {
      const { results } = await env.DB.prepare('SELECT * FROM rules ORDER BY id').all();
      if (!results.length) return reply('目前沒有規則，用 /add 新增');
      return reply(results.map(r =>
        `#${r.id} ${r.enabled ? '✅' : '⏸'} [${esc(r.board)}] ${r.type}: ${esc(r.value)}`).join('\n'));
    }

    case '/add': {
      if (args.length < 3) return reply('用法：/add 看板 類型 條件值\n例：/add Stock 關鍵字 台積電');
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
      const sql = {
        '/del': 'DELETE FROM rules WHERE id = ?',
        // 恢復時重新「第一次執行」，避免暫停期間累積的文章一次洗版
        '/on': 'UPDATE rules SET enabled = 1, initialized = 0 WHERE id = ?',
        '/off': 'UPDATE rules SET enabled = 0 WHERE id = ?',
      }[cmd];
      const stmts = [env.DB.prepare(sql).bind(id)];
      if (cmd === '/del') stmts.push(env.DB.prepare('DELETE FROM seen WHERE rule_id = ?').bind(id));
      const [res] = await env.DB.batch(stmts);
      if (!res.meta.changes) return reply(`找不到規則 #${id}`);
      return reply({ '/del': '已刪除', '/on': '已恢復', '/off': '已暫停' }[cmd] + ` #${id}`);
    }

    case '/check':
      ctx.waitUntil(check(env));
      return reply('開始檢查…');

    default:
      return reply('不認得的指令，輸入 /help 查看用法');
  }
}
