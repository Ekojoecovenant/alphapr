# Changelog

All notable changes to AlphaPR are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [v1.10.5] — 2026-11-09

### Security

- **Review memory is keyed by installation, not by repository name.** `pr_reviews` was keyed `(repo_full_name, pr_number)`, so two tenants that both carried `acme/api` shared a single row: one installation's last reviewed SHA and previous review body were readable by the other, and uninstalling left the row behind. The table is rebuilt with `(installation_id, repo_full_name, pr_number)` as the key (migration `0014`); rows written before this have `installation_id = 0`, which matches no real installation, so that memory is dropped rather than mis-attributed to a tenant that never wrote it

### Changed

- `getReviewState` and `saveReviewState` in `src/db.ts` take the installation id as their second argument; the webhook dedupe check and the review handler both pass `installation.id`

## [v1.10.4] — 2026-11-09

### Security

- **The `/setup` form token is no longer a portable bearer credential.** It was a signed blob in a hidden field, valid for ten minutes and replayable by anyone who could read the page — a log, a screenshot, a shared browser, or an XSS elsewhere on the origin — and `/setup/save` had no session, no cookie binding and no CSRF field of its own. The token now carries a digest of a nonce cookie (`alphapr_setup_binding`, `HttpOnly`, `SameSite=Lax`, `Path=/setup`, ten minutes) that only the browser which completed the GitHub round trip holds, so the token alone buys nothing
- **Every HTML response now carries a Content Security Policy and the usual hardening headers** — `default-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`, an explicit `script-src`/`connect-src`, plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` and a `Permissions-Policy`, and `Cache-Control: no-store` on anything that reflects a signed-in view
- **three.js is loaded with a pinned version and Subresource Integrity** (`sha384-…` + `crossorigin`), so a compromised or substituted CDN response is refused by the browser and the page keeps the static scene it already drew
- **Sessions have an absolute seven-day cap** on top of the 30-day idle slide, and **writes require a session opened within a day**: an older session is sent back through GitHub (`/auth/github?next=…`) before the write is allowed, which refreshes the role snapshot that authorises it. `next` is accepted only as a same-origin path and never as a `//host`, a scheme or a backslash escape

### Changed

- The dashboard's message pages, sign-in pages and setup pages share one header set (`src/security.ts`) instead of each building its own `Content-Type`-only response

## [v1.10.3] — 2026-11-09

### Security

- **A pull request can no longer hide its own code from the reviewer.** `parseDiff` treated any line starting with `+++ ` as a file header, including a line inside a hunk. Because an added line whose content begins `++ b/dist/x` is transmitted as `+++ b/dist/x`, a PR author could switch the parser to a new (ignored) path and have every later line of the real file dropped from the annotated diff — a silent review bypass that still reported success. Headers are now only recognised before the first `@@` of a file and only inside a header zone opened by `diff --git`
- **Model output is neutralised before it is posted under the bot's identity.** Finding titles, bodies, suggestions, the verdict line and the raw fallback all pass through `sanitizeInline` / `sanitizeBlock`, which strip HTML and comments, break `@`-mentions with a zero-width space so an injected diff cannot ping people or teams, defuse link and image syntax, forbid a field from opening or closing a fence of its own, collapse runaway blank lines, and cap lengths (200 chars for titles, 4 000 for bodies and suggestions)
- **The review prompt is capped at 120 000 characters** of annotated diff (and 20 000 of previous-review context), truncated on a line boundary with an explicit `[diff truncated …]` note, so a hostile diff cannot drive an unbounded bill against `maxTokens: 16000` with up to three attempts
## [v1.10.2] — 2026-11-09

### Security

- **The dashboard no longer lists installations the signed-in user cannot administer.** GitHub's `GET /user/installations` returns every installation the user can reach, including ones where they only have access to a single repository — so an account they barely touch showed up alongside all of its other repositories (`zayn-tech-info`). Sign-in now stores only the installations returned by `getAuthorizedInstallations` (owner, or org admin with an active membership), the `member` snapshot branch is gone, and `loadInstallations` additionally filters on `role = 'admin'` so rows written before this release cannot reach the page either. The query never fires, so those repositories are never even fetched from GitHub
- Regression coverage: the sign-in test asserts only the administered installation is written, and a dashboard test asserts a member-only installation's name, repos and repository API call all stay off the page. The fake D1 honours the `role = 'admin'` filter instead of ignoring it, so a test can no longer pass while the leak is open

## [v1.10.1] — 2026-11-09

Signing in with GitHub worked — the redirect, the code exchange and the session row were all correct — but the browser never kept the cookie, so `/dashboard` kept showing the sign-in page and the button looked like it did nothing.

### Fixed

- **The session cookie now travels in its own `Set-Cookie` header.** The callback returned two cookies joined by `"; "` inside a single header, so the browser parsed the nonce-clearing cookie's `Max-Age=0` as an attribute of the session cookie and deleted the session the moment it was created (`src/auth.ts`). The response now appends one header per cookie, and the happy-path callback test asserts exactly two `Set-Cookie` values, the session one carrying `Max-Age=2592000` and no `Max-Age=0`

## [v1.10.0] — 2026-11-09

Phase P1 is complete: the dashboard can now do everything the setup form could, and one thing it could not.

### Added

- **Replace the provider key from the dashboard.** Each installation card carries a password input and a Save button (`POST /dashboard/installations/:id/key`). The key is encrypted before it is stored, the plaintext never round-trips, and only a four-character hint (`…wxyz`, new `installations.key_hint` in `db/migrations/0013_installation_key_hint.sql`) is ever rendered. Saving a key also clears the stored failure, because a new key is a new attempt
- **Test the provider** (`POST /dashboard/installations/:id/test`): one 16-token call with the stored key and model, answered on the page as "openrouter answered in 812 ms using deepseek/… — replied ok", or as a refusal quoting what the provider said. This is the check that would have caught the exhausted-key incident in one click instead of `wrangler tail`
- Both writes are admin-only and CSRF-checked, like every other write on the dashboard; members see the controls disabled

### Notes

- The ADR described this step as a "test review" of the newest open PR. What shipped is a connection test instead: it needs no PR payload, cannot post comments on someone's branch, and answers the question people actually have ("is my key working?"). Recorded as a narrowing in `docs/adr/0002-self-serve-dashboard.md`

### Tests

- 256 passing (was 249): seven in `test/dashboard-installation.spec.ts` — ciphertext stored with a four-char hint and no plaintext in the row, short key refused, member refused, missing CSRF refused, provider answered, provider refused, and no-key-to-test
## [v1.9.1] — 2026-11-09

Patch release: the five findings AlphaPR raised against its own PRs #46 and #49, fixed.

### Fixed

- **Sign out works again.** The top-bar form posted to `/auth/logout` without a CSRF token, so `verifyCsrf` rejected it every time and the button was a guaranteed 403. `ShellOptions` now carries `csrf`, and the form is not rendered when there is no token to send (PR #46, major)
- **Sessions expire after 30 days of *not* being used.** The deadline was written once at sign-in and never moved, so the README's "30 days idle" described a behaviour the code did not have. Each touch now slides `expires_at` alongside `last_used_at`, and every authenticated dashboard response re-issues the cookie so its `Max-Age` follows the same clock (PR #46, minor)
- **Enter now saves instead of wiping.** "Reset to inherit" came first in tree order, so pressing Enter in any text field submitted the destructive button. Save is first in the DOM; visual order is preserved with `flex-direction: row-reverse` (PR #49, major)
- A path with a malformed escape (`%zz`) answers 404 instead of throwing out of `decodeURIComponent` into a 500 (PR #49, minor)
- `severity_threshold` and `review_tone` are validated on POST against the values `src/review-config.ts` actually understands, so a crafted form cannot store a threshold that quietly means nothing (PR #49, minor)
- The "overridden" badge now appears on the severity and tone selects, not only on provider, model and ignored paths (PR #49, minor)

### Tests

- 249 passing, up from 243: six regression tests in `test/dashboard-writes.spec.ts` (CSRF in the sign-out form, Save-before-Reset order, malformed path, two validation refusals, both new badges) and one in `test/auth.spec.ts` asserting the touch also slides `expires_at`
## [v1.9.0] — 2026-11-09

### Added

- **Per-repo control, phase P1.** Every repository in the dashboard is now a link: `/dashboard/installations/:id/repos/:owner/:name` opens its settings. Uncheck "Review this repository" and reviews stop there — silently, with no comment and no check run, while the rest of the account keeps going. This was the one thing GitHub's own settings could not express short of uninstalling the App
- Per-repo overrides for provider, model, severity threshold, tone and ignored paths. Blank means inherit, and the form shows the installation's current default next to every field so the fallback is never a guess; fields that are overridden are tagged. "Reset to inherit" deletes the row rather than blanking values, so a later change on `/setup` reaches the repo again
- `POST /dashboard/installations/:id/repos/:owner/:name` is the write. It requires `admin` (members see the same page disabled), a valid CSRF token, and — before anything is written — a GitHub call confirming the repository really belongs to that installation, so a crafted path cannot create a row for a repo the installation cannot see. POST-redirect-GET, with a confirmation banner
- `src/review-config.ts`: `mergeRepoConfig` (pure, override-per-field), `loadRepoConfig`, `loadInstallationDefaults`, `shouldReviewRepo`, `saveRepoOverride`, `clearRepoOverride`. The review path resolves config through it instead of reading the installation row directly
- `shouldReviewRepo` fails **open**: if D1 cannot be read, the review runs. A database hiccup and a deliberate switch-off are indistinguishable from the outside, and the wrong guess here would silently stop reviews

### Changed

- `src/review-handler.ts` now takes the provider, model, key, severity, tone and ignore paths from the resolved repo config, so an override applies to the next review with no redeploy

### Notes

- 243 tests. 14 for the new write path (admin versus member, CSRF, foreign repo, foreign installation, blank-means-inherit, reset) and 16 for the merge semantics
- Still open on the dashboard: key replacement, test reviews, and review history — P1's remaining half plus P2/P3 in [ADR 0002](docs/adr/0002-self-serve-dashboard.md)
## [v1.8.0] — 2026-11-08

### Added

- **Self-serve dashboard, phase P0** ([ADR 0002](docs/adr/0002-self-serve-dashboard.md)). `GET /dashboard` is a read-only view of every installation you administer: account and your role on it (`admin`, or `member · read-only`), provider and model in force, whether a key is stored, the live repository list with each repo's on/off state, the last review time, and any provider failure quoted verbatim in a banner — the "Key limit exceeded" class of problem is now visible without `wrangler tail`
- GitHub sign-in at `/auth/github` → `/auth/callback`: `read:user` scope only, the OAuth access token is used once to read the profile and installation list and is never persisted. The installation/role snapshot is stored instead, in `user_installations`
- Server-side sessions: opaque 32-byte id in an `HttpOnly; SameSite=Lax` cookie, rows in D1 with a 30-day expiry, `last_used_at` touched at most hourly, and CSRF double-submit (reusing `hmacSign`) on sign-out. `GET /auth/github` carries a nonce-bound, 10-minute HMAC state
- Migration `0009_users_sessions.sql` (`users`, `sessions`, `user_installations`), `0010_repos.sql` (per-repo overrides — `NULL` means inherit from the installation), and `0012_install_health.sql` (`last_error_code`, `last_error_message`, `last_error_at`, `last_review_at` on `installations`)
- `src/setup-styles.ts` gained `DASHBOARD_STYLES` in the same token system, and the shell now knows whether the visitor is signed in (top-bar `/dashboard` link, sign-out form)
- Tests: `test/auth.spec.ts` (13) and `test/dashboard.spec.ts` (10) over a new in-memory D1 fake (`test/helpers/fake-d1.ts`). Suite 213

### Changed

- The top bar of the marketing pages links `/dashboard` once signed in; sign-out lives there, not on the dashboard itself
- Copy that claimed AlphaPR had no dashboard was rewritten (the `/setup` lede, and the landing section now titled "Three moves, then it stays out of the way")
- README: documents the dashboard, the second OAuth callback URL (`/auth/callback`), the new migrations, and the new source files

### Notes

- Nothing on the dashboard is writable yet. Per-repo toggles, key replacement, review history, usage and team access are phases P1–P3 of ADR 0002

## [v1.7.0] — 2026-11-08

### Changed

- The `/setup` pages are now the "Split Signal" design: paper-and-ink typography (Space Grotesk + DM Mono), hairline rules, one teal brand colour, and orange reserved for a single action. All colours are custom properties; the whole dark theme is the `data-theme` attribute on `<html>`, with a toggle in the top bar that persists the choice and is resolved before first paint so the page never flashes the wrong theme
- The landing page gained a sample review — a real line-anchored finding on `src/auth/session.ts` L42–L47 with a suggestion block and a working (labelled) Apply demo — plus the three-step flow and the three check-run states, including a failure card that quotes the provider error
- Extracted the styles into `src/setup-styles.ts`. The worker still serves plain HTML strings with no build step; the three.js hero scene stays a runtime CDN load with a static SVG fallback, never a bundled dependency
- Setup form: same field names, order and hints (so `src/setup.ts` is untouched), now two-column with per-field help, labels bound to their controls, and a real focus ring

### Added

- Design archive under `docs/design/` — the four concepts explored, with `00-index.html` comparing them and `04-split.html` being the shipped one
- `test/setup-pages.spec.ts` grew to 18 tests: provider-select exhaustiveness, the full save-path field set, escaping, label/id pairing, both theme token blocks, the pre-paint theme script, and that the Apply demo button is not a form submit
## [v1.6.0] — 2026-11-08

### Added

- Adapter contract tests: 50 tests over `fetch`-stubbed wire formats for all three providers, so a refactor that silently changes a request body or header can no longer pass CI. Mutation-checked — moving Anthropic's `system` into `messages` fails exactly one test, and forcing the reasoning budget always-on fails exactly the two decline-path tests
- `ProviderAdapter.supportsReasoning(model)` capability: each adapter now answers for itself whether a model accepts reasoning controls, replacing the single global marker list in `llm.ts`. Anthropic answers from a marker list because sending `thinking` to an unsupported model is a hard 400, so an unknown model gets no thinking block
- Review gate (`src/review-gate.ts`): `ready_for_review` now triggers a review, draft PRs are skipped, `[skip alphapr]` titles are honored, and a push to an already-reviewed commit is not reviewed twice. Skips are reported as a real conclusion ("Already reviewed") instead of leaving a permanent "Reviewing…" status
- Token accounting: every review records `input_tokens`/`output_tokens` (migration `0008`), shown on the check run as e.g. "12,431 tokens". `formatUsage()` returns null rather than fabricating a zero when a provider reports nothing
- Dead-letter queue consumer: jobs that exhaust retries are now surfaced on the PR with their attempt count and drained, instead of vanishing silently
- Provider errors are quoted in the failure comment. A provider 401/403 previously produced only "check your installation's configuration", hiding the actual reason — an exhausted OpenRouter key limit read as a configuration mystery. Details are sanitized (credential-shaped strings redacted, whitespace collapsed, `<`/`>` stripped, 300-char cap) before being posted to a PR
- OpenAI o-series support: reasoning models are detected by `/^o\d/` and sent `max_completion_tokens` + `reasoning_effort` (derived from the token budget) with the system prompt folded into the first user turn, since o-series rejects a `system` message
- Anthropic Messages API version bumped `2023-06-01` → `2026-10-21`; the only removals in that migration are `temperature`/`top_p`/`top_k` and block types this adapter does not send. Reasoning markers extended to the Claude 5 family
- Free-tier retry: one retry after a 2s backoff for transient failures — but only if the first attempt failed fast enough to leave room in the ~30s `waitUntil` budget. Permanent failures and slow failures are reported immediately; the path can never throw

### Fixed

- `package.json` version had drifted to `0.0.0`; the README migration list stopped at `0005` and now covers all eight migrations

[v1.6.0]: <https://github.com/Ekojoecovenant/alphapr/releases/tag/v1.6.0>

## [v1.5.0] — 2026-08-20

### Added

- `[skip alphapr]` PR title marker: when present (case-insensitive, anywhere in the title), AlphaPR skips the review entirely — no status comment, no check run, no LLM call. Checked before any GitHub API call is made, so a skipped PR costs nothing.
- `crypto.ts` test coverage: round-trip encryption, IV randomness (proving the IV is never reused), ciphertext tamper rejection, wrong-key rejection, malformed master-key and malformed-stored-value validation

[v1.5.0]: <https://github.com/Ekojoecovenant/alphapr/releases/tag/v1.5.0>

## [v1.4.0] — 2026-08-06

### Security

- Installation configuration is now restricted to account owners and organization admins. Previously, GitHub's `/user/installations` endpoint — which returns installations where the user has read, write, **or** admin access, including mere repository collaborators — was treated as sufficient authorization to change an installation's API key, model, and review settings. It is not. Personal-account installations now require a login match; organization installations require an active `admin` role.

### Added

- Branded setup and landing pages: real styling derived from the AlphaPR logo, served from a shared `setup-pages.ts` renderer, with the logo delivered via Cloudflare Workers Static Assets
- Provider selection in the setup page (OpenRouter verified in production; Anthropic and OpenAI selectable but unverified against live APIs)
- Reasoning-capable models are detected via an explicit marker list (`modelSupportsReasoning`) rather than an ad-hoc `-pro` substring check, so models like `deepseek-v4-flash-0731` get their reasoning budget correctly capped
- Output token budget raised to 16000 to accommodate reasoning models' thinking overhead
- Unit coverage for every authorization branch: owner kept, org admin kept, org member dropped, 404 dropped quietly, 403 dropped with a loud log, `/user` failure returns empty, admin-with-pending-invite dropped
- `PermanentError.cause` test coverage

### Fixed

- `PermanentError` was discarding its `cause` option — decryption failures lost their original error context
- The landing page at `/` was served without a `Content-Type` header, causing browsers to render raw HTML as plain text
- Unknown non-root paths returned the landing page with a `200` instead of a `404`
- HTML escaping moved into `setup-pages.ts` so the page module is safe by construction, instead of relying on every caller to escape correctly
- The setup form had no provider field, silently resetting every installation's provider back to `openrouter` on every config save
- Installations created via migration rather than the setup page defaulted to a slow reasoning model (`deepseek-v4-pro`) instead of the documented fast default; existing rows backfilled
- `User-Agent` header in `github/auth.ts` was misspelled `alphpr`
- `ADMIN_SECRET` was listed as a required secret but no longer referenced by any code (leftover from the removed one-off admin endpoint)
- The `installations.model` column default was still `deepseek-v4-pro` at the schema level; the earlier fix only backfilled existing rows. Since `upsertInstallation` (fired on every new App install) doesn't specify `model` in its INSERT, every new installation was silently defaulting to the slow reasoning model. The table was recreated with the correct default.

### Changed

- Tooling migrated from ESLint + Prettier to Biome

> ⚠️ **Upgrade note:** this version requires the **Organization members (Read)** user permission on the GitHub App. Existing installations must approve the new permission (GitHub sends installers a "review requested changes" prompt), and users must re-authorize at `/setup` — existing OAuth tokens do not retroactively gain new permissions. Until then, organization installations will be filtered out of the setup page with a `403` logged.

[v1.4.0]: <https://github.com/Ekojoecovenant/alphapr/releases/tag/v1.4.0>

## [v1.3.0] — 2026-08-01

### Added

- AlphaPR now considers the repo's own failing CI checks (from the same commit) as corroborating context during review — synthesizing its own LLM analysis with deterministic signal from other tools (linters, typecheckers, etc.) already running in the repo's pipeline
- Centralized shared types (`ReviewJob`, `CheckConclusion`, `ReviewCommentInput`, `OtherCheckRun`) into `src/types.ts`

### Fixed

- `getFailedCheckRuns` (previously misnamed `getOtherCheckRuns`) now paginates through GitHub's check-runs API instead of only reading the default first page — repos with more than 30 check runs on a single commit would have silently missed failures beyond that limit

### Notes

- This feature only adds value when the repo's own CI completes before AlphaPR's review does — if AlphaPR reviews first, there's nothing yet to fetch
- Deliberately scoped to context only, not structured findings: CI failures inform the LLM's reasoning but are not promoted into anchored `Finding`s in this version

[v1.3.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v1.3.0

## [v1.2.0] — 2026-07-31

### Added

- Multi-provider architecture: Anthropic and OpenAI adapters alongside OpenRouter, behind a single shared `ProviderAdapter` interface
- Provider selection is stored per-installation (`installations.provider`, migration 0005) and fully wired through the read and write paths
- Centralized `Provider` type in `provider-types.ts` — a compiler-enforced, exhaustiveness-checked single source of truth for adding future providers

### Changed

- `generateSummary` now routes through the same provider adapter as the main review, instead of being hardcoded to OpenRouter regardless of the installation's configured provider
- Error diagnostics collapse whitespace before truncating, across all three adapters, so reasoning-heavy failure responses show real signal instead of blank lines

### Fixed

- A config-only edit (no new API key) was silently resetting `provider` back to `openrouter` on every save, because the fallback-to-current-value logic hadn't been carried over when the write path was extended — caught by AlphaPR's own review of its own PR
- `hmacSign` was not exported, breaking `test/setup.spec.ts`'s existing HMAC tests

### Known limitations

- The Anthropic and OpenAI adapters are implemented per each provider's documented API shape but have **not been verified against a live API key** — OpenRouter remains the only provider confirmed working end-to-end in production
- Provider selection is not yet exposed on the `/setup` page; it can currently only be set by direct database access, deliberately, until live verification is complete
- OpenAI's o-series reasoning models (o1/o3) are not supported — only standard chat models

[v1.2.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v1.2.0

## [v1.1.0] — 2026-07-31

### Added

- Multi-line suggestion ranges: findings that need more than a one-line fix can now specify a line span (`line` through `endLine`), posted via GitHub's ranged-comment API so the Apply-suggestion button replaces the whole span cleanly instead of leaving orphaned code
- Queue consumer test coverage: ack/retry classification, `surfaceFailure` call correctness, and batch-independence, closing the last untested part of the pipeline

### Fixed

- `endLine` validation requires it to be strictly greater than `line`, matching the prompt's own single-line-vs-multi-line rule

[v1.1.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v1.1.0

## [v1.0.0] — 2026-07-30

The first stable release. Ten minor versions of iteration — core review pipeline, encrypted multi-tenant BYOK, self-serve OAuth setup, incremental memory with self-healing, Checks integration, per-install configuration, free-tier deployment, PR description summaries — plus a full test suite, linting, CI, and an internal restructure, all shipped and hardened through continuous review from AlphaPR itself and CodeRabbit.

No new features in this release. This version marks the API, setup process, and configuration surface as stable: self-hosters and integrators can build against it without expecting breaking changes outside of major version bumps.

[v1.0.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v1.0.0

## [v0.10.0] — 2026-07-29

### Added

- PR description summaries: AlphaPR generates a concise 2-5 bullet summary of the full PR and appends it to the description in a marker-delimited block (`<!-- alphapr-summary -->`), updated on both `opened` and `synchronize`
- Author-written description content is never overwritten — only the marked block is replaced on subsequent updates

### Changed

- Internal restructure: `handlePREvent` and `surfaceFailure` moved out of `index.ts` into a dedicated `review-handler.ts`; `index.ts` is now routing/dispatch only
- `src/` reorganized into `github/` (GitHub API client) and `review/` (diff parsing, LLM calls, rendering) modules

### Notes

- PR description summaries are **queue-mode only** — the extra LLM call and API round-trips don't fit free-tier's ~30-second budget
- The description update is best-effort and non-atomic: an author edit to the description made in the same narrow window as AlphaPR's update could be overwritten. This never affects the main review, which always completes first.

[v0.10.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v0.10.0

## [v0.9.0] — 2026-07-29

### Added

- Test suite (Vitest + `@cloudflare/vitest-pool-workers`) covering the diff parser, JSON extraction strategies, and HMAC signing/verification
- Regression tests for real production incidents: a model leaking its reasoning monologue before the JSON output, and unfenced JSON containing braces breaking naive brace-matching

### Fixed

- `parseDiff` no longer leaks `diff --git` and `index` header lines into the annotated output for ignored files
- `parseDiff` now tracks hunk-body state, so extended file-header metadata (rename/mode/binary markers) is handled correctly for ignored files, and hunk content beginning with `---` is never mistaken for a new file header
- Strategy 3's JSON extraction (`parseReviewJson`) is now genuinely string-aware when brace-matching — a previously agreed fix for this had not actually been applied until the test suite caught it

[v0.9.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v0.9.0

## [v0.8.0] — 2026-07-29

### Added

- Free-tier deployment mode (`QUEUE_MODE=false`): runs without Cloudflare Queues via `ctx.waitUntil`, for self-hosters on Cloudflare's free Workers plan
- Shared `surfaceFailure` helper for consistent status-comment and check-run failure reporting across both queue and free-tier dispatch paths

### Changed

- Free-tier mode has no automatic retries — failures are reported once, immediately, since there is no queue to retry from

[v0.8.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v0.8.0

## [v0.7.0] — 2026-07-28

### Added

- Per-installation configuration, editable on the setup page: model, severity threshold (all / minor+ / major-only), review tone (thorough / concise), and ignore-path globs
- Ignored paths are filtered at the diff stage, so ignored files never reach the model — saving tokens and reducing noise
- Severity threshold filters findings before anything counts them, so the check-run conclusion reflects the team's chosen threshold (a below-threshold finding leaves the check green)
- Config can be edited without re-entering the API key — leave the key field blank to keep the existing one

### Security

- User-derived values (account login) are HTML-escaped before rendering into the setup form

[v0.7.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v0.7.0

## [v0.6.0] — 2026-07-27

### Added

- GitHub Checks integration: an "AlphaPR Review" check run appears in-progress the moment a PR event arrives, then concludes with the review outcome — success (clean), action_required (has a major finding), or neutral (minor/nit only)
- Failed reviews conclude the check run as failure (permanent) or neutral (retrying) instead of leaving it hanging

### Fixed

- Best-effort status updates in the failure path are isolated, so a failed comment edit can no longer leave the check run stuck in-progress

> ⚠️ **Upgrade note:** this version adds the **Checks: Read & Write** permission. Existing installations must accept the new permission (GitHub sends installers a prompt) before check runs will appear.

[v0.6.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v0.6.0

## [v0.5.0] — 2026-07-27

### Added

- Line-anchored review comments: findings are posted inline on the exact changed lines via the Reviews API, with working Apply-suggestion buttons and resolvable threads
- Structured JSON review contract: the model returns typed findings (path, line, severity, title, body, optional suggestion) instead of free-form Markdown
- AlphaPR's own diff parser annotates every line with its true line number before prompting, and validates the model's line references before posting — hallucinated locations demote to the summary instead of failing
- Multi-strategy JSON extraction: reviews are recovered from fenced, prose-buried, or reasoning-prefixed model output, with a raw-text fallback as the floor

### Changed

- The status comment now shows the verdict, a count of inline comments, and any findings that couldn't be anchored
- Default fallback model switched to a fast non-reasoning model — reasoning-model latency and thinking-token budgets exceeded the review pipeline's limits
- Reasoning-capable models are capped via OpenRouter's reasoning token controls so output budget is preserved

### Fixed

- Queue error logs now include the full error message and stack, not just a trace
- Diff metadata lines ("\ No newline at end of file") and split artifacts are no longer numbered or anchorable
- A failed summary edit after successful inline posting no longer retries the whole review
- Inline reviews are pinned to the exact reviewed commit (`commit_id`), so comments can't anchor to code pushed mid-review
- JSON extraction brace-matching is string-literal aware, so findings containing braces in code suggestions no longer truncate the parse
- OpenRouter auth failures (401/403) are classified permanent — a revoked key is reported once instead of burning retries

[v0.5.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v0.5.0

## [v0.4.0] — 2026-07-27

### Added

- Self-serve BYOK setup: visit `/setup` after installing to configure your OpenRouter key and model — GitHub OAuth verifies you have access to the installation before accepting a key
- OAuth CSRF protection: browser-bound nonce cookie tied to the signed state parameter
- Setup form tokens are HMAC-signed and expire after 10 minutes

### Changed

- Installation rows created via setup now store the real account login

[v0.4.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v0.4.0

## [v0.3.0] — 2026-07-27

### Added

- Live review status: a "🔍 Reviewing…" comment is posted the moment a PR event arrives, then edited in place into the verdict when the review completes
- Failure visibility: if a review fails, the status comment is updated with a retry or permanent-failure notice instead of failing silently
- Setup guidance for unconfigured installations now reuses the status comment instead of posting new ones

### Fixed

- A state-save failure after a successful review no longer overwrites the posted verdict or re-runs the LLM call
- Deleted/inaccessible comments (404) are treated as permanent failures instead of burning queue retries

## [v0.2.0] — 2026-07-26

### Added

- Multi-tenant BYOK: per-installation OpenRouter API keys, stored AES-GCM encrypted in D1
- Installation lifecycle handling — rows created on install, keys deleted on uninstall
- Setup guidance comment for installed-but-unconfigured repositories
- Permanent-vs-transient failure classification in the queue consumer (permanent failures ack instead of burning retries)

### Changed

- Fallback owner is now configured via `FALLBACK_OWNER` env var instead of a hardcoded username
- Master key input is validated (must be 64 hex chars) instead of silently coerced

[v0.2.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v0.2.0

## [v0.1.0] — 2026-07-14

First public release. 🎉

### Added

- GitHub App integration — install once, reviews every PR (`opened` and `synchronize`)
- BYOK via OpenRouter: your API key, any model, swappable in one line
- Structured review format: verdict line, severity tiers (🔴/🟡/🟢), collapsible explanations, suggestion fences
- Incremental reviews: D1 stores the last-reviewed commit SHA and previous review body per PR — updates get only the new diff, and the bot doesn't repeat points it already made
- Force-push recovery: a rewritten branch invalidates the stored SHA; AlphaPR detects the 404, falls back to a full review, and self-heals its state on the next push
- Queue-based architecture: webhook handler enqueues in milliseconds; a Cloudflare Queue consumer handles the slow LLM work with retries and a dead-letter queue
- Webhook HMAC-SHA256 signature verification (constant-time)
- Empty-review and empty-suggestion-fence sanitization

### Notes

- Requires Cloudflare Workers Paid plan (Queues). Free-tier mode is on the roadmap.

[v0.1.0]: https://github.com/Ekojoecovenant/alphapr/releases/tag/v0.1.0

