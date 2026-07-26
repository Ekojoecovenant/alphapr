-- migrations/0003_add_installations.sql
CREATE TABLE IF NOT EXISTS installations (
    installation_id INTEGER PRIMARY KEY,
    account_login TEXT NOT NULL,
    api_key_encrypted TEXT,
    model TEXT NOT NULL DEFAULT 'deepseek/deepseek-v4-pro',
    created_at TEXT NOT NULL DEFAULT (datetime ('now'))
);

--