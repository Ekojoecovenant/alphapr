# ADR 0002 — Self-serve dashboard: sign in with GitHub, control repos, see what happened

- **Status:** proposed (2026-11-08)
- **Supersedes:** nothing
- **Builds on:** ADR 0001 (agentic toolbox deep-dive server) — that one is the *analysis* product; this one is the *account* product.

## Context

Today the only human-facing surface is `/setup`, and its authorization model is deliberately narrow:

- `/setup` starts a GitHub OAuth round trip, then calls `GET /user/installations` and filters the
  result through `getAuthorizedInstallations(userToken, installations)` in `src/setup.ts` so a mere
  repository collaborator cannot reconfigure an installation.
- The form is signed with an HMAC (`hmacSign` / `hmacVerify`) and replayed once; there is no session,
  no user record, and no way to come back later.
- Server-side state is one row per installation (`db/migrations/0003_add_installations.sql`:
  `installation_id`, `account_login`, `api_key_encrypted`, `model`, plus
  `severity_threshold`, `review_tone`, `ignore_paths` from `0004_add_config.sql`).
- Reviews land in `pr_reviews` keyed by `repo_full_name`, with `0008_add_review_usage.sql` adding
  `input_tokens` / `output_tokens`.

That is enough to run reviews and nothing else. Concretely, today:

1. A second admin on the same org cannot see or change anything without walking the whole install flow.
2. You cannot turn reviews off for one noisy repo without uninstalling the App.
3. You cannot see your review history, token spend, or why the last review failed — the "Key limit
   exceeded" incident was only visible in `wrangler tail`.
4. A user who installs the App and closes the tab has no way back in. CodeRabbit's whole funnel is
   *install → sign in → land on a dashboard that already knows your repos*.

Production evidence for the gap: 3 installations, 186 reviews across 15 repos, 0 user accounts.

## What competitors actually do (public surfaces, not internals)

Researched from public docs and marketing, since REA (a local reverse-engineering MCP) is not
installed here and is not needed to read a product's shape:

| Product | Sign-in | Core dashboard | Notable | Gap we can exploit |
| --- | --- | --- | --- | --- |
| CodeRabbit | GitHub (and GitLab) OAuth; org membership drives visibility | Org dashboard → repos list → per-repo enable + settings; seats page; usage/cost page; review history; custom instructions; "learnings" from review feedback | Seats + plan gating; IDE + CLI extensions; chat with the bot in the PR | Everything is gated behind a paid plan; model choice is theirs; no per-tenant key |
| Greptile | GitHub OAuth after App install | Org → repos → enable/disable, index status, custom context, analytics (reviews, findings) | "Codebase graph" indexing status surfaced in the UI | Review quality framed as indexing, not diff reasoning; still seat-priced |
| Qodo Merge | GitHub OAuth | Repo-level toggles, config via `.pr_agent.toml` in the repo, usage dashboard | Configuration lives in the repo, so it is reproducible in git but unreadable to non-devs | Repo-file config is a nice model we can support *in addition to* the UI |
| Graphite / Bugbot | GitHub | PR-centric UI, stacked diffs, review queue | Review is one pane among many in a PR tool | We are not building a PR client |
| Sourcery | GitHub | Repo toggles, per-repo style config | Simple | Same |

The consistent shape across all of them, and what we should copy:

**OAuth sign-in → install(s) discovered for you → dashboard of repos → per-repo on/off + settings →
history, usage, and health.** The differentiators are all *inside* that frame: CodeRabbit sells
breadth and chat, Greptile sells indexing, Qodo sells configurability.

## Decision

Ship a server-rendered dashboard on the same Worker and the same Split Signal design system. No SPA,
no build step, no new runtime dependency. Five phases, each independently shippable.

### 1. Identity and sessions

- **Sign in with GitHub** via the existing GitHub App's user authorization: `GET /auth/github` →
  `https://github.com/login/oauth/authorize?client_id=<GITHUB_CLIENT_ID>&scope=read:user&state=…`.
  The App already carries `GITHUB_CLIENT_ID`; `GITHUB_CLIENT_SECRET` is already a secret for `/setup`.
- Callback exchanges the code for a user access token, reads `GET /user`, and writes a `users` row.
  The token is **not** persisted — it is used once to discover installations, then dropped.
- Session = opaque `sid` in an `HttpOnly; Secure; SameSite=Lax; Path=/` cookie, stored server-side in
  `sessions` so logout and revocation are real. 30-day idle expiry, rotated on privilege change.
- Every dashboard POST is CSRF-guarded by a double-submit token signed with the existing HMAC helper,
  reusing `hmacSign` / `hmacVerify` from `src/setup.ts` rather than inventing a second scheme.
- Authorization rule, unchanged in spirit: a user may manage an installation if
  `getAuthorizedInstallations()` says so (own personal install, or org admin). Members without admin
  see the dashboard read-only, which is what a team actually wants.

### 2. Data model (migrations `0009`+)

```sql
-- 0009_users_sessions.sql
CREATE TABLE users (
  github_id   INTEGER PRIMARY KEY,
  login       TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,      -- random 32-byte hex
  user_id     INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  last_used_at TEXT
);

-- Which installations this person may see, and in what role. Written at sign-in
-- from the OAuth token's installation list; see "Deviation after P0" below.
CREATE TABLE user_installations (
  user_id         INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  account_login   TEXT NOT NULL,
  account_type    TEXT NOT NULL DEFAULT 'User',
  role            TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  seen_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, installation_id)
);

-- 0010_repos.sql
CREATE TABLE repos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  owner        TEXT NOT NULL,
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- NULL means "inherit the installation setting"
  provider              TEXT,
  model                 TEXT,
  severity_threshold    TEXT,
  review_tone           TEXT,
  ignore_paths          TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (installation_id, owner, name)
);

-- 0011_review_linkage.sql
ALTER TABLE pr_reviews ADD COLUMN installation_id INTEGER;
ALTER TABLE pr_reviews ADD COLUMN findings_count INTEGER;
ALTER TABLE pr_reviews ADD COLUMN suggestion_count INTEGER;

-- 0012_install_health.sql
ALTER TABLE installations ADD COLUMN last_error_code TEXT;
ALTER TABLE installations ADD COLUMN last_error_message TEXT;
ALTER TABLE installations ADD COLUMN last_error_at TEXT;
ALTER TABLE installations ADD COLUMN last_review_at TEXT;
```

Two rules that keep this honest:

- **`api_key_encrypted` never leaves the database.** The dashboard shows provider, a masked
  fingerprint (last 4 chars of a SHA-256 of the plaintext, not the key), and a "Replace key" form.
- **Per-repo settings are overrides, not copies.** `NULL` means inherit, so changing the org default
  still moves every repo that never overrode it.

#### Deviation recorded after P0 shipped (2026-11-08)

Two changes to the sketch above, both made because the original design quietly required storing a
user's GitHub token:

1. **`user_installations` exists.** Answering "which installations can this person see, and as what"
   needs the OAuth token's `/user/installations` list. Rather than persist that token (a standing
   credential, revocable at any moment, and a second thing to encrypt), the answer is snapshotted at
   sign-in: one row per (user, installation) with `account_login`, `account_type` and a `role` of
   `admin` (present in `getAuthorizedInstallations()`) or `member` (installed, but not an admin).
   The snapshot goes stale — a revoked install stays listed until the next sign-in — and that is the
   accepted cost. `GET /dashboard` re-derives nothing from GitHub except the repo list, which it must
   ask for anyway and which already fails per-installation without taking down the page.
2. **`installations.owner_user_id` / `account_type` were not added.** They existed to speed up the
   same question, and `user_installations` answers it with more precision (an installation can have
   several admins). `account_type` lives on the snapshot row. If P2's review history needs a
   per-installation owner label, it can read it from `user_installations` where `role = 'admin'`.

#### Narrowing recorded after P1 shipped (2026-11-09)

The route table below says `POST /dashboard/test-review` — "queue a review of the installation
owner's most recent open PR". What shipped is `POST /dashboard/installations/:id/test`, a single
16-token provider call, because a real test review needs a pull-request payload the dashboard does
not otherwise have, and would post a comment on somebody's branch to prove a point. The question
people actually ask is "is my key working", and one call answers it without touching a PR. The
narrower version also cannot be confused with a review that silently skipped.

Two more deviations landed with it, both recorded here because they change the interface this ADR
sketched:

- **Repo settings are addressed by installation, not by repository name.** The sketch had
  `/dashboard/repos/:owner/:name`. That path cannot resolve which installation owns the repo without a
  second GitHub call, and an unverified name would let a crafted path create a `repos` row for a
  repository the installation cannot see. The shipped route is
  `/dashboard/installations/:id/repos/:owner/:name`, and the POST re-checks the repository against
  `GET /installation/repositories` before writing.
- **Review memory moved to a tenant key.** `pr_reviews` was keyed `(repo_full_name, pr_number)`; two
  installations carrying the same `owner/name` shared a row. Migration `0014` re-keys it on
  `(installation_id, repo_full_name, pr_number)`, and P2's backfill therefore has nothing to backfill —
  rows written before the change carry `installation_id = 0` and are treated as belonging to nobody.

### 3. Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/auth/github` | GET | Start OAuth, signed `state` |
| `/auth/callback` | GET | Exchange code, upsert user, create session, redirect `/dashboard` |
| `/auth/logout` | POST | Delete session, clear cookie |
| `/dashboard` | GET | Installations + repos grid, health banner, recent reviews |
| `/dashboard/installations/:id` | GET | Repo list for one installation, key/health panel |
| `/dashboard/installations/:id/settings` | POST | Provider, model, severity, tone, ignore paths, key replacement |
| `/dashboard/repos/:owner/:name` | GET | Per-repo page: override form, review history for that repo |
| `/dashboard/repos/:owner/:name/settings` | POST | Enable/disable, overrides, reset-to-inherit |
| `/dashboard/reviews` | GET | Paginated review history with tokens, findings, status |
| `/dashboard/usage` | GET | Tokens and reviews per repo per month (from `pr_reviews`) |
| `/dashboard/test-review` | POST | Queue a review of the installation owner's most recent open PR |

`/setup` stays exactly as it is — it is the install-time path and it works. The dashboard's settings
form and `/setup` share the same validation module so they cannot drift.

### 4. Phasing

**P0 — identity + read-only dashboard (ship first, ~1 PR).** ✅ *Shipped in v1.8.0 (PR #46).*
Migrations 0009; `/auth/*`; `/dashboard` listing installations and repos read from GitHub, enabled
flag from `repos`; health banner fed by `last_error_*`. No writes yet. Acceptance: sign in with the
Ekojoecovenant account and see all three installations and their real repos; a non-admin sees the
same page without edit controls.

**P1 — writes + key management (~1 PR).** ✅ *Shipped in v1.9.0 (PR #49), v1.10.0 (PR #51), v1.10.2 (PR #53), v1.10.4 (PR #55), v1.10.5 (PR #56).*
Per-repo enable/disable and overrides; key replacement; a connection test in place of `test-review` (see
"Narrowing recorded after P1"). `src/index.ts` no longer ignores `repos.enabled` and per-repo overrides:
`shouldReviewRepo()` + `loadRepoConfig()` run before any GitHub call. Acceptance, as actually met: turning
a repo off suppresses the review *silently* — no status comment, no check run (the owner chose silence over
an announcement, which is the one place this ADR's original wording was changed by decision rather than by
constraint); a member can read every page the installation admin can and write none of them.

**P2 — history + usage (~1 PR).**
`/dashboard/reviews` and `/dashboard/usage`; per-review token cost rendered with the model's price table
(config file, not an API call). Acceptance: recent reviews are browsable with their token counts, and the
usage page matches D1. (The original sketch also promised a backfill of `installation_id` on existing
rows; migration `0014` already re-keyed the table, and pre-existing memory is deliberately unattributed,
so there is nothing left to backfill — see "Narrowing recorded after P1".)

**P3 — teams (~1 PR).**
Roles: owner/admin (from GitHub), member (read-only), plus an explicit `members` table so a
non-GitHub-admin teammate can be invited read-only. Seats are a count, not a limit, until there is a
billing story. Audit log table: who changed what, when.

**P4 — the parts competitors charge for, done our way.**
- **Memory inspector**: for any PR, show the stored `last_reviewed_sha`, the remembered body, and
  "forget this PR" — nobody else exposes their incremental state.
- **Learnings**: capture 👍/👎 reactions on our review comments (we already receive `issue_comment`
  and `reaction` webhooks) and turn them into per-repo custom instructions, with a diff-style review
  before saving.
- **Cost transparency**: per-review token count is already stored; show running spend per repo and a
  budget threshold that warns in the check run before a key limit is hit — the exact failure that bit us.
- **Failure replay**: one click re-queues the failed job from the DLQ payload.

### 5. Non-goals

- No PR client, no diff viewer beyond the sample review already on the landing page.
- No billing or payment integration until someone asks to pay.
- No SPA/React; keep the Worker serving HTML strings, consistent with `src/setup-pages.ts`.
- No persistence of GitHub user tokens. If a feature needs GitHub on the user's behalf later
  (e.g. listing private repos for a repo picker), it gets a scoped, expiring token with its own ADR.

## Consequences

- **Good:** a returning user, a team, and a support conversation all become possible. Health and usage
  turn the two worst support cases (dead key, silent skip) into self-service.
- **Good:** per-repo config is the highest-value feature per line of code — it removes the
  uninstall-to-disable workflow.
- **Cost:** the first real write path into `installations` from a browser. Session + CSRF handling is
  new attack surface; the mitigation is that authorization still funnels through
  `getAuthorizedInstallations()` rather than trusting anything the client sends.
- **Cost:** two config surfaces (`/setup` and the dashboard). Mitigated by one shared validator and a
  test asserting the two forms produce the same config object.
- **Risk:** backfilling `owner_user_id` is guesswork for the existing three installations. ~~Backfill
  by `account_login` only when the signing-in user's login matches; otherwise leave `NULL` and let the
  first admin claim it.~~ Moot — the column was never added (see "Deviation after P0"): the three
  existing installations appear for whoever the GitHub API says can administer them, which is exactly
  the behaviour that column was approximating.

## Open questions for the owner

Answered by the owner on 2026-11-08 ("all your recommendations"):

1. Can a signed-in non-admin *member* trigger a test review? — **Yes.** Read-only everywhere else,
   plus test-review, since it is idempotent and observable.
2. Page through `GET /installation/repositories` on first sign-in, or lazily per installation? —
   **Lazily.** `/dashboard` asks per installation on each load, which also means a repo added in
   GitHub shows up on refresh instead of waiting for a re-snapshot.
3. Is the dashboard the home of the agentic toolbox (ADR 0001)? — **Same shell, separate route**, so
   it inherits sign-in and the CSRF/session machinery for free.

## Audit follow-ups: closed, and deliberately deferred (2026-11-09)

The Cloudflare security-audit run against this app produced seven Tier 1 findings and a longer Tier 2
list. Everything in Tier 1 was shipped in v1.10.3-v1.10.6. Of the Tier 2 items, these are closed:

- **Uninstall now removes what hung off the installation** (grants, per-repo overrides, review memory),
  not just the `installations` row. Done in `deleteInstallation` rather than with a foreign key,
  because a user can sign in before the webhook that creates the installation row exists - an FK would
  reject that legitimate grant.
- **`/setup` edits a named installation.** `?installation=<id>` selects it; an unrecognised value
  falls back to the first authorized installation instead of silently showing someone else's config.
- **Provider error text is capped, `finish_reason=length` is named, and the check-run pager only
  follows `api.github.com` links** - see the v1.10.6 entry in the changelog.

These stay open on purpose, with the reason recorded so they are decisions rather than omissions:

| Item | Why it is not closed yet |
| --- | --- |
| `kid` + AAD in the ciphertext envelope | Changing the format means a migration for every stored key, and a rotation story that needs a second secret bound at deploy time. Worth a dedicated PR, not a hardening pass. |
| `__Host-` cookie prefix | Requires `Secure` unconditionally, which breaks `wrangler dev` over plain http. The cookies are already `HttpOnly`/`SameSite=Lax`/`Secure` in production. |
| Rate limiting | Every review is already bounded by Queues retries (2), the DLQ drain, and the free-tier budget; the remaining exposure is unauthenticated webhook bodies, now capped at 20 MB before they are read. |
| `redirect_uri` from the request host | GitHub validates the redirect against the App's registered callback URLs, so a poisoned `Host` produces a rejected redirect rather than a token leak. |
