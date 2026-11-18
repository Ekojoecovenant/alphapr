-- Who changed what, and when.
--
-- Four write routes exist (key replacement, repo settings, repo reset, team
-- changes). None of them left a trace before this table, so an installation
-- could not answer "who turned this repository off?", which is the first
-- question asked when reviews stop and nobody admits it.
--
-- `detail` is a small JSON string of before/after for the fields that changed.
-- It never holds a key: a key change records the masked hint instead.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL,
  actor_login TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_installation ON audit_log (installation_id, created_at DESC);
