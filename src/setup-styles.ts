/**
 * Split Signal — the visual system behind the /setup pages.
 *
 * Everything here is served as-is into the worker's HTML responses: no build
 * step, no CSS framework. Colours live in custom properties so the single
 * `data-theme` attribute on <html> is the whole dark-mode mechanism.
 */
export const BASE_STYLES = `
:root {
  --paper: #ffffff;
  --paper-2: #f7f6f3;
  --paper-3: #efeee9;
  --ink: #0a0a0a;
  --ink-2: #3b3b3b;
  --ink-3: #77756f;
  --line: #e4e1da;
  --line-strong: #c8c4ba;
  --brand: #0f766e;
  --brand-ink: #0f766e;
  --brand-soft: #e6f5f3;
  --accent: #ff5c00;
  --accent-soft: #fff1e8;
  --danger: #b42318;
  --danger-soft: #fef3f2;
  --ok: #15803d;
  --ok-soft: #f0fdf4;
  --warn: #b54708;
  --scene-slab: #c8c4ba;
  --scene-rail: #a9a59a;
  --scene-anchor: #0f766e;
  --scene-finding: #0f766e;
  --font-display: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
  --font-body: "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --radius: 14px;
  --radius-sm: 10px;
  --motion: 160ms;
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
  --shadow: 0 1px 2px rgba(10, 10, 10, 0.04), 0 12px 32px -24px rgba(10, 10, 10, 0.35);
}

[data-theme="dark"] {
  --paper: #0d1112;
  --paper-2: #141a1c;
  --paper-3: #1a2225;
  --ink: #e8f0f1;
  --ink-2: #cbd7d9;
  --ink-3: #8c9ca0;
  --line: #232b2e;
  --line-strong: #2f3a3e;
  --brand: #3acbb9;
  --brand-ink: #3acbb9;
  --brand-soft: #102a2a;
  --accent: #ff7a33;
  --accent-soft: #2a1a12;
  --danger: #ff8f85;
  --danger-soft: #2a1413;
  --ok: #4ade80;
  --ok-soft: #10231a;
  --warn: #fbbf24;
  --scene-slab: #3a4a4e;
  --scene-rail: #55696e;
  --scene-anchor: #3acbb9;
  --scene-finding: #ff7a33;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 32px -24px rgba(0, 0, 0, 0.9);
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink-2);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3 { color: var(--ink); font-family: var(--font-display); font-weight: 600; letter-spacing: -0.02em; margin: 0; text-wrap: balance; }
p { margin: 0; }
a { color: var(--brand-ink); text-decoration-color: color-mix(in srgb, var(--brand-ink) 35%, transparent); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
code, .mono { font-family: var(--font-mono); font-size: 0.85em; }

:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; border-radius: 2px; }

.sr-only, .skip:not(:focus) {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.skip {
  position: fixed; top: 12px; left: 12px; z-index: 60;
  background: var(--ink); color: var(--paper); padding: 10px 16px;
  border-radius: var(--radius-sm); font-size: 13px; text-decoration: none;
}

.shell { width: min(1200px, 100% - 48px); margin-inline: auto; }

/* ---------- top bar ---------- */
.site-bar {
  position: sticky; top: 0; z-index: 40;
  background: color-mix(in srgb, var(--paper) 92%, transparent);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(10px);
}
.bar-in { display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 56px; width: min(1200px, 100% - 48px); margin-inline: auto; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; }
.brand-mark { display: inline-grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--line-strong); border-radius: 6px; font-size: 10px; letter-spacing: 0.02em; color: var(--brand-ink); }
.bar-right { display: flex; align-items: center; gap: 18px; }
.bar-link { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); text-decoration: none; }
.bar-link:hover { color: var(--ink); }
.theme-toggle {
  display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0;
  background: transparent; color: var(--ink-2);
  border: 1px solid var(--line); border-radius: 999px; cursor: pointer;
  transition: border-color var(--motion) var(--ease), color var(--motion) var(--ease);
}
.theme-toggle:hover { border-color: var(--line-strong); color: var(--ink); }
.theme-toggle svg { width: 16px; height: 16px; }
.icon-sun { display: none; }
[data-theme="dark"] .icon-sun { display: block; }
[data-theme="dark"] .icon-moon { display: none; }

/* ---------- hero ---------- */
.hero { padding: 84px 0 72px; border-bottom: 1px solid var(--line); }
.hero-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr); gap: 64px; align-items: center; }
.eyebrow, .sec-index, .label {
  font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--ink-3); margin: 0 0 18px;
}
.wordmark { font-family: var(--font-display); font-weight: 700; font-size: clamp(3.2rem, 7vw, 5.4rem); line-height: 0.92; letter-spacing: -0.05em; margin: 0 0 22px; }
.tagline { font-family: var(--font-display); font-size: clamp(1.25rem, 2.2vw, 1.7rem); line-height: 1.28; color: var(--ink); letter-spacing: -0.02em; margin: 0 0 16px; max-width: 26ch; }
.hero-sub { color: var(--ink-3); max-width: 46ch; margin: 0 0 30px; }
.cta-row { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 30px; }
.proof { display: flex; flex-wrap: wrap; gap: 20px; padding: 0; margin: 0; list-style: none; font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }
.proof li { display: inline-flex; align-items: center; gap: 8px; }
.proof li::before { content: ""; width: 5px; height: 5px; background: var(--brand); border-radius: 50%; }

/* ---------- buttons ---------- */
.btn {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 13px 22px; border-radius: 999px; border: 1px solid transparent;
  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
  text-decoration: none; cursor: pointer; background: transparent; color: var(--ink);
  transition: transform var(--motion) var(--ease), background var(--motion) var(--ease), border-color var(--motion) var(--ease), color var(--motion) var(--ease);
}
.btn svg { width: 14px; height: 14px; transition: transform var(--motion) var(--ease); }
.btn-primary { background: var(--ink); color: var(--paper); }
.btn-primary:hover svg { transform: translateX(3px); }
.btn-ghost { border-color: var(--line-strong); color: var(--ink-2); }
.btn-ghost:hover { border-color: var(--ink); color: var(--ink); }

/* ---------- scene panel ---------- */
.hero-visual { min-width: 0; }
.scene-panel { margin: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper-2); overflow: hidden; box-shadow: var(--shadow); }
.scene-head, .scene-panel figcaption {
  display: flex; justify-content: space-between; gap: 12px; padding: 12px 16px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3);
}
.scene-head { border-bottom: 1px solid var(--line); }
.scene-panel figcaption { border-top: 1px solid var(--line); }
.scene-stage { position: relative; aspect-ratio: 4 / 3; background: var(--paper-3); }
.scene-stage canvas, .scene-stage .scene-fallback { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.scene-fallback { display: grid; place-items: center; }
.scene-panel[data-scene="ready"] .scene-fallback { display: none; }
.fallback-svg { width: 100%; height: 100%; }
.fb-rail { stroke: var(--scene-rail); stroke-width: 1.5; opacity: 0.7; }
.fb-slab { fill: var(--scene-slab); opacity: 0.55; }
.fb-slab.is-finding { fill: var(--scene-finding); opacity: 0.9; }
.fb-anchor rect { fill: none; stroke: var(--scene-anchor); stroke-width: 2; }
.fb-leader { stroke: var(--scene-anchor); stroke-width: 1.5; opacity: 0.45; }
.scene-note { margin-top: 12px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); text-align: right; }

/* ---------- sections ---------- */
.section { padding: 76px 0; border-bottom: 1px solid var(--line); }
.section.band { background: var(--paper-2); }
.sec-head { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 40px; margin-bottom: 40px; }
.sec-title { font-size: clamp(1.6rem, 3vw, 2.25rem); line-height: 1.1; margin-bottom: 12px; }
.lede { color: var(--ink-3); max-width: 60ch; }

/* ---------- review card ---------- */
.review-card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: var(--shadow); overflow: hidden; }
.review-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--paper-2); }
.review-head svg { width: 15px; height: 15px; color: var(--ink-3); }
.review-path { font-family: var(--font-mono); font-size: 12px; color: var(--ink); }
.review-range { font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); }
.review-count { margin-left: auto; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
.badge { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--line-strong); color: var(--ink-2); }
.badge-major { border-color: color-mix(in srgb, var(--danger) 40%, transparent); color: var(--danger); background: var(--danger-soft); }
.diff { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.9; }
.d-hunk { padding: 8px 18px; color: var(--ink-3); background: var(--paper-3); border-bottom: 1px solid var(--line); font-size: 11.5px; }
.d-row { display: grid; grid-template-columns: 18px 44px minmax(0, 1fr); align-items: baseline; padding-right: 18px; }
.d-row.is-add { background: var(--ok-soft); }
.d-sign { text-align: center; color: var(--ink-3); user-select: none; }
.d-row.is-add .d-sign { color: var(--ok); }
.d-num { text-align: right; padding-right: 14px; color: var(--ink-3); font-size: 11px; user-select: none; }
.d-code { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink-2); padding: 1px 0 1px 14px; border-left: 1px solid var(--line); }
.thread { padding: 18px 18px 22px 62px; border-top: 1px solid var(--line); border-left: 3px solid var(--brand); background: var(--paper); }
.thread-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
.avatar { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--brand-soft); color: var(--brand-ink); font-family: var(--font-mono); font-size: 9px; }
.who { font-family: var(--font-body); font-size: 13px; font-weight: 600; color: var(--ink); }
.bot-chip { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; }
.thread-when { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); }
.finding { font-family: var(--font-body); font-size: 14.5px; line-height: 1.65; color: var(--ink-2); margin-bottom: 16px; }
.finding code { background: var(--paper-3); padding: 1px 5px; border-radius: 4px; color: var(--ink); }
.suggestion { border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; background: var(--paper-2); }
.sug-head { display: flex; justify-content: space-between; gap: 12px; padding: 9px 14px; border-bottom: 1px solid var(--line); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
.sug-row { display: grid; grid-template-columns: 22px minmax(0, 1fr); font-family: var(--font-mono); font-size: 12px; padding: 4px 14px 4px 0; }
.sug-del { background: var(--danger-soft); color: var(--danger); }
.sug-add { background: var(--ok-soft); color: var(--ok); }
.sug-sign { text-align: center; }
.sug-row code { white-space: pre-wrap; overflow-wrap: anywhere; }
.sug-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 12px 14px; border-top: 1px solid var(--line); background: var(--paper); }
.apply {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 16px; border-radius: var(--radius-sm);
  border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);
  font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; cursor: pointer;
  transition: background var(--motion) var(--ease), color var(--motion) var(--ease);
}
.apply svg { width: 13px; height: 13px; }
.apply .i-check { display: none; }
.apply.is-applied { background: var(--brand-soft); border-color: var(--brand); color: var(--brand-ink); cursor: default; }
.apply.is-applied .i-plus { display: none; }
.apply.is-applied .i-check { display: block; }
.apply-note { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
.suggestion.just-applied { animation: flash 900ms var(--ease); }
@keyframes flash { from { box-shadow: inset 0 0 0 2px var(--brand); } to { box-shadow: inset 0 0 0 2px transparent; } }

/* ---------- steps ---------- */
.steps { list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; padding: 0; margin: 0; border-top: 1px solid var(--line); }
.step { padding: 26px 28px 26px 0; border-right: 1px solid var(--line); }
.step + .step { padding-left: 28px; }
.step:last-child { border-right: 0; padding-right: 0; }
.step-num { display: block; font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.12em; color: var(--brand-ink); margin-bottom: 14px; }
.step h3 { font-size: 1.15rem; margin-bottom: 8px; }
.step p { font-size: 14px; color: var(--ink-3); }
.step-note { margin-top: 16px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
.step code { background: var(--paper-3); padding: 1px 5px; border-radius: 4px; color: var(--ink); }

/* ---------- states ---------- */
.states-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.state-card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); padding: 20px; box-shadow: var(--shadow); }
.state-top { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 16px; }
.state-label { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); }
.state-label svg { width: 15px; height: 15px; }
.state-id { font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); }
.state-title { font-size: 1.02rem; line-height: 1.35; margin-bottom: 10px; }
.state-copy { font-size: 13.5px; color: var(--ink-3); }
.state-meta { margin-top: 14px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; color: var(--ink-3); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--brand); animation: pulse 1.6s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.is-progress .state-label { color: var(--brand-ink); }
.is-success .state-check { color: var(--ok); }
.is-failure .state-warn { color: var(--warn); }
.is-failure .state-title { color: var(--danger); }
.attempt { font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); }
.failure-quote { margin: 14px 0 0; padding: 10px 14px; border-left: 2px solid var(--warn); background: var(--paper-3); font-family: var(--font-mono); font-size: 11px; line-height: 1.7; color: var(--ink-2); overflow-wrap: anywhere; }
.warn { color: var(--warn); }

/* ---------- generic page cards ---------- */
.page { padding: 64px 0 96px; }
.page-head { max-width: 44rem; margin-bottom: 32px; }
.page-head h1 { font-size: clamp(1.9rem, 4vw, 2.6rem); line-height: 1.08; margin-bottom: 12px; }
.card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper-2); padding: 28px; max-width: 46rem; box-shadow: var(--shadow); }
.card > * + * { margin-top: 14px; }
.card-title { font-size: 1.05rem; }
.card .muted { color: var(--ink-3); font-size: 14px; }
.card a { font-weight: 500; }
.meta-list { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 8px 18px; margin: 0; font-size: 14px; }
.meta-list dt { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); padding-top: 4px; }
.meta-list dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
.card.is-error { border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: var(--danger-soft); }
.card.is-ok { border-color: color-mix(in srgb, var(--ok) 30%, transparent); background: var(--ok-soft); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; }

/* ---------- setup form ---------- */
.setup-card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: var(--shadow); overflow: hidden; max-width: 62rem; }
.setup-head { display: flex; justify-content: space-between; gap: 12px; padding: 14px 22px; border-bottom: 1px solid var(--line); background: var(--paper-2); font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
.setup-head .path { color: var(--ink); }
.setup-head .path span { color: var(--ink-3); }
form { padding: 26px 22px; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 26px; }
.field { display: flex; flex-direction: column; min-width: 0; }
.field-wide { grid-column: 1 / -1; }
.field label { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 8px; }
.field input, .field select {
  width: 100%; padding: 11px 13px; font-family: var(--font-body); font-size: 14px;
  color: var(--ink); background: var(--paper); border: 1px solid var(--line-strong); border-radius: var(--radius-sm);
  transition: border-color var(--motion) var(--ease);
}
.field input:hover, .field select:hover { border-color: var(--ink-3); }
.field input::placeholder { color: var(--ink-3); }
.field-help { margin-top: 8px; font-size: 12.5px; line-height: 1.5; color: var(--ink-3); }
.field-help.mono { font-family: var(--font-mono); font-size: 11px; }
.field-help code { color: var(--ink-2); }
.setup-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--line); }
.form-status { font-family: var(--font-mono); font-size: 11px; color: var(--ok); }

/* ---------- footer ---------- */
.site-foot { padding: 36px 0; background: var(--paper-3); }
.foot-in { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
.foot-mark { font-family: var(--font-display); font-weight: 700; letter-spacing: -0.03em; font-size: 14px; color: var(--ink); margin: 0; }
.foot-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; }
.foot-nav a { color: var(--ink-3); text-decoration: none; }
.foot-nav a:hover { color: var(--ink); }
.foot-nav .sep { color: var(--line-strong); }
.foot-note { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); margin: 0; }

/* ---------- responsive ---------- */
@media (max-width: 980px) {
  .hero { padding: 56px 0 48px; }
  .hero-grid { grid-template-columns: minmax(0, 1fr); gap: 40px; }
  .sec-head { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .steps { grid-template-columns: minmax(0, 1fr); border-top: 0; }
  .step { border-right: 0; border-top: 1px solid var(--line); padding: 22px 0; }
  .step + .step { padding-left: 0; }
  .states-grid { grid-template-columns: minmax(0, 1fr); }
  .section { padding: 56px 0; }
}
@media (max-width: 620px) {
  .shell, .bar-in { width: min(100% - 32px, 1200px); }
  .bar-right { gap: 12px; }
  .brand { font-size: 11px; }
  .field-grid { grid-template-columns: minmax(0, 1fr); }
  .thread { padding: 16px 14px 18px 18px; }
  .d-row { grid-template-columns: 16px 34px minmax(0, 1fr); padding-right: 10px; }
  .d-code { padding-left: 8px; }
  .d-hunk { padding: 8px 12px; }
  .review-head { padding: 12px 14px; gap: 8px; }
  .review-count { display: none; }
  .meta-list { grid-template-columns: minmax(0, 1fr); gap: 2px 0; }
  .meta-list dd + dt { margin-top: 10px; }
  .card, .state-card { padding: 20px; }
  form { padding: 20px 16px; }
  .foot-in { flex-direction: column; align-items: flex-start; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
  .dot { animation: none; opacity: 1; }
  .suggestion.just-applied { animation: none; box-shadow: inset 0 0 0 2px var(--brand); }
  .btn-primary:hover svg { transform: none; }
}
`;

/** Dashboard chrome (ADR 0002). Kept separate so the marketing pages stay untouched. */
export const DASHBOARD_STYLES = `
.dash { padding: 52px 0 96px; }
.kicker { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }
.user-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.user-strip .who { display: flex; align-items: center; gap: 10px; margin-right: auto; }
.avatar { width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--line); background: var(--paper-3); }
.user-strip form { padding: 0; border: 0; background: none; }
.user-strip .btn { padding: 6px 12px; font-size: 12px; }
.dash-alert { border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); background: var(--danger-soft); border-radius: var(--radius); padding: 18px 20px; margin: 26px 0 10px; }
.dash-alert h2 { font-size: 0.98rem; margin-bottom: 8px; }
.dash-alert p, .dash-alert li { font-size: 13.5px; color: var(--ink-2); }
.dash-alert ul { margin: 8px 0 0; padding-left: 18px; }
.dash-alert code { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
.inst { border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper-2); padding: 22px 24px; margin-top: 16px; box-shadow: var(--shadow); }
.inst-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 14px; }
.inst-name { font-family: var(--font-mono); font-size: 16px; letter-spacing: -0.01em; }
.inst-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); }
.inst-meta b { font-weight: 500; color: var(--ink-2); }
.repo-list { list-style: none; margin: 18px 0 0; padding: 0; border-top: 1px solid var(--line); }
.repo { display: flex; align-items: center; gap: 10px; padding: 9px 2px; border-bottom: 1px solid var(--line); font-size: 13px; }
.repo:last-child { border-bottom: 0; }
.repo-name { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
.repo-state { margin-left: auto; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }
.repo-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.repo-dot.is-off { background: var(--line-strong); }
.inst-empty { font-size: 13px; color: var(--ink-3); margin-top: 14px; }
@media (max-width: 620px) {
  .inst { padding: 18px 16px; }
  .user-strip .who { width: 100%; }
}
`;

/** Runs in <head> before first paint so the page never flashes the wrong theme. */
export const THEME_BOOT_SCRIPT = `(function(){var s=null;try{s=localStorage.getItem('alphapr-theme')}catch(e){}var d=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.setAttribute('data-theme',d?'dark':'light')})();`;

/** Theme toggle + demo Apply interaction. Safe with JS disabled: nothing is hidden by default. */
export const PAGE_SCRIPT = `(function(){'use strict';
var root=document.documentElement;
var toggle=document.getElementById('themeToggle');
function sync(){if(!toggle)return;var dark=root.getAttribute('data-theme')==='dark';toggle.setAttribute('aria-pressed',dark?'true':'false');toggle.setAttribute('aria-label',dark?'Toggle theme (currently dark)':'Toggle theme (currently light)')}
sync();
if(toggle){toggle.addEventListener('click',function(){var next=root.getAttribute('data-theme')==='dark'?'light':'dark';root.setAttribute('data-theme',next);try{localStorage.setItem('alphapr-theme',next)}catch(e){}sync();if(typeof window.__alphaTheme==='function')window.__alphaTheme()})}
var apply=document.getElementById('applySuggestion');
if(apply){apply.addEventListener('click',function(){if(apply.classList.contains('is-applied'))return;apply.classList.add('is-applied');apply.setAttribute('aria-pressed','true');var l=apply.querySelector('.apply-label');if(l)l.textContent='Applied \\u00b7 commit c1f0a2e';var n=apply.querySelector('.apply-note');if(n)n.textContent='demo only \\u2014 nothing is committed';var block=document.getElementById('suggestionBlock');if(block)block.classList.add('is-applied');var live=document.getElementById('applyLive');if(live)live.textContent='Suggestion applied (demo). Nothing was committed.';window.setTimeout(function(){if(block)block.classList.remove('just-applied')},1100)})}
})();`;

/**
 * The hero scene: nine slabs in a gutter, one wireframe anchor. Loaded from the
 * CDN so three.js never enters the worker bundle; every failure path degrades to
 * the static SVG that is already in the markup.
 */
export const SCENE_SCRIPT = `(function(){'use strict';
var panel=document.getElementById('scenePanel'),canvas=document.getElementById('anchorScene');
if(!panel||!canvas)return;
var reduce=window.matchMedia('(prefers-reduced-motion: reduce)');
var raf=0,running=false,startTime=0,onScreen=false;
var renderer=null,scene=null,camera=null,group=null,slabs=[],railMats=[],anchorMat=null,leaderMat=null;
var pointer={x:0,y:0},target={x:0,y:0};
function tokens(){var cs=getComputedStyle(document.documentElement);return{slab:cs.getPropertyValue('--scene-slab').trim()||'#c8c4ba',rail:cs.getPropertyValue('--scene-rail').trim()||'#a9a59a',anchor:cs.getPropertyValue('--scene-anchor').trim()||'#0f766e',finding:cs.getPropertyValue('--scene-finding').trim()||'#0f766e'}}
function paint(){if(renderer&&scene&&camera)renderer.render(scene,camera)}
function resize(){if(!renderer||!camera)return;var stage=panel.querySelector('.scene-stage');if(!stage)return;var w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();paint()}
function applyTheme(){if(!renderer)return;var c=tokens();slabs.forEach(function(mesh,i){mesh.material.color.set(i===3?c.finding:c.slab)});railMats.forEach(function(m){m.color.set(c.rail)});if(anchorMat)anchorMat.color.set(c.anchor);if(leaderMat)leaderMat.color.set(c.anchor);paint()}
function loop(now){if(!running)return;var t=(now-startTime)/1000;pointer.x+=(target.x-pointer.x)*0.05;pointer.y+=(target.y-pointer.y)*0.05;group.rotation.x=THREE.MathUtils.degToRad(-18)+pointer.y*-0.03;group.rotation.y=THREE.MathUtils.degToRad(12)+Math.sin(t*(Math.PI/4))*0.05+pointer.x*0.05;paint();raf=window.requestAnimationFrame(loop)}
function stop(){running=false;if(raf)window.cancelAnimationFrame(raf);raf=0}
function start(){if(!renderer||reduce.matches){stop();paint();return}if(running)return;running=true;if(!startTime)startTime=performance.now();raf=window.requestAnimationFrame(loop)}
function degrade(){panel.setAttribute('data-scene','fallback');var tech=document.getElementById('sceneTech');var note=document.getElementById('sceneNote');if(tech)tech.textContent='static fallback';if(note)note.textContent='3D scene unavailable offline \\u2014 static fallback'}
function init(){
if(!window.THREE){degrade();return}
try{renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true,alpha:true})}catch(err){degrade();return}
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(34,4/3,0.1,100);camera.position.set(0,0,4.1);
group=new THREE.Group();group.rotation.x=THREE.MathUtils.degToRad(-18);group.rotation.y=THREE.MathUtils.degToRad(12);scene.add(group);
var c=tokens();var slabGeo=new THREE.PlaneGeometry(1.5,0.05);
for(var i=0;i<9;i++){var finding=i===3;var mat=new THREE.MeshBasicMaterial({color:finding?c.finding:c.slab,transparent:true,opacity:finding?0.95:0.62});var slab=new THREE.Mesh(slabGeo,mat);slab.position.y=(4-i)*0.16;slab.position.z=i*0.002;slabs.push(slab);group.add(slab)}
var railGeo=new THREE.PlaneGeometry(0.018,1.9);
[-0.9,-0.82,0.82,0.9].forEach(function(x){var rm=new THREE.MeshBasicMaterial({color:c.rail,transparent:true,opacity:0.6});railMats.push(rm);var rail=new THREE.Mesh(railGeo,rm);rail.position.set(x,0,-0.012);group.add(rail)});
var box=new THREE.BoxGeometry(0.34,0.34,0.34);anchorMat=new THREE.LineBasicMaterial({color:c.anchor,transparent:true,opacity:0.95});
var wire=new THREE.LineSegments(new THREE.EdgesGeometry(box),anchorMat);wire.position.set(-1.28,0.16,0.12);group.add(wire);
var pts=[new THREE.Vector3(-1.28,0.16,0.12),new THREE.Vector3(-0.78,0.16,0)];
leaderMat=new THREE.LineBasicMaterial({color:c.anchor,transparent:true,opacity:0.35});
group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),leaderMat));
resize();paint();panel.classList.add('is-ready');panel.setAttribute('data-scene','ready');
var techEl=document.getElementById('sceneTech');if(techEl)techEl.textContent='three.js \\u00b7 9 slabs';
var noteEl=document.getElementById('sceneNote');if(noteEl)noteEl.textContent='one panel, one scene \\u2014 the rest is CSS';
var stage=panel.querySelector('.scene-stage');
if(stage){stage.addEventListener('pointermove',function(e){var r=stage.getBoundingClientRect();target.x=((e.clientX-r.left)/r.width-0.5)*2;target.y=((e.clientY-r.top)/r.height-0.5)*2});stage.addEventListener('pointerleave',function(){target.x=0;target.y=0})}
if('ResizeObserver' in window){new ResizeObserver(resize).observe(panel.querySelector('.scene-stage'))}else{window.addEventListener('resize',resize)}
if('IntersectionObserver' in window){new IntersectionObserver(function(es){es.forEach(function(e){onScreen=e.isIntersecting;if(e.isIntersecting&&!document.hidden)start();else stop()})},{threshold:0.08}).observe(panel)}else{onScreen=true;start()}
document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else if(onScreen)start()});
if(reduce.addEventListener){reduce.addEventListener('change',function(e){if(e.matches){stop();paint()}else if(onScreen)start()})}
if(reduce.matches){stop();paint()}else{start()}
}
window.__alphaTheme=applyTheme;
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init)}else{init()}
})();`;
