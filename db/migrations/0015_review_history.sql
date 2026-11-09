-- Review history (ADR 0002, phase P2).
--
-- `pr_reviews` keeps only the most recent review per pull request, because that
-- is what incremental reviewing needs: the last SHA and the last body. It is a
-- memory, not a record. This table is the record — one row per review we posted,
-- kept so the dashboard can answer "what has this installation actually been
-- doing, and what has it cost".
--
-- Nothing reads it on the hot path: if a write here fails the review still ships.
CREATE TABLE IF NOT EXISTS review_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_review_history_installation ON review_history (installation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_history_repo ON review_history (repo_full_name, created_at DESC);
