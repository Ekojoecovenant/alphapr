-- Identity for the dashboard (ADR 0002, phase P0).
--
-- A user row is keyed by the immutable GitHub id, not the login: logins get
-- renamed, and every foreign key below would break if it did.
CREATE TABLE users (
  github_id    INTEGER PRIMARY KEY,
  login        TEXT NOT NULL,
  avatar_url   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

-- Sessions are rows, not signed cookies, so logout and revocation are real.
-- `id` is 32 random bytes of hex held in an HttpOnly cookie.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Server-side, expiring session ids are useless to a stolen-database attacker,
-- and easy to sweep.
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Which installations a signed-in user may see, and whether they administer
-- them. The GitHub user token is used once at sign-in and never stored, so this
-- snapshot is taken then and refreshed on every sign-in.
--
-- `account_login` is denormalised so the dashboard can still render an
-- installation whose webhook row has not arrived yet.
CREATE TABLE user_installations (
  user_id         INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  account_login   TEXT NOT NULL,
  account_type    TEXT NOT NULL DEFAULT 'User',
  role            TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  seen_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, installation_id)
);
