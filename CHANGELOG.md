# Changelog

All notable changes to AlphaPR are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

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
