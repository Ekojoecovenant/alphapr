# Changelog

All notable changes to AlphaPR are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

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
