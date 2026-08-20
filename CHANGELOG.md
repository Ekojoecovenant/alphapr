# Changelog

All notable changes to AlphaPR are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

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
