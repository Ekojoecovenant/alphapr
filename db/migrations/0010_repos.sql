-- Per-repository overrides (ADR 0002, phase P0 reads them; P1 writes them).
--
-- Every settings column is nullable on purpose: NULL means "inherit the
-- installation setting". A copy would freeze today's default into every repo and
-- changing the org-wide value would silently stop moving anything.
CREATE TABLE repos (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id      INTEGER NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  owner                TEXT NOT NULL,
  name                 TEXT NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1,
  provider             TEXT,
  model                TEXT,
  severity_threshold   TEXT,
  review_tone          TEXT,
  ignore_paths         TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (installation_id, owner, name)
);

CREATE INDEX idx_repos_installation ON repos(installation_id);
