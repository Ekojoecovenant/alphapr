# AlphaPR design-concept brief

Internal brief for the four static concepts in this folder. Not part of the product.

## SHARED

You are building ONE static design concept file for AlphaPR, a bring-your-own-key AI pull-request reviewer that runs as a Cloudflare Worker + GitHub App. The owner will open these files in a browser, review them side by side, then pick or blend one for the real UI rewrite. Quality bar: a senior product designer's concept, not a bootstrap template.

### Hard requirements (every concept)

- ONE file, self-contained: inline `<style>`, inline `<script>`. No build step. Must render when opened from `file://` (relative links to sibling files are fine).
- No emoji in the marketing chrome. The mocked GitHub review output may contain the product's literal emoji because that is real product output.
- Semantic landmarks: `<header>`, `<main>`, `<section aria-labelledby>`, `<footer>`. Real `<a>`/`<button>` elements, visible `:focus-visible` ring (2px, offset 3px).
- Responsive at 1440 / 1024 / 390px. No horizontal scroll at 390px.
- Respect `prefers-reduced-motion`: no continuous animation, no scroll-triggered reveal; render the static final state.
- Body text contrast at least 4.5:1.
- Fixed top bar ~40px tall, mono micro-label: `AlphaPR · design concepts` left; right nav `00 index · 01 precision · 02 paper · 03 field · 04 split` with the current link marked `aria-current="page"` plus a visible dot/underline. Links are relative: `00-index.html`, `01-precision.html`, `02-paper.html`, `03-field.html`, `04-split.html`.
- End with a `<details>` block titled "Design notes", 5–8 terse bullets: palette rationale; motion budget (what animates, its cost, when it stops); what is cheap vs expensive to port into `src/setup-pages.ts` (one file returning template strings, ~190 lines, no framework, no bundler); accessibility notes; the honest weakness of this concept. Close with the line `Concept 0N — <name>. Static mockup, not wired to the worker.`
- Realistic content only. Do not invent product behaviour beyond the facts below.

### Product facts (do not contradict)

- BYOK: you supply your own provider key. Providers: OpenRouter (verified in production), Anthropic and OpenAI (implemented and contract-tested, NOT yet live-verified).
- Comments on the exact lines under review, with GitHub suggestion blocks the author can commit in one click.
- Remembers the last reviewed commit per PR: a re-push reviews only new commits; an identical SHA is skipped ("Already reviewed").
- Skips draft PRs until they are ready for review; honours a `[skip alphapr]` marker in the PR title.
- Configurable: severity threshold (all / minor and above / major only), tone (thorough / concise), ignore paths (comma-separated, `dir/` prefixes and `*.ext` suffixes).
- Two run modes: Cloudflare Queues, and a free tier that retries once when the first attempt fails fast.
- The check-run summary reports token usage for the review call, e.g. `12,431 tokens`.
- When a provider rejects the key, the failure comment quotes the provider's own message in a blockquote instead of hiding it.
- Install: the GitHub App at `github.com/apps/alphapr-ai`, then `/setup` to configure the key. Setup pages are server-rendered template strings; there is no SPA.
- Repo tagline: "A BYOK AI PR reviewer that comments on the exact lines it's talking about — and remembers what it already said."

### Shared page content (same story every time, different skin)

1. **Hero** — wordmark `ALPHAPR`, the tagline (or a tighter variant), primary CTA "Install the GitHub App", secondary "See a sample review" (may scroll-link to the sample), plus 3 short proof labels (e.g. "line-anchored", "incremental", "your key, your model").
2. **Sample review** — a review card: file header `src/auth/session.ts` with range `L42–L47`, a severity badge, the finding, and a suggestion block. Use exactly:
   - severity: `major · correctness`
   - text: "TTL is captured once at module load, so changing SESSION_TTL never takes effect until a cold start. Read it inside refreshSession(), or document that it needs a redeploy."
   - suggestion rows, minus then plus:
     ```
     - const TTL = Number(env.SESSION_TTL);
     + const TTL = Number(env.SESSION_TTL ?? "3600");
     ```
   - a small "Apply suggestion" affordance as GitHub shows it.
3. **How it works** — exactly 3 steps: **Connect** (install the app, paste your provider key on `/setup`), **Review** (reads the diff, validates every line number before it comments), **Remember** (only new commits are reviewed; the last reviewed SHA is stored per PR).
4. **Setup panel** — mock of the real `/setup` form: Installation select (`Ekojoecovenant · alphapr`), Provider select with OpenRouter selected plus `Anthropic (unverified)` / `OpenAI (unverified)`, API key password field with placeholder "Leave blank to keep your existing key", Model text field showing `deepseek/deepseek-v4-flash-0731`, Severity select (All / Minor and above / Major only), Tone (Thorough / Concise), Ignore paths (placeholder `dist/,*.lock,*.min.js`), submit "Save configuration".
5. **States** — three cards/rows: "Reviewing…" (in progress), "Reviewed 3 files · 2 findings · 12,431 tokens" (success), and a failure card whose comment reads exactly:
   `⚠️ **AlphaPR review failed.** This won't be retried — check your installation's configuration. (attempt 1/3)` followed by a blockquote: `openrouter auth error: 403 Key limit exceeded (total limit). $0.80 of $0.80 used; does not reset.`
6. **Footer** — "Install · Docs · Source on GitHub" plus the static-concept line.

### Anti-patterns (fail)

Purple/indigo gradient SaaS template, glassmorphism everywhere, shadow soup, `rounded-3xl` on everything. Lorem ipsum or invented metrics. Scroll-jacking, autoplay sound, animation that gates a CTA, rAF that keeps burning offscreen. Emoji icons (use inline SVG stroke icons, 24px grid, stroke 2, round caps, or none). Copy-pasting one CSS system across concepts — each concept must be a genuinely different visual system, not a different accent colour.

---

## CONCEPT 01 — Precision

The cheap, credible evolution of what exists today.

- **Visual system:** light, cool, GitHub-native. Background `#ffffff`, alternate surface `#f6f8fa`, hairline borders `#d8dee4`, ink `#1f2328`, muted `#59636e`, brand `#0f766e` used sparingly (links, one underline, the primary button), severity major `#cf222e` / minor `#9a6700` / nit `#59636e` on pale backgrounds `#ffebe9`, `#fff8c5`, `#f6f8fa`.
- **Type:** system-ui for everything, `ui-monospace` for paths, line numbers and micro-labels. **No webfont at all** — this concept argues for zero network dependencies.
- **Layout:** 720px reading column for hero copy, 1180px shell for sample review and setup mock. Cards: 1px border, 6px radius, no shadows except a single `0 1px 0 #d8dee4` hairline.
- **Motion:** 2D, CSS only, **zero JavaScript animation** — preferably no `<script>` at all. Staggered 6px rise-in on load with `animation-delay` 40/90/140ms; a single 1.4s highlight sweep across the `L42–L47` gutter; 2px hover lift on cards. Calm, dense, trustworthy — closer to Linear/GitHub than a marketing site.
- **Distinctive touch:** the sample review is a real GitHub diff table — 52px gutter with line numbers 41..47, `+`/`-` rows on `#e6ffec` / `#ffebe9`, and the comment hanging beneath row 47 with a left border and a `AlphaPR · bot` label. Argument: the product lives inside GitHub, so the site should feel like GitHub, and it can ship this week with no new dependencies and no JS.

## CONCEPT 02 — Paper & Ink

Editorial, warm, portfolio-inspired.

- **Palette:** steal from `C:\GitHub\ekojoe-portfolio\src\app\globals.css` — paper `#ffffff`, paper-2 `#f7f6f3`, paper-3 `#efeee9`; ink `#0a0a0a`/`#3b3b3b`/`#77756f`; line `#e4e1da`/`#c8c4ba`; accent `#ff5c00` (one word in the headline, CTA hover fill, the Apply-suggestion affordance — never a large field); teal `#0f766e` secondary; accent-soft `#fff1e8`.
- **Type:** Google Fonts — Space Grotesk (display 400–700), DM Mono (labels 400/500), Fraunces italic (one accent word), with fallbacks. Labels: DM Mono 10.5px uppercase, letter-spacing 0.12em. Headline: `clamp(2.6rem, 7.2vw, 4.9rem)`, weight 500, line-height 0.98, tracking -0.04em.
- **Layout:** 1200px shell, asymmetric editorial grid, 96–120px between sections, hairline rules instead of cards, one dot-grid panel (`radial-gradient(1px, rgba(10,10,10,.14))` at 22px).
- **Motion (JS, 2D):** a `<canvas>` "diff ribbon" in the hero's dot-grid panel — ~18 diff lines scrolling slowly upward inside the panel, each a rounded 2–3px bar of varying width (added teal at .55 alpha, removed accent at .45, context ink at .10), a soft hunk divider every 6th line, and one highlight pulsing down the gutter every 5s. Must respect reduced motion (draw one static frame), cap DPR at 2, pause via IntersectionObserver when offscreen, resize with ResizeObserver, no libraries. CSS reveals follow the portfolio rule: visible by default, only "armed" (`data-armed="true"`) when observed, so nothing is invisible without JS. Add a marquee ticker of reviewed paths (`src/auth/session.ts`, `workers/queue.ts`, `db/migrations/0008_add_review_usage.sql`, `test/review-gate.spec.ts`, …) driven by a CSS keyframe translating -50% on a duplicated track.
- **Distinctive touch:** the sample review styled as a printed report — DM Mono path header, thin orange left rule, severity as a 10.5px mono uppercase pill, suggestion on paper-3 with `-` in ink-3 and `+` in teal. Argument: AlphaPR is a craftsman's tool; taste doesn't require pretending to be an app.

## CONCEPT 03 — Field

Dark-first, three.js, one real 3D moment.

- **Palette:** canvas `#0d1112`, surface `#141a1c`, surface-raised `#1a2225`, line `#232b2e`, ink `#cbd7d9`, ink-muted `#8c9ca0`, brand `#3acbb9`, warning `#f59e0b`, danger `#ef4444`, success `#22c55e`, scrim `#050809`.
- **Type:** Google Fonts — Inter (300–700), JetBrains Mono (400/500). Labels: mono 10.5px uppercase, letter-spacing 0.14em. Headings tracking -0.02em.
- **3D:** three.js via classic CDN script tag (`https://unpkg.com/three@0.160.0/build/three.min.js`). If `window.THREE` is undefined, render a deliberate CSS/SVG static fallback plus a mono note "3D scene unavailable offline — static fallback".
- **Scene:** a "review field" — 14 thin diff-line slabs (`PlaneGeometry` ~0.9 × 0.045 × 0.012, or boxes) stacked 7×4 with per-slab z jitter; `MeshBasicMaterial` transparent, opacity 0.18, colour `0x2b3a3c` for context and `0x2ad4c0` for a few added lines; 5 small glowing spheres (`SphereGeometry` 0.055, `0x3acbb9`) at plausible slab coordinates as findings, plus 1 in danger red; thin `LineSegments` from each finding to the nearest slab edge at opacity 0.25. In a bordered panel (~4:3) on the right of the hero over a subtle radial glow, with mono captions under it ("review field / 14 slabs, 6 anchors" left, "three.js" right). `PerspectiveCamera(38, aspect, 0.1, 100)` at z ≈ 7.2 with a slight downward tilt. Group rotates at `t * 0.06` rad/s plus pointer parallax eased 0.04, bounded to ±6°. `setPixelRatio(min(devicePixelRatio, 2))`. Pause rAF when offscreen and when `document.hidden`; handle resize with ResizeObserver. Under reduced motion render exactly one frame, never start rAF.
- **Rest of the page:** hero; the sample review as a dark code-surface card with 1px `#232b2e` border, mono gutter numbers in ink-muted, added rows on `rgba(58,203,185,.08)` and removed on `rgba(239,68,68,.07)`; the 3-step flow as three hairline-separated rows with `01/02/03` in mono; the setup mock as a 2-column labelled field grid with dark inputs (`#101617`, 1px `#232b2e`, focus ring `#3acbb9`); the three states as a strip of status chips with real dot indicators (1.6s pulse only for in-progress, static under reduced motion).
- Argument: the most distinctive, most "2026 developer tool" option, with 3D confined to one panel so it never costs first paint or readability.

## CONCEPT 04 — Split Signal

**The recommended blend.** Light default with a real dark theme, one three.js panel, one working interaction.

- **Palette:** paper `#ffffff` / `#f7f6f3`, ink `#0a0a0a`/`#3b3b3b`/`#77756f`, line `#e4e1da`/`#c8c4ba`, brand teal `#0f766e` (primary) with `#3acbb9` only in dark theme and the 3D scene, accent orange `#ff5c00` reserved exclusively for "Apply suggestion" — a deliberate single-purpose accent. Severity: major `#d1242f`, minor `#9a6700`, nit `#77756f`. Type: Space Grotesk + DM Mono (Google Fonts).
- **Dark theme:** `[data-theme="dark"]` on `<html>` using the elly dark tokens (canvas `#0d1112`, surface `#141a1c`, line `#232b2e`, ink `#cbd7d9`, ink-muted `#8c9ca0`, brand `#3acbb9`). Default light; a top-bar toggle button (sun/moon SVG, `aria-pressed`, label "Toggle theme") flips the attribute and remembers the choice in `localStorage`, defaulting to `matchMedia("(prefers-color-scheme: dark)")`. Every colour must be a custom property so both themes are one attribute away — no duplicated rules.
- **Layout:** 1240px shell, 1.1fr / 0.9fr hero (copy left, visual right); the visual is a bordered panel containing a three.js scene with a static fallback if `window.THREE` is missing.
- **Scene:** "the anchor" — a vertical diff gutter in 3D: 9 thin horizontal slabs (`PlaneGeometry` 1.5 × 0.05, 0.16 gap) inside a taller frame, the 4th highlighted orange (the finding), a small wireframe box (`BoxGeometry` 0.34 + `EdgesGeometry`, `LineBasicMaterial` `0x0f766e`) floating just left of it as the comment anchor, and 4 thin vertical gutter rails. Rotate the group -18° on X and 12° on Y for a three-quarter view, oscillate `rotation.y` ±0.05 rad over 8s eased, pointer parallax eased 0.05. Pause rAF offscreen; one frame under reduced motion; DPR cap 2. Mono captions under the panel: "anchor · L42–L47" and "three.js · 9 slabs".
- **Interaction:** the sample review's "Apply suggestion" is a real `<button>`; clicking marks the suggestion as applied (teal check state, label becomes "Applied · commit c1f0a2e", 2px teal flash), keyboard accessible, `aria-live="polite"` announcement "Suggestion applied (mock)", plus a small mono "demo only" note.
- **Sections:** hero, sample review with diff rows, 3-step flow as a stepped horizontal timeline with a hairline connector, setup mock as a two-column labelled field grid, states strip where the failure card shows the quoted provider error in a `blockquote` with a 2px left border and mono text.
- Argument: keeps the cheap, legible craft of the light editorial direction, spends the 3D budget on exactly one panel, and still has dark mode plus a real interaction proving the pattern survives contact with the product.
