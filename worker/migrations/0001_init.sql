CREATE TABLE rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  board       TEXT NOT NULL COLLATE NOCASE,
  type        TEXT NOT NULL,              -- 關鍵字 / 作者 / 推文數
  value       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  initialized INTEGER NOT NULL DEFAULT 0, -- 第一次執行只記錄、不通知
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (board, type, value)
);

CREATE TABLE seen (
  rule_id    INTEGER NOT NULL,
  post_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, post_id)
);
