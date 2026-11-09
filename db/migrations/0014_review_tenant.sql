-- Review memory belongs to a tenant, not to a repository name (audit finding d).
--
-- `pr_reviews` was keyed by (repo_full_name, pr_number), so two installations
-- that both carried `acme/api` shared one row: one tenant's "last reviewed SHA"
-- and last review body could be read by the other. Uninstalling left the row
-- behind as well.
--
-- SQLite cannot add a column to a primary key, so the table is rebuilt. Legacy
-- rows are given `installation_id = 0`, which matches no real installation —
-- their memory is dropped rather than guessed, since the installation that wrote
-- them was never recorded and a wrong guess would recreate the leak.
--
-- A rebuild like this is only as safe as its worst interleaving, so the steps
-- are ordered to stay recoverable if the run is cut short:
--   * the leftover is dropped first, so re-running always starts clean;
--   * COPY happens before DROP, so the data is never gone before it is safe;
--   * if the run dies between DROP and RENAME, the finished copy is sitting in
--     pr_reviews_tenant and the repair is one statement:
--       ALTER TABLE pr_reviews_tenant RENAME TO pr_reviews;
DROP TABLE IF EXISTS pr_reviews_tenant;

CREATE TABLE pr_reviews_tenant (
    installation_id INTEGER NOT NULL,
    repo_full_name   TEXT    NOT NULL,
    pr_number        INTEGER NOT NULL,
    last_reviewed_sha TEXT   NOT NULL,
    last_review_body  TEXT,
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    reviewed_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (installation_id, repo_full_name, pr_number)
);

INSERT INTO pr_reviews_tenant
    (installation_id, repo_full_name, pr_number, last_reviewed_sha, last_review_body, input_tokens, output_tokens, reviewed_at)
SELECT 0, repo_full_name, pr_number, last_reviewed_sha, last_review_body, input_tokens, output_tokens, reviewed_at
FROM pr_reviews;

DROP TABLE pr_reviews;
ALTER TABLE pr_reviews_tenant RENAME TO pr_reviews;
