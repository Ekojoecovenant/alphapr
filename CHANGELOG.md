# Changelog

All notable changes to AlphaPR are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

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
