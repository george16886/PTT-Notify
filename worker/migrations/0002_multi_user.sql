-- 多使用者：使用者白名單，規則加上擁有者 chat_id

CREATE TABLE users (
  chat_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending / allowed / blocked
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- SQLite 無法修改 UNIQUE 條件，重建 rules。
-- 既有規則的 chat_id 先留 NULL，程式執行時會歸給管理員（TG_CHAT_ID）。
CREATE TABLE rules_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT,
  board       TEXT NOT NULL COLLATE NOCASE,
  type        TEXT NOT NULL,              -- 關鍵字 / 作者 / 推文數
  value       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  initialized INTEGER NOT NULL DEFAULT 0, -- 第一次執行只記錄、不通知
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chat_id, board, type, value)
);

INSERT INTO rules_new (id, chat_id, board, type, value, enabled, initialized, created_at)
  SELECT id, NULL, board, type, value, enabled, initialized, created_at FROM rules;

DROP TABLE rules;
ALTER TABLE rules_new RENAME TO rules;
CREATE INDEX rules_chat_id ON rules (chat_id);
