# AlphaPR

[![CI](https://github.com/Ekojoecovenant/alphapr/actions/workflows/ci.yml/badge.svg)](https://github.com/Ekojoecovenant/alphapr/actions/workflows/ci.yml)

**AlphaPR is a BYOK AI PR reviewer that comments on the exact lines it's talking about — and remembers what it already said.**

Bring your own API key — OpenRouter, Anthropic, or OpenAI — pick any model, install the GitHub App on your repos. Findings land as inline comments on the changed lines, with one-click Apply-suggestion fixes. First push gets a full review; every push after that gets an incremental one, scoped to only what changed, with the bot's previous review as context so it never repeats itself.

> **Status:** v1.6.0. Stable — the review pipeline, BYOK setup, and configuration surface are settled. New features ship as minor versions; breaking changes will be called out explicitly in the changelog.

## Features

- **Line-anchored findings** — comments sit on the exact diff lines in the Files Changed tab, as resolvable threads with working *Apply suggestion* buttons
- **Incremental memory** — stores what it reviewed and what it said, so updates get reviewed against only the new changes, without repeats
- **BYOK, encrypted** — every installation brings its own Provider key, AES-GCM encrypted at rest, configured through an OAuth-verified setup page
- **Live status** — a "🔍 Reviewing…" comment appears instantly and morphs into the verdict (or a failure notice — no silent deaths)
- **Self-healing** — force-pushes that erase the remembered commit are detected and recovered automatically
- **Checks integration** — a review check run in the PR's checks list, in-progress → concluded, so AlphaPR shows up like any CI step (and can gate merges if you make it required)
- **Configurable per install** — pick the model, filter by severity, choose thorough or concise reviews, and ignore paths (like `dist/` or `*.lock`), all from the setup page
- **Free-tier friendly** — runs with Cloudflare Queues for production use, or in a queueless mode on Cloudflare's free plan
- **PR description summaries** — a concise, auto-generated overview appended to the PR description, kept current across pushes without touching what you wrote
- **Tested** — the diff parser, JSON extraction, and OAuth signing logic have automated test coverage, including regression tests against real production incidents, enforced by CI on every PR
- **Multi-line Apply-suggestions** — fixes that need more than one line (a guard clause, a try/finally wrap) anchor and apply correctly across the whole span
- **Fixture-tested adapters** — each provider adapter has contract tests pinning the exact request it sends and response shape it accepts, so a wire-format break fails in CI rather than in production
- **Costs nothing when it should not run** — draft PRs, `[skip alphapr]` titles, and a re-delivered webhook for an already-reviewed commit are all refused before the first GitHub API call
- **Token accounting** — each review records what it cost, reported in the check run and stored per PR, so a BYOK tenant can see their spend without leaving GitHub
- **Multi-provider** — OpenRouter, Anthropic, and OpenAI adapters behind one interface and selectable per installation on the setup page (OpenRouter verified in production; the other two are implemented and contract-tested, but not yet verified against live keys — see Roadmap)
- **CI-aware reviews** — when the repo's own CI has already failed on the same commit, AlphaPR factors that in as corroborating signal rather than reviewing in isolation
- **Owner-only configuration** — only account owners and organization admins can change an installation's key or settings; repository collaborators cannot
- **Skip on demand** — add `[skip alphapr]` anywhere in a PR title to bypass review entirely, at zero cost

## How it works

### Step 1 — Cloudflare Worker (fast path, milliseconds)

1. GitHub sends a `pull_request` webhook (`opened` / `synchronize`)
2. Worker verifies the HMAC-SHA256 signature
3. Worker posts a "🔍 Reviewing…" status comment and creates an in-progress check run
4. Worker dispatches the review job — to a **Cloudflare Queue** (default) or inline via `waitUntil` (free-tier mode)
5. Worker responds `200` to GitHub immediately

### Step 2 — Review execution (queue consumer, or inline in free-tier mode)

1. Authenticate as the GitHub App (short-lived JWT → installation access token)
2. Resolve the installation's own provider API key (stored encrypted), model, provider, and config (severity threshold, tone, ignore paths)
3. Check D1 state — first review of a PR gets the **full diff**; updates get **only the changes since the last reviewed commit**, plus the bot's previous review as context
4. Parse and annotate the diff — every line is prefixed with its true line number, and ignored paths (files and their headers) are dropped before the model ever sees them
5. Fetch any of the repo's own failing CI checks on the same commit, and fold them in as corroborating context for the model's reasoning
6. The model returns structured JSON findings; line references are validated against the real diff before anything is posted
7. Findings are filtered by severity threshold for display (the full set is preserved separately for memory)
8. Valid findings are posted as **inline review comments** on the exact lines, pinned to the reviewed commit; anything unanchorable goes into the summary instead of failing
9. The status comment morphs into the verdict, and the check run concludes (success / neutral / action required)
10. Save the reviewed SHA and the **full, unfiltered** review to D1
11. *(Queue mode only)* Generate a short summary of the full PR and append it to the PR description in a marker-delimited block, replacing only that block on future updates

If a force-push wipes out the last reviewed commit, AlphaPR detects the 404 and falls back to a full review — then self-heals its state on the next push.

**Queue mode** (default, requires Workers Paid): retries automatically on transient failures, up to 15 minutes per job, with a dead-letter queue for jobs that fail repeatedly.
**Free-tier mode** (`QUEUE_MODE` unset or not `"true"`, no queue): runs inline within Cloudflare's ~30-second background execution limit. A transient failure gets exactly one retry, and only if the first attempt failed fast enough to leave time; permanent failures (bad key, 4xx) are reported immediately. PR description summaries are skipped in this mode.

## Why this architecture

**A GitHub App, not a GitHub Action.** Actions live inside each repo's workflow files — fine for personal use, clunky for a product. An installable App needs its own backend to receive webhooks, and a Cloudflare Worker is that backend: edge latency, zero servers to manage.

**A queue, because the first version broke.** The initial build did everything inside the webhook handler with `waitUntil()`. Then real LLM calls started blowing past the 30-second background limit — the logs literally showed reviews dying mid-generation. The fix was the architecture the project should have had anyway: the Worker verifies and dispatches in milliseconds, then hands the task to the queue, and the queue consumer handles the slow work gracefully — a 15-minute budget, automatic retries, and a dead-letter queue for anything that still fails. Free-tier mode later resurrected the original `waitUntil` path as an opt-in for self-hosters without a paid plan.

**D1, because she remembers.** A single table stores the last reviewed commit SHA and the previous review body per PR. That's what makes incremental reviews possible — and what stops the bot from re-litigating the whole PR on every push. Severity-threshold filtering is applied only for display; the full review is always what's remembered, so a below-threshold finding isn't silently forgotten.

**Our own diff parser, because models can't count.** LLMs are unreliable at deriving line numbers from hunk offsets. So AlphaPR computes the numbers itself, hands them to the model inside the annotated diff, and verifies every returned line reference against the parsed diff before posting. The parser tracks hunk-body state explicitly, so extended file-header metadata is handled correctly and hunk content is never mistaken for a header. Hallucinated locations demote gracefully to the summary instead of producing broken comments.

**Encrypted BYOK, because it's multi-tenant.** Each installation stores its own provider API key, AES-GCM encrypted before it touches the database. Keys are configured through an OAuth-verified setup page and deleted when the App is uninstalled.

**A provider adapter interface, because "BYOK" shouldn't mean "OpenRouter or nothing."** `ProviderAdapter` normalizes request/response shapes across OpenRouter, Anthropic, and OpenAI behind one interface, with the `Provider` union type centralized in a single file — adding a new provider is a type-checked, exhaustiveness-enforced change, not a search-and-replace across the codebase.

**Tests, because "fixed" and "shipped" aren't the same thing.** More than one fix in this project was agreed on, discussed, and then never actually landed in the code — caught only once a real test existed to prove it. The test suite covers the trickiest logic: diff parsing edge cases, JSON extraction from messy model output (including a real leaked-reasoning incident), and the HMAC signing behind the setup flow. CI runs both `tsc --noEmit` and the test suite on every PR, so a regression can't merge quietly.

## Self-hosting

> Production use (Cloudflare Queues) requires the **Workers Paid** plan (~$5/mo). A free, queueless mode is also available — see [Free-tier deployment](#free-tier-deployment) below.

### 1. Register a GitHub App

At **github.com/settings/apps → New GitHub App**:

- **Permissions:** Pull requests (Read & Write), Contents (Read-only), Metadata (Read-only), Checks (Read & Write), Organization members (Read-only)
- **Subscribe to events:** Pull request
- **Webhook secret:** generate one and save it:

```bash
openssl rand -hex 32
```

- **Callback URLs:** two of them —
  - `https://<your-worker>.workers.dev/setup/callback` (the self-serve setup page)
  - `https://<your-worker>.workers.dev/auth/callback` (dashboard sign-in)

  GitHub App settings accept multiple callback URLs; both point at the same Worker.
- Webhook URL can be a placeholder for now — you'll update it after deploying.

After creating the App, note the **App ID** and **Client ID**, generate a **client secret**, and generate a **private key** (`.pem` download).

### 2. Convert the private key

Workers' `crypto.subtle` needs PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in your-app.private-key.pem -out pk8.pem
```

### 3. Clone and install

```bash
git clone https://github.com/Ekojoecovenant/alphapr.git
cd alphapr
pnpm install
```

### 4. Set secrets and vars

```bash
pnpm wrangler secret put GITHUB_WEBHOOK_SECRET    # from step 1
pnpm wrangler secret put GITHUB_APP_ID            # from step 1
pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY   # full contents of pk8.pem
pnpm wrangler secret put GITHUB_CLIENT_SECRET     # from step 1
pnpm wrangler secret put OPENROUTER_API_KEY       # fallback key for the FALLBACK_OWNER's own repos
pnpm wrangler secret put KEY_ENCRYPTION_SECRET    # openssl rand -hex 32 — encrypts stored tenant keys
pnpm wrangler secret put SETUP_SIGNING_SECRET     # openssl rand -hex 32 — signs OAuth state and setup form tokens
```

> ⚠️ `KEY_ENCRYPTION_SECRET` encrypts stored tenant API keys and must never be rotated without re-encrypting existing keys. Back it up in a password manager.

In `wrangler.jsonc`, set your values in `vars`:

```jsonc
"vars": {
  "FALLBACK_OWNER": "your-github-username",   // PRs on this account's repos fall back to OPENROUTER_API_KEY
  "GITHUB_CLIENT_ID": "your-app-client-id",
  "QUEUE_MODE": "true"                         // set to anything other than "true" for free-tier deployment
}
```

Delete `pk8.pem` from disk afterwards. Secrets live in Cloudflare's secret store, never in the repo.

### 5. Create the queues and database

```bash
pnpm wrangler queues create pr-review-jobs
pnpm wrangler queues create pr-review-dlq
pnpm wrangler d1 create pr-agent-db
```

(Skip creating the queues if deploying in free-tier mode — see below.)

Update `wrangler.jsonc` with the D1 `database_id` from the output, then apply the migrations, in order:

```bash
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0001_init.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0002_add_review_body.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0003_add_installations.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0004_add_config.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0005_add_provider.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0006_fix_default_model.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0007_recreate_installations_default_model.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0008_add_review_usage.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0009_users_sessions.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0010_repos.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0012_install_health.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0013_installation_key_hint.sql
```

(There is no `0011` yet — it belongs to the review-history phase of [ADR 0002](docs/adr/0002-self-serve-dashboard.md), not to a skipped file.)

### 6. Deploy and connect

```bash
pnpm wrangler deploy
```

Copy the deployed Worker URL into your GitHub App's **Webhook URL**, then **Install App** on the repos you want reviewed.

### 7. Configure installations

Anyone who installs your App configures their own key at:

```plain
https://<your-worker>.workers.dev/setup
```

GitHub OAuth verifies they have access to the installation, then their API key is encrypted and stored for that installation only. They also choose the provider (OpenRouter, Anthropic, or OpenAI) and model there. Open or update a PR after configuring — AlphaPR takes it from there.

### Free-tier deployment

AlphaPR can run without Cloudflare Queues, entirely within the free Workers plan. Trade-off: reviews must complete within Cloudflare's ~30-second background execution limit, so **fast, non-reasoning models are required**, retries are limited (one retry, and only if the first attempt failed quickly), and **PR description summaries are skipped**.

To deploy in free-tier mode:

1. Remove the `queues` block from `wrangler.jsonc` entirely
2. Set `"QUEUE_MODE"` to anything other than `"true"` in `vars`
3. Skip creating `pr-review-jobs` and `pr-review-dlq` in step 5
4. When configuring an installation at `/setup`, choose a fast model (e.g. `deepseek/deepseek-v4-flash`)

If a review fails in free-tier mode, AlphaPR retries once after a short backoff — but only when the first attempt failed fast enough to leave room within the execution limit. If the retry also fails, or the failure was slow or permanent (e.g. an invalid API key), the reason is reported on the PR and you can re-push or re-open to try again.

### Choosing a model

The model is set per installation on the setup page (any model the chosen provider offers works). **Fast, non-reasoning models are recommended** — reasoning models produce deeper analysis but can take minutes per review and require large token budgets; fast models return in seconds and the structured review contract carries the quality. In free-tier mode, fast models are effectively required.

The provider is chosen on the same page: **OpenRouter** (verified in production), **Anthropic**, or **OpenAI**. The Anthropic and OpenAI adapters are implemented and contract-tested against their wire formats, but have not been verified against live API keys — if you use one and hit a problem, please [open an issue](https://github.com/Ekojoecovenant/alphapr/issues).

### Configuration

After installing, visit `/setup` to configure per installation:

- **Provider** — OpenRouter, Anthropic, or OpenAI
- **Model** — any model the chosen provider offers
- **Severity threshold** — surface all findings, minor-and-above, or major-only
- **Review tone** — thorough (fuller explanations) or concise (terser, fewer findings)
- **Ignore paths** — comma-separated globs (`dist/`, `*.lock`) to skip generated files

Editing settings later doesn't require re-entering your key — leave the key field blank to keep it.

The configuration form is valid for ten minutes **and only in the browser that started the flow**: the hidden form token is signed together with a nonce cookie set when GitHub redirects back, so a token copied out of the page — from a log, a screenshot, a shared machine — cannot be replayed anywhere else.

### Dashboard

Sign in at `/dashboard` with GitHub (`read:user` only — the token is used once to read your profile and installation list, then discarded). You get a read-only view of every installation you administer: which account it belongs to, your role on it (`admin` or `member · read-only`), the provider and model in force, whether a key is stored, the repository list with each repo's on/off state, the last review time, and any provider failure as a banner that quotes the error (for example `Key limit exceeded (total limit)`).

Sessions are server-side rows in D1 with an opaque `HttpOnly` cookie, 30-day idle expiry and a hard seven-day cap, and CSRF tokens on every POST. A write from a session older than a day is sent back through GitHub first, so a role removed since you signed in is picked up before anything is changed. Administrators can open a repository and switch it off, or override its provider, model, severity threshold, tone and ignored paths; members see the same page read-only. An installation card also carries the provider key: a password field replaces it (the key is encrypted before it is stored, and only the last four characters are ever rendered as a hint) and a **Test provider** button makes one 16-token call so you find out your key is dead here rather than in a pull request. A switched-off repo is skipped silently — no comment, no check run. Review history is the next phase in [ADR 0002](docs/adr/0002-self-serve-dashboard.md).

### Running tests

```bash
pnpm test
pnpm lint
pnpm typecheck
```

All three run automatically via GitHub Actions on every pull request.

## Project structure

```plain
src/
  index.ts                # webhook routing and dispatch only
  review-handler.ts       # the full review pipeline (handlePREvent)
  types.ts                # shared types: ReviewJob, CheckConclusion, ReviewCommentInput, OtherCheckRun
  github/
    auth.ts                # GitHub App JWT + installation token exchange
    api.ts                 # GitHub REST API client (comments, reviews, checks, PR body, failed check runs)
  review/
    diff.ts                # diff parsing, line-number annotation, ignore-path filtering
    llm.ts                 # provider-agnostic review + summary generation, JSON extraction
    providers.ts           # ProviderAdapter implementations (OpenRouter, Anthropic, OpenAI)
    provider-types.ts      # single source of truth for the Provider union type
    render.ts              # findings/summary → Markdown, PR description merge
  setup.ts                 # OAuth-based self-serve configuration page
  setup-pages.ts           # landing page, setup form, success/error pages
  setup-styles.ts          # design tokens, page CSS, theme + scene scripts
  auth.ts                  # dashboard sign-in: OAuth state, sessions, CSRF
  dashboard.ts             # /dashboard — installations, repo settings, key and provider test
  dashboard-pages.ts       # dashboard markup
  db.ts                    # D1 queries
  crypto.ts                # AES-GCM key encryption
  errors.ts                # PermanentError classification
  verify.ts                # webhook signature verification
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and PR expectations, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## Roadmap

- **Self-serve dashboard** — phase P0 (sign-in, sessions, read-only view of installations and repos) is in; per-repo toggles and overrides, key replacement, review history, usage, and team access follow. See [ADR 0002](docs/adr/0002-self-serve-dashboard.md).
- **Multi-provider live verification** — the Anthropic and OpenAI adapters are selectable in `/setup` but have not been tested against live API keys; verification (and removing the "unverified" labels) is pending
- **Self-hosted/open-weight direct adapters** — e.g. Ollama, Together AI, or other OpenAI-compatible endpoints for teams running their own open models, alongside OpenRouter/Anthropic/OpenAI
- **Structured findings from CI context** — currently, the repo's own failing CI checks are folded in as prose context for the model's reasoning; promoting them into first-class anchored `Finding`s (with their own source attribution) is a natural next step
- **Agentic analysis toolbox** — repo-aware review: AST queries, cross-file tracing, and doc lookups instead of diff-only analysis. See [ADR](docs/adr/0001-agentic-toolbox-deep-dive-server.md) for the full design.
- **Managed tier** — eventually: use AlphaPR's own hosted models, no key required
- **CD** — automatic deployment on merge to `main`, once the manual deploy process has proven stable

---

Built in public by [AlphaCode](https://github.com/Ekojoecovenant/alphapr). PRs welcome — they'll be reviewed by the bot, obviously. Inline.

