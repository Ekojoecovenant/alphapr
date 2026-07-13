# AlphaPR

**AlphaPR is a BYOK AI PR reviewer that reviews your pull requests — and remembers what it already said.**

Bring your own OpenRouter key, pick any model, install the GitHub App on your repos. First push gets a full review; every push after that gets an incremental one, scoped to only what changed, with the bot's previous review as context so it never repeats itself.

> **Status:** Working v1. AlphaPR reviews its own PRs — dogfooding since day one. APIs and setup may still change.

## How it works

### Step 1: Cloudflare Worker (fast path, milliseconds)

1. GitHub sends a `pull_request` webhook (`opened` / `synchronize`)
2. Worker verifies the HMAC-SHA256 signature
3. Worker enqueues a small, typed review job
4. Worker responds `200` to GitHub immediately

### Step 2: Cloudflare Queue consumer (slow path, up to 15 minutes)

1. Consume the job (with automatic retries and a dead-letter queue for jobs that fail repeatedly)
2. Authenticate as the GitHub App (short-lived JWT → installation access token)
3. Check D1 state — first review of a PR gets the **full diff**; updates get **only the changes since the last reviewed commit**, plus the bot's previous review as context
4. Send the diff to the LLM via OpenRouter — bring your own key, any model
5. Post the review as a PR comment
6. Save the reviewed SHA and review body to D1

If a force-push wipes out the last reviewed commit, AlphaPR detects the 404 and falls back to a full review — then self-heals its state on the next push.

## Why this architecture

**A GitHub App, not a GitHub Action.** Actions live inside each repo's workflow files — fine for personal use, clunky for a product. An installable App needs its own backend to receive webhooks, and a Cloudflare Worker is that backend: edge latency, zero servers to manage.

**A queue, because the first version broke.** The initial build did everything inside the webhook handler with `waitUntil()`. Then real LLM calls started blowing past the 30-second background limit — the logs literally showed reviews dying mid-generation (`TimeoutError`, cancelled at ~25s). The fix was the architecture the project should have had anyway: the Worker verifies and enqueues in milliseconds, then hands the task over to the queue, and the queue consumer handles the slow work gracefully — a 15-minute budget, automatic retries, and a dead-letter queue for anything that still fails.

**D1, because she remembers.** A single table stores the last reviewed commit SHA and the previous review body per PR. That's what makes incremental reviews possible — and what stops the bot from re-litigating the whole PR on every push.

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

- Webhook URL can be a placeholder for now — you'll update it after deploying.

After creating the App, note the **App ID** and generate a **private key** (`.pem` download).

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

### 4. Set secrets

```bash
pnpm wrangler secret put GITHUB_WEBHOOK_SECRET   # from step 1
pnpm wrangler secret put GITHUB_APP_ID           # from step 1
pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY  # full contents of pk8.pem
pnpm wrangler secret put OPENROUTER_API_KEY      # your key — any model
```

Delete `pk8.pem` from disk afterwards. Secrets live in Cloudflare's secret store, never in the repo.

### 5. Create the queues and database

```bash
pnpm wrangler queues create pr-review-jobs
pnpm wrangler queues create pr-review-dlq
pnpm wrangler d1 create pr-agent-db
```

Update `wrangler.jsonc` with the D1 `database_id` from the output, then apply the schema:

```bash
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0001_init.sql
pnpm wrangler d1 execute pr-agent-db --remote --file=db/migrations/0002_add_review_body.sql
```

### 6. Deploy and connect

```bash
pnpm wrangler deploy
```

Copy the deployed Worker URL into your GitHub App's **Webhook URL**, then **Install App** on the repos you want reviewed. Open a PR — AlphaPR takes it from there.

### Choosing a model

The model is set in the review call (any model available on OpenRouter works). Slower, stronger models produce deeper reviews; faster models keep costs down. Swap freely — it's one line.

## Roadmap

- **Line-anchored review comments** — findings attached to the exact diff lines, with working *Apply suggestion* buttons and resolvable threads
- **Per-repo configuration** — model, severity thresholds, and review style per installation
- **Free-tier mode** — a no-queue path (fast models only) so self-hosters can run on Cloudflare's free plan
- **Agentic analysis toolbox** — repo-aware review: AST queries, cross-file tracing, and doc lookups instead of diff-only analysis
- **Managed tier** — eventually: use AlphaPR's own hosted models, no key required

---

Built in public by [AlphaCode](https://github.com/Ekojoecovenant). PRs welcome — they'll be reviewed by the bot, obviously.
