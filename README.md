# AlphaPR

**AlphaPR is a BYOK AI PR reviewer that comments on the exact lines it's talking about — and remembers what it already said.**

Bring your own OpenRouter key, pick any model, install the GitHub App on your repos. Findings land as inline comments on the changed lines, with one-click Apply-suggestion fixes. First push gets a full review; every push after that gets an incremental one, scoped to only what changed, with the bot's previous review as context so it never repeats itself.

> **Status:** Working v1. AlphaPR reviews its own PRs — dogfooding since day one. APIs and setup may still change.

## Features

- **Line-anchored findings** — comments sit on the exact diff lines in the Files Changed tab, as resolvable threads with working *Apply suggestion* buttons
- **Incremental memory** — stores what it reviewed and what it said, so updates get reviewed against only the new changes, without repeats
- **BYOK, encrypted** — every installation brings its own OpenRouter key, AES-GCM encrypted at rest, configured through an OAuth-verified setup page
- **Live status** — a "🔍 Reviewing…" comment appears instantly and morphs into the verdict (or a failure notice — no silent deaths)
- **Self-healing** — force-pushes that erase the remembered commit are detected and recovered automatically
- **Checks integration** — a review check run in the PR's checks list, in-progress → concluded, so AlphaPR shows up like any CI step (and can gate merges if you make it required)
- **Configurable per install** — pick the model, filter by severity, choose thorough or concise reviews, and ignore paths (like `dist/` or `*.lock`), all from the setup page

## How it works

### Step 1 — Cloudflare Worker (fast path, milliseconds)

1. GitHub sends a `pull_request` webhook (`opened` / `synchronize`)
2. Worker verifies the HMAC-SHA256 signature
3. Worker posts a "🔍 Reviewing…" status comment on the PR
4. Worker enqueues a small, typed review job
5. Worker responds `200` to GitHub immediately

### Step 2 — Cloudflare Queue consumer (slow path, up to 15 minutes)

1. Consume the job (with automatic retries and a dead-letter queue for jobs that fail repeatedly)
2. Authenticate as the GitHub App (short-lived JWT → installation access token)
3. Resolve the installation's own OpenRouter key (stored encrypted) and model
4. Check D1 state — first review of a PR gets the **full diff**; updates get **only the changes since the last reviewed commit**, plus the bot's previous review as context
5. Parse and annotate the diff — every line is prefixed with its true line number before the model sees it
6. The model returns structured JSON findings; line references are validated against the real diff before anything is posted
7. Valid findings are posted as **inline review comments** on the exact lines; anything unanchorable goes into the summary instead of failing
8. The status comment morphs into the verdict and inline-comment count
9. Save the reviewed SHA and review body to D1

If a force-push wipes out the last reviewed commit, AlphaPR detects the 404 and falls back to a full review — then self-heals its state on the next push.

## Why this architecture

**A GitHub App, not a GitHub Action.** Actions live inside each repo's workflow files — fine for personal use, clunky for a product. An installable App needs its own backend to receive webhooks, and a Cloudflare Worker is that backend: edge latency, zero servers to manage.

**A queue, because the first version broke.** The initial build did everything inside the webhook handler with `waitUntil()`. Then real LLM calls started blowing past the 30-second background limit — the logs literally showed reviews dying mid-generation. The fix was the architecture the project should have had anyway: the Worker verifies and enqueues in milliseconds, then hands the task over to the queue, and the queue consumer handles the slow work gracefully — a 15-minute budget, automatic retries, and a dead-letter queue for anything that still fails.

**D1, because she remembers.** A single table stores the last reviewed commit SHA and the previous review body per PR. That's what makes incremental reviews possible — and what stops the bot from re-litigating the whole PR on every push.

**Our own diff parser, because models can't count.** LLMs are unreliable at deriving line numbers from hunk offsets. So AlphaPR computes the numbers itself, hands them to the model inside the annotated diff, and verifies every returned line reference against the parsed diff before posting. Hallucinated locations demote gracefully to the summary instead of producing broken comments.

**Encrypted BYOK, because it's multi-tenant.** Each installation stores its own OpenRouter key, AES-GCM encrypted before it touches the database. Keys are configured through an OAuth-verified setup page and deleted when the App is uninstalled.

## Self-hosting

> Requires a Cloudflare account on the **Workers Paid** plan (~$5/mo) for Queues. A free-tier mode is on the roadmap.

### 1. Register a GitHub App

At **github.com/settings/apps → New GitHub App**:

- **Permissions:** Pull requests (Read & Write), Contents (Read-only), Metadata (Read-only)
- **Subscribe to events:** Pull request
- **Webhook secret:** generate one and save it:

```bash
openssl rand -hex 32
```

- **Callback URL:** `https://<your-worker>.workers.dev/setup/callback` (needed for the self-serve setup page)
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
  "GITHUB_CLIENT_ID": "your-app-client-id"
}
```

Delete `pk8.pem` from disk afterwards. Secrets live in Cloudflare's secret store, never in the repo.

### 5. Create the queues and database

```bash
pnpm wrangler queues create pr-review-jobs
pnpm wrangler queues create pr-review-dlq
pnpm wrangler d1 create pr-agent-db
```

Update `wrangler.jsonc` with the D1 `database_id` from the output, then apply the migrations:

```bash
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0001_init.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0002_add_review_body.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0003_add_installations.sql
```

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

GitHub OAuth verifies they have access to the installation, then their OpenRouter key is encrypted and stored for that installation only. Open or update a PR after configuring — AlphaPR takes it from there.

### Choosing a model

The model is set per installation on the setup page (any model available on OpenRouter works). **Fast, non-reasoning models are recommended** — reasoning models produce deeper analysis but can take minutes per review and require large token budgets; fast models return in seconds and the structured review contract carries the quality.

### Configuration

After installing, visit `/setup` to configure per installation:

- **Model** — any OpenRouter model
- **Severity threshold** — surface all findings, minor-and-above, or major-only
- **Review tone** — thorough (fuller explanations) or concise (terser, fewer findings)
- **Ignore paths** — comma-separated globs (`dist/`, `*.lock`) to skip generated files

Editing settings later doesn't require re-entering your key — leave the key field blank to keep it.

## Roadmap

- **Free-tier mode** — a no-queue path (fast models only) so self-hosters can run on Cloudflare's free plan
- **Agentic analysis toolbox** — repo-aware review: AST queries, cross-file tracing, and doc lookups instead of diff-only analysis
- **Test coverage** — unit tests for the diff parser, OAuth setup flow, and queue consumer
- **Managed tier** — eventually: use AlphaPR's own hosted models, no key required

---

Built in public by [AlphaCode](https://github.com/Ekojoecovenant). PRs welcome — they'll be reviewed by the bot, obviously. Inline.
