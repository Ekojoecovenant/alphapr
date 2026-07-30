# ADR: Agentic Analysis Toolbox — Deep-Dive Verification Server

**Status:** Proposed, not started. Deep backlog item.
**Date:** 2026-07-30

## Context

AlphaPR's core review pipeline runs entirely on Cloudflare Workers, operating only on the diff — no full-repo context, no cross-file tracing, no ability to verify a finding against how a function is actually used elsewhere. This is a deliberate, correct tradeoff for the fast path: diffs are small, reviews need to be fast and cheap, and Workers' execution model (bounded requests, 30s free-tier / 15min queue-mode ceilings) is a good fit for that.

But it's a real limitation. Research into the OSS/commercial landscape (mid-2026) confirms deterministic scanners and cross-file-aware tools catch categories of issues diff-only LLM review structurally cannot — and that LLM-only review has a "recursive blind spot" where AI-reviewed code and AI-written code can share the same failure modes. CodeRabbit's own "Analysis chain" behavior (repo cloning, ast-grep, rg, occasional web lookups) demonstrated this gap directly against AlphaPR multiple times during this project's development — it caught real bugs (the `head_sha` typo, the `saveReviewState` retry-corruption bug) that pure diff-reading could not have found.

## Decision

Build a **separate, dedicated deep-dive verification service**, outside Cloudflare Workers, that AlphaPR's Worker calls out to selectively — not a replacement for the fast pipeline, an occasional escalation from it.

### Why not extend the Worker itself

An agentic loop (reason → tool call → observe → repeat, potentially with parallel subagents) is fundamentally iterative and open-ended in duration. Workers' model is built for bounded, mostly-linear work. We already fought this exact ceiling once, for a single LLM call (the reasoning-model timeout incident that forced the move to Cloudflare Queues). A genuine multi-step agent loop with subagents is that same problem, multiplied. Better to give this workload a home suited to it than to keep fighting the platform's shape.

### Trigger (Phase 1)

Manual only: a PR comment like `@alphapr deep-dive` triggers the escalation. No automatic triggering initially — keeps a human in the loop on *when* the expensive path runs, before ever automating that decision. Automatic escalation (e.g., on any 🔴 major finding) is a later, separate decision once output quality and cost are trusted.

### Handoff

Same producer/consumer shape as the existing Worker → Queue pattern, just with an external consumer:

```plain
Worker (fast path, unchanged)
  → POST agent-server/analyze
      { repoFullName, prNumber, headSha, finding, installationToken }
  → Worker's job ends here, does not block

Agent Server (slow path, own infrastructure)
  → shallow clone at headSha
  → runs orchestrator + subagent loop
  → POSTs result back to a Worker webhook endpoint
  → Worker edits the ORIGINAL anchored comment in place (existing
    editComment machinery — no new comment type, no new UI concept)
```

`installationToken` passed across is short-lived (~1hr GitHub App token, already how every other cross-service call in this project works) — no new long-lived credential ever leaves Cloudflare.

### Orchestrator + subagents

Modeled on Cline's subagent pattern (verified via their public docs): primary orchestrator receives the finding, spawns 1-3 parallel **read-only** subagents (trace call sites / check repo-wide pattern occurrence / check test coverage), each with its own context window and token budget, reporting back a short summary — not a full transcript — to keep the orchestrator's context lean. Orchestrator synthesizes one verdict.

**Hard constraint, non-negotiable at this phase:** nothing in this server writes to the repo, ever. Subagents: read-only tools only (grep/rg, file read, ast-grep, directory listing). No file writes, no external API calls beyond the LLM, no nested subagent spawning. Output is text only — a verdict + reasoning — never a commit, never an auto-applied fix.

```typescript
interface DeepDiveResult {
  findingId: string;
  verdict: "confirmed" | "downgraded" | "dismissed";
  reasoning: string;
  evidence: string[];
}
```

### Security

This is the first AlphaPR component that reads an entire private repo, not just a diff — a real escalation in blast radius if compromised.

- Shallow clone (`--depth 1`, specific SHA only), deleted immediately after analysis — never a persistent local copy of any repo on disk
- Token scoped to exactly what the GitHub App already has — no new permissions requested
- This server needs its own threat-model thinking before it ever touches a real repo, even in testing — "someone's whole source tree" is a materially bigger exposure than "one PR's diff"

### Deployment target

Undecided, deliberately deferred until Phase 1 actually starts:

- **Rust/Axum** — matches existing Rust investment and RustQueue's proven concurrency pattern (semaphore-capped workers), but means building agent-loop plumbing (tool-call parsing, conversation state) from scratch
- **TypeScript/Node** — shares types directly with the Worker (`Finding`, review contracts), more agent-loop tooling available off the shelf (Vercel AI SDK, LangGraph), less portfolio value toward Rust goals

Lean: Rust, if willing to trade shipping speed for the deliberate skill investment — needs a real decision at build time, not now.

Hosted VPS pattern matches existing infra experience (Dilamme Scheduler, OXFIRA — Hetzner). Not Cloudflare Workers for this component.

## Phased build order

1. Manual trigger, single orchestrator, **zero subagents** — prove a single LLM call with real repo context (not just diff) catches things the fast pipeline misses, before investing in concurrency
2. Add read-only subagents, once (1) demonstrates real value
3. Automate the trigger (e.g. major-finding escalation), only once (2)'s output quality and cost are trusted
4. Write capability + AgentRQ-style human-in-the-loop approval gate — the big one, far out, only if everything before it has proven the value case. This is the point where an autonomous-write capability requires a control-plane pattern (propose action → human approves → action executes) rather than direct autonomous commits. Not needed before this, because nothing before this writes anything.

## What this is NOT

- Not a replacement for the fast Worker-based review pipeline — that stays exactly as it is
- Not a general-purpose coding agent (no Cline/Kilo/Hermes dependency) — study their loop architecture as reference, build a narrow, PR-scoped, read-only-first tool purpose-built for this
- Not scoped for v1.x — this is a multi-week build on its own, sequenced deep in the post-1.0 backlog, after: queue-consumer tests, multi-line suggestions, CI SHA-pinning, multi-provider support, the deterministic-scanner layer, and the hosted management site
