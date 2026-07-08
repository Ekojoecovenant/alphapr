CREATE TABLE IF NOT EXISTS pr_reviews (
    repo_full_name TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    last_reviewed_sha TEXT NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT (datetime ('now')),
    PRIMARY KEY (repo_full_name, pr_number)
);