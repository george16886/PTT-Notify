-- 每位使用者的檢查間隔（分鐘）與管理員設定的下限
-- 管理員本身也會有一列（status = 'admin'），由程式自動建立
ALTER TABLE users ADD COLUMN interval_min INTEGER NOT NULL DEFAULT 5;
ALTER TABLE users ADD COLUMN min_interval INTEGER NOT NULL DEFAULT 5;
