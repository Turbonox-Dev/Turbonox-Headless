-- API Keys table for Chrome extension integration
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key TEXT UNIQUE NOT NULL,
  account_id INTEGER,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
