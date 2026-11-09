import { BASE_STYLES, DASHBOARD_STYLES, PAGE_SCRIPT, SCENE_SCRIPT, THEME_BOOT_SCRIPT } from './setup-styles';

export function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const FONTS =
	'<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=DM+Mono:wght@400;500&display=swap">';

const PAGE_SCRIPT_TAG = `<script>${PAGE_SCRIPT}</script>`;
const SCENE_SCRIPTS = `<script src="https://unpkg.com/three@0.160.0/build/three.min.js" defer></script><script>${SCENE_SCRIPT}</script>`;

export interface ShellOptions {
	scene?: boolean;
	signedIn?: boolean;
	login?: string;
	/** The CSRF token the top-bar sign-out form must post — without it, logout is a 403. */
	csrf?: string;
}

export function shell(title: string, body: string, opts: ShellOptions = {}): string {
	const barRight = [
		opts.signedIn ? `<a class="bar-link" href="/dashboard">/dashboard</a>` : '',
		`<a class="bar-link" href="/setup">/setup</a>`,
		`<a class="bar-link" href="https://github.com/Ekojoecovenant/alphapr">GitHub</a>`,
		opts.signedIn && opts.csrf
			? `<form class="bar-form" method="POST" action="/auth/logout"><input type="hidden" name="csrf" value="${esc(opts.csrf)}"><button class="bar-link" type="submit">Sign out${opts.login ? ` @${esc(opts.login)}` : ''}</button></form>`
			: '',
		`<button class="theme-toggle" id="themeToggle" type="button" aria-pressed="false" aria-label="Toggle theme">
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    </button>`,
	]
		.filter(Boolean)
		.join('\n    ');

	return `<!DOCTYPE html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · AlphaPR</title>
<meta name="description" content="AlphaPR is a BYOK AI pull-request reviewer that comments on the exact lines it is talking about, and remembers what it already said.">
<script>${THEME_BOOT_SCRIPT}</script>
${FONTS}
<style>${BASE_STYLES}${DASHBOARD_STYLES}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-bar"><div class="bar-in">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">AP</span>AlphaPR</a>
  <div class="bar-right">
    ${barRight}
  </div>
</div></header>
<main id="main">
${body}
</main>
<footer class="site-foot"><div class="shell foot-in">
  <p class="foot-mark">ALPHAPR</p>
  <nav class="foot-nav" aria-label="Footer">
    <a href="https://github.com/apps/alphapr-ai">Install</a><span class="sep" aria-hidden="true">·</span><a href="https://github.com/Ekojoecovenant/alphapr">Source</a><span class="sep" aria-hidden="true">·</span><a href="/setup">Configure</a>
  </nav>
  <p class="foot-note">BYOK · Cloudflare Worker · GitHub App</p>
</div></footer>
${PAGE_SCRIPT_TAG}${opts.scene ? SCENE_SCRIPTS : ''}
</body></html>`;
}

function pageHead(title: string, lede: string): string {
	return `<div class="page"><div class="shell"><header class="page-head"><h1>${title}</h1><p class="lede">${lede}</p></header>`;
}

export function errorPage(message: string, opts: { showRetry?: boolean } = {}): string {
	return shell(
		'Error',
		`${pageHead('That didn’t work.', 'Nothing was saved. Fix the problem below and try again.')}
        <div class="card is-error">
          <p class="card-title" role="alert">${esc(message)}</p>
          ${
						opts.showRetry !== false
							? '<div class="actions"><a class="btn btn-primary" href="/setup">Start over</a><a class="btn btn-ghost" href="/">Back to home</a></div>'
							: ''
					}
        </div>
      </div></div>`,
	);
}

export function noInstallationsPage(): string {
	return shell(
		'Get started',
		`${pageHead('No installation to configure.', 'AlphaPR has to be installed on an account you administer before there is anything to set up.')}
        <div class="card">
          <p>No AlphaPR installations were found that you have permission to configure.</p>
          <p class="muted">You must be the account owner, or an organization admin, to configure an installation. Being a repository collaborator is not sufficient.</p>
          <div class="actions">
            <a class="btn btn-primary" href="https://github.com/apps/alphapr-ai">Install AlphaPR</a>
            <a class="btn btn-ghost" href="/setup">Check again</a>
          </div>
        </div>
      </div></div>`,
	);
}

export interface ConfigFormData {
	installationOptions: string;
	currentProvider: string;
	currentModel: string;
	currentSeverity: string;
	currentTone: string;
	currentIgnorePaths: string;
	formToken: string;
}

export function configFormPage(data: ConfigFormData): string {
	return shell(
		'Configure',
		`${pageHead('Your key. Your model. One page.', 'Every setting AlphaPR reads lives here. The key is encrypted with AES-GCM before it touches the database, and the form is rendered on the server. Your installations, repos and settings are listed on the <a href="/dashboard">dashboard</a>.')}
        <div class="setup-card">
          <div class="setup-head"><span class="path">alphapr-ai <span>/ setup</span></span><span>server-rendered</span></div>
          <form method="POST" action="/setup/save">
            <div class="field-grid">
              <div class="field">
                <label for="installationId">Installation</label>
                <select id="installationId" name="installationId">${data.installationOptions}</select>
                <p class="field-help">One configuration per installation.</p>
              </div>

              <div class="field">
                <label for="providerSelect">Provider</label>
                <select id="providerSelect" name="provider">
                  <option value="openrouter" ${data.currentProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                  <option value="anthropic" ${data.currentProvider === 'anthropic' ? 'selected' : ''}>Anthropic (unverified)</option>
                  <option value="openai" ${data.currentProvider === 'openai' ? 'selected' : ''}>OpenAI (unverified)</option>
                </select>
                <p class="field-help">OpenRouter is verified in production. The Anthropic and OpenAI adapters are implemented but have not been tested against live APIs — if you use one and hit a problem, please <a href="https://github.com/Ekojoecovenant/alphapr/issues">open an issue</a>.</p>
              </div>

              <div class="field">
                <label for="apiKey">API key</label>
                <input id="apiKey" name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Leave blank to keep your existing key">
                <p class="field-help">Required on first setup. Leave blank when editing settings to keep your current key.</p>
              </div>

              <div class="field">
                <label for="model">Model</label>
                <input id="model" name="model" type="text" value="${esc(data.currentModel)}" spellcheck="false">
                <p class="field-help">Model ID for your chosen provider (e.g. <code>deepseek/deepseek-v4-flash</code> for OpenRouter, <code>claude-sonnet-4-5</code> for Anthropic, <code>gpt-4o</code> for OpenAI). Fast, non-reasoning models are recommended.</p>
              </div>

              <div class="field">
                <label for="severityThreshold">Severity threshold</label>
                <select id="severityThreshold" name="severityThreshold">
                  <option value="all" ${data.currentSeverity === 'all' ? 'selected' : ''}>All (major, minor, nits)</option>
                  <option value="minor" ${data.currentSeverity === 'minor' ? 'selected' : ''}>Minor and above</option>
                  <option value="major" ${data.currentSeverity === 'major' ? 'selected' : ''}>Major only</option>
                </select>
                <p class="field-help">Nits never interrupt a review unless you ask for them.</p>
              </div>

              <div class="field">
                <label for="reviewTone">Review tone</label>
                <select id="reviewTone" name="reviewTone">
                  <option value="thorough" ${data.currentTone === 'thorough' ? 'selected' : ''}>Thorough</option>
                  <option value="concise" ${data.currentTone === 'concise' ? 'selected' : ''}>Concise</option>
                </select>
                <p class="field-help">Same findings, different amount of prose.</p>
              </div>

              <div class="field field-wide">
                <label for="ignorePaths">Ignore paths</label>
                <input id="ignorePaths" name="ignorePaths" type="text" value="${esc(data.currentIgnorePaths)}" placeholder="dist/,*.lock,*.min.js" spellcheck="false">
                <p class="field-help">Comma-separated. Supports "dir/" prefixes and "*.ext" suffixes. If you can configure more than one installation, this form pre-fills the first one's saved settings — check the Installation dropdown above before saving.</p>
              </div>
            </div>

            <input type="hidden" name="token" value="${esc(data.formToken)}">
            <div class="setup-foot">
              <p class="form-status" role="status">Changes apply to the next pull request.</p>
              <button class="btn btn-primary" type="submit">Save configuration</button>
            </div>
          </form>
        </div>
      </div></div>`,
	);
}

export function successPage(login: string, installationId: number): string {
	return shell(
		'Saved',
		`${pageHead('Saved. Nothing else to do.', 'AlphaPR is configured. Open or update a pull request and the review lands on the diff.')}
        <div class="card is-ok">
          <p class="card-title">Configuration saved</p>
          <dl class="meta-list">
            <dt>Account</dt><dd>${esc(login)}</dd>
            <dt>Installation</dt><dd>${installationId}</dd>
            <dt>Next step</dt><dd>Open or update a pull request to trigger a review.</dd>
          </dl>
          <div class="actions">
            <a class="btn btn-primary" href="https://github.com/Ekojoecovenant/alphapr">View the source</a>
            <a class="btn btn-ghost" href="/setup">Edit settings</a>
          </div>
        </div>
      </div></div>`,
	);
}

const SCENE_PANEL = `<figure class="scene-panel" id="scenePanel" data-scene="fallback">
  <div class="scene-head"><span>The anchor</span><span>L42–L47</span></div>
  <div class="scene-stage">
    <canvas id="anchorScene" aria-hidden="true"></canvas>
    <div class="scene-fallback" aria-hidden="true">
      <svg class="fallback-svg" viewBox="0 0 600 460" preserveAspectRatio="xMidYMid meet">
        <g class="fb-rails">
          <line class="fb-rail" x1="138" y1="92" x2="138" y2="360"/>
          <line class="fb-rail" x1="147" y1="95" x2="147" y2="363"/>
          <line class="fb-rail" x1="473" y1="74" x2="473" y2="342"/>
          <line class="fb-rail" x1="482" y1="71" x2="482" y2="339"/>
        </g>
        <g class="fb-slabs">
          <polygon class="fb-slab" points="160,110 462,92 462,102 160,120"/>
          <polygon class="fb-slab" points="160,138 462,120 462,130 160,148"/>
          <polygon class="fb-slab" points="160,166 462,148 462,158 160,176"/>
          <polygon class="fb-slab is-finding" points="160,194 462,176 462,186 160,204"/>
          <polygon class="fb-slab" points="160,222 462,204 462,214 160,232"/>
          <polygon class="fb-slab" points="160,250 462,232 462,242 160,260"/>
          <polygon class="fb-slab" points="160,278 462,260 462,270 160,288"/>
          <polygon class="fb-slab" points="160,306 462,288 462,298 160,316"/>
          <polygon class="fb-slab" points="160,334 462,316 462,326 160,344"/>
        </g>
        <g class="fb-anchor">
          <rect x="64" y="166" width="46" height="46"/>
          <line class="fb-leader" x1="110" y1="189" x2="160" y2="199"/>
        </g>
      </svg>
    </div>
  </div>
  <figcaption><span>anchor · L42–L47</span><span id="sceneTech">static fallback</span></figcaption>
</figure>
<p class="scene-note" id="sceneNote">one panel, one scene — the rest is CSS</p>`;

const SAMPLE_REVIEW = `<div class="review-card">
  <div class="review-head">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
    <span class="review-path">src/auth/session.ts</span>
    <span class="review-range">L42–L47</span>
    <span class="badge badge-major">major · correctness</span>
    <span class="review-count">finding 1 of 2</span>
  </div>

  <div class="diff" role="group" aria-label="Diff for src/auth/session.ts, lines 41 to 48">
    <div class="d-hunk">@@ -41,7 +41,8 @@ refreshSession()</div>

    <div class="d-row"><span class="d-sign" aria-hidden="true"></span><span class="d-num" aria-hidden="true">41</span><code class="d-code">// session lifetime, resolved from the worker env</code></div>
    <div class="d-row is-add"><span class="d-sign" aria-hidden="true">+</span><span class="d-num" aria-hidden="true">42</span><code class="d-code">const TTL = Number(env.SESSION_TTL);</code></div>

    <div class="thread">
      <div class="thread-head">
        <span class="avatar" aria-hidden="true">AP</span>
        <span class="who">AlphaPR</span>
        <span class="bot-chip">bot</span>
        <span class="badge badge-major">major · correctness</span>
        <span class="thread-when">just now</span>
      </div>
      <div class="thread-body">
        <p class="finding">TTL is captured once at module load, so changing <code>SESSION_TTL</code> never takes effect until a cold start. Read it inside <code>refreshSession()</code>, or document that it needs a redeploy.</p>

        <div class="suggestion" id="suggestionBlock">
          <div class="sug-head"><span>Suggested change</span><span class="sug-range">src/auth/session.ts · L42</span></div>
          <div class="sug-row sug-del"><span class="sug-sign" aria-hidden="true">-</span><code>const TTL = Number(env.SESSION_TTL);</code></div>
          <div class="sug-row sug-add"><span class="sug-sign" aria-hidden="true">+</span><code>const TTL = Number(env.SESSION_TTL ?? "3600");</code></div>
          <div class="sug-actions">
            <button class="apply" id="applySuggestion" type="button" aria-pressed="false">
              <svg class="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
              <svg class="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12.5 5 5L20 6.5"/></svg>
              <span class="apply-label">Apply suggestion</span>
            </button>
            <span class="apply-note">demo only — nothing is committed</span>
          </div>
        </div>
      </div>
    </div>

    <div class="d-row"><span class="d-sign" aria-hidden="true"></span><span class="d-num" aria-hidden="true">43</span><code class="d-code"> </code></div>
    <div class="d-row"><span class="d-sign" aria-hidden="true"></span><span class="d-num" aria-hidden="true">44</span><code class="d-code">export async function refreshSession(sid: string) {</code></div>
    <div class="d-row"><span class="d-sign" aria-hidden="true"></span><span class="d-num" aria-hidden="true">45</span><code class="d-code">  const row = await db.sessions.get(sid);</code></div>
    <div class="d-row"><span class="d-sign" aria-hidden="true"></span><span class="d-num" aria-hidden="true">46</span><code class="d-code">  if (!row) return null;</code></div>
    <div class="d-row"><span class="d-sign" aria-hidden="true"></span><span class="d-num" aria-hidden="true">47</span><code class="d-code">  return { ...row, expiresAt: row.created_at + TTL * 1000 };</code></div>
    <div class="d-row"><span class="d-sign" aria-hidden="true"></span><span class="d-num" aria-hidden="true">48</span><code class="d-code">}</code></div>
  </div>
</div>
<p class="sr-only" id="applyLive" aria-live="polite"></p>`;

export function landingPage(): string {
	return shell(
		'Home',
		`<section class="hero" aria-labelledby="hero-title">
  <div class="shell hero-grid">
    <div class="hero-copy">
      <p class="eyebrow">BYOK pull-request review</p>
      <h1 class="wordmark" id="hero-title">ALPHAPR</h1>
      <p class="tagline">A BYOK AI PR reviewer that comments on the exact lines it's talking about — and remembers what it already said.</p>
      <p class="hero-sub">Install the app, paste a provider key on <code>/setup</code>, pick a model. AlphaPR reads the diff, checks every line number before it comments, and stores the commit it reviewed so the next push only gets the new part.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="https://github.com/apps/alphapr-ai">Install the GitHub App
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </a>
        <a class="btn btn-ghost" href="/setup">See the setup page</a>
      </div>
      <ul class="proof"><li>line-anchored</li><li>incremental</li><li>your key, your model</li></ul>
    </div>
    <div class="hero-visual" id="sample">
      ${SCENE_PANEL}
    </div>
  </div>
</section>

<section class="section" aria-labelledby="sample-title">
  <div class="shell">
    <header class="sec-head">
      <p class="sec-index"><span>01</span> / sample review</p>
      <div>
        <h2 class="sec-title" id="sample-title">A finding that knows its line.</h2>
        <p class="lede">Every comment is anchored to the diff it is about. Suggestions arrive as GitHub suggestion blocks the author can commit in one click — no copying code out of a chat window.</p>
      </div>
    </header>
    ${SAMPLE_REVIEW}
  </div>
</section>

<section class="section" aria-labelledby="how-title">
  <div class="shell">
    <header class="sec-head">
      <p class="sec-index"><span>02</span> / how it works</p>
      <div>
        <h2 class="sec-title" id="how-title">Three moves, then it stays out of the way.</h2>
        <p class="lede">AlphaPR sits where the review already happens: the GitHub App, the pull request, the commit SHA. There is a dashboard for the one thing GitHub cannot show you — which repos are being reviewed, and what the last review cost.</p>
      </div>
    </header>
    <ol class="steps">
      <li class="step"><span class="step-num">01</span><h3>Connect</h3><p>Install the GitHub App, then paste your provider key on <code>/setup</code>. OpenRouter is verified in production; Anthropic and OpenAI are implemented and contract-tested, but not yet live-verified.</p><p class="step-note">github.com/apps/alphapr-ai</p></li>
      <li class="step"><span class="step-num">02</span><h3>Review</h3><p>AlphaPR reads the diff and validates every line number before it comments, so a finding can’t drift onto the wrong line. Findings land as inline threads with suggestion blocks.</p><p class="step-note">severity · tone · ignore paths</p></li>
      <li class="step"><span class="step-num">03</span><h3>Remember</h3><p>The last reviewed commit is stored per PR. A re-push reviews only new commits; an identical SHA is skipped as “Already reviewed”, and a draft waits until it is ready.</p><p class="step-note">drafts skipped · [skip alphapr] honoured</p></li>
    </ol>
  </div>
</section>

<section class="section band" aria-labelledby="setup-title">
  <div class="shell">
    <header class="sec-head">
      <p class="sec-index"><span>03</span> / setup</p>
      <div>
        <h2 class="sec-title" id="setup-title">Your key. Your model. One page.</h2>
        <p class="lede">The whole configuration surface: provider, key, model, severity, tone and ignored paths. The key is encrypted with AES-GCM at rest and never leaves your installation.</p>
      </div>
    </header>
    <div class="card">
      <dl class="meta-list">
        <dt>Provider</dt><dd>OpenRouter, Anthropic or OpenAI — your key, your model</dd>
        <dt>Model</dt><dd>Any model the chosen provider serves</dd>
        <dt>Severity</dt><dd>All findings, minor and above, or major only</dd>
        <dt>Tone</dt><dd>Thorough or concise — same findings, different prose</dd>
        <dt>Ignore paths</dt><dd>Comma-separated, with <code>dir/</code> prefixes and <code>*.ext</code> suffixes</dd>
      </dl>
      <div class="actions"><a class="btn btn-primary" href="/setup">Open /setup</a></div>
    </div>
  </div>
</section>

<section class="section" aria-labelledby="states-title">
  <div class="shell">
    <header class="sec-head">
      <p class="sec-index"><span>04</span> / states</p>
      <div>
        <h2 class="sec-title" id="states-title">The check tells the truth.</h2>
        <p class="lede">In progress, concluded, or failed — the check run and the PR comment say the same thing, including token usage and the provider’s actual error.</p>
      </div>
    </header>
    <div class="states-grid">
      <article class="state-card is-progress">
        <div class="state-top"><span class="state-label"><span class="dot" aria-hidden="true"></span>In progress</span><span class="state-id">check / queued</span></div>
        <h3 class="state-title">Reviewing…</h3>
        <p class="state-copy">Reading the diff and validating line anchors before the first comment lands. A comment appears immediately, then morphs into the verdict.</p>
        <p class="state-meta">AlphaPR / review · started just now</p>
      </article>
      <article class="state-card is-success">
        <div class="state-top"><span class="state-label"><svg class="state-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/></svg>Concluded</span><span class="state-id">check / success</span></div>
        <h3 class="state-title">Reviewed 3 files · 2 findings · 12,431 tokens</h3>
        <p class="state-copy">The check-run summary carries the token count for the review call. Findings stay resolvable threads on the diff.</p>
        <p class="state-meta">AlphaPR / review · 12,431 tokens reported</p>
      </article>
      <article class="state-card is-failure">
        <div class="state-top"><span class="state-label"><svg class="state-warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17.2v.3"/></svg>Failed</span><span class="state-id">attempt 1/3</span></div>
        <h3 class="state-title">Review failed</h3>
        <p class="state-copy"><strong>AlphaPR review failed.</strong> This won't be retried — check your installation's configuration. <span class="attempt">(attempt 1/3)</span></p>
        <blockquote class="failure-quote">openrouter auth error: 403 Key limit exceeded (total limit). $0.80 of $0.80 used; does not reset.</blockquote>
        <p class="state-meta">Quoted, not hidden</p>
      </article>
    </div>
  </div>
</section>`,
		{ scene: true },
	);
}
