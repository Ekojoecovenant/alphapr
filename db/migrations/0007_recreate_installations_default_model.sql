-- db/migrations/0007_recreate_installations_default_model.sql
BEGIN TRANSACTION;

CREATE TABLE installations_new (
  installation_id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  api_key_encrypted TEXT,
  model TEXT NOT NULL DEFAULT 'deepseek/deepseek-v4-flash',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  severity_threshold TEXT NOT NULL DEFAULT 'all',
  review_tone TEXT NOT NULL DEFAULT 'thorough',
  ignore_paths TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'openrouter'
);

INSERT INTO installations_new
  (installation_id, account_login, api_key_encrypted, model, created_at, severity_threshold, review_tone, ignore_paths, provider)
SELECT
  installation_id, account_login, api_key_encrypted, model, created_at, severity_threshold, review_tone, ignore_paths, provider
FROM installations;

DROP TABLE installations;
ALTER TABLE installations_new RENAME TO installations;

COMMIT;
