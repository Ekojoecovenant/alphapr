-- Read-only teammates.
--
-- Until now the only way to see a dashboard was to be a GitHub admin of the
-- account the App is installed on. That is the right bar for *writing* — it
-- matches who can uninstall the App — but it excludes exactly the people who
-- want to look: a teammate who can push to the repo but is not an org admin.
--
-- An invite is a row here, keyed by GitHub login, not by user id: the person
-- may never have signed in, and their numeric id does not exist until they do.
-- The grant is applied at sign-in, and only for installations GitHub still
-- lists for that user, so revoking repo access revokes the view on next
-- sign-in without this table having to know anything about GitHub teams.
CREATE TABLE IF NOT EXISTS members (
  installation_id INTEGER NOT NULL,
  github_login    TEXT    NOT NULL,
  added_by        TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (installation_id, github_login)
);

CREATE INDEX IF NOT EXISTS idx_members_login ON members (lower(github_login));
