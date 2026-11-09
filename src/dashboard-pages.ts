// Dashboard pages (ADR 0002, phase P0): sign-in, and a read-only view of what
// the signer's installations are doing. Server-rendered, same design system.

import { type SessionUser } from './auth';
import { formatUsd } from './pricing';
import { type InstallationDefaults, type RepoOverrideRow, type ResolvedRepoConfig } from './review-config';
import { esc, shell } from './setup-pages';

export interface DashboardRepo {
	fullName: string;
	enabled: boolean;
	private: boolean;
	archived: boolean;
}

export interface DashboardInstallation {
	id: number;
	login: string;
	accountType: string;
	role: 'admin' | 'member';
	provider: string | null;
	model: string | null;
	hasKey: boolean;
	keyHint: string | null;
	lastError: { code: string | null; message: string | null; at: string | null } | null;
	lastReviewAt: string | null;
	repos: DashboardRepo[];
	reposError: string | null;
}

export interface DashboardData {
	user: SessionUser;
	csrf: string;
	installations: DashboardInstallation[];
}

function installLink(): string {
	return '<a class="btn btn-primary" href="https://github.com/apps/alphapr-ai">Install AlphaPR</a>';
}

/** Unauthenticated /dashboard: explain the trade, then send them to GitHub. */
export function signInPage(): string {
	return shell(
		'Dashboard',
		`<div class="page"><div class="shell">
      <header class="page-head">
        <p class="kicker">/ dashboard</p>
        <h1>Sign in. See what your installations are doing.</h1>
        <p class="lede">Sign-in is GitHub OAuth and nothing else. The token is used once to read which installations you administer, then discarded — there is no AlphaPR password, and no GitHub token is stored.</p>
      </header>
      <div class="card">
        <p class="card-title">What you get</p>
        <p class="muted">Every installation you own or administer, the repositories each one can see, which are switched on, the provider and model in use, and the last failure if there was one.</p>
        <div class="actions">
          <a class="btn btn-primary" href="/auth/github">Sign in with GitHub
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </a>
          <a class="btn btn-ghost" href="/setup">Configure an installation</a>
        </div>
      </div>
    </div></div>`,
	);
}

function errorBanner(installations: DashboardInstallation[]): string {
	const failing = installations.filter((i) => i.lastError?.message || i.lastError?.code);
	if (failing.length === 0) return '';

	const items = failing
		.map(
			(i) =>
				`<li><strong>${esc(i.login)}</strong> — <code>${esc(i.lastError?.message ?? i.lastError?.code ?? '')}</code>${
					i.lastError?.at ? ` <span class="kicker">${esc(i.lastError.at)}</span>` : ''
				}</li>`,
		)
		.join('');

	return `<div class="dash-alert" role="status"><h2>${failing.length === 1 ? 'One installation is failing' : `${failing.length} installations are failing`}</h2>
    <p>The provider rejected or interrupted the last review. The same text is quoted in the failure comment on the pull request.</p>
    <ul>${items}</ul></div>`;
}

function repoRow(repo: DashboardRepo, installationId: number, role: 'admin' | 'member'): string {
	const [owner, name] = repo.fullName.split('/');
	const href = `/dashboard/installations/${installationId}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
	return `<li class="repo">
    <span class="repo-dot${repo.enabled ? '' : ' is-off'}" aria-hidden="true"></span>
    <a class="repo-name" href="${esc(href)}">${esc(repo.fullName)}</a>
    ${repo.private ? '<span class="repo-state">private</span>' : ''}
    ${repo.archived ? '<span class="repo-state">archived</span>' : ''}
    <span class="repo-state">${repo.enabled ? 'on' : 'off'}</span>
    <span class="repo-state">${role === 'admin' ? 'settings' : 'view'}</span>
  </li>`;
}

function installationCard(installation: DashboardInstallation, csrf: string): string {
	const repos =
		installation.repos.length > 0
			? `<ul class="repo-list">${installation.repos.map((repo) => repoRow(repo, installation.id, installation.role)).join('')}</ul>`
			: `<p class="inst-empty">${installation.reposError ? esc(installation.reposError) : 'No repositories are visible to this installation yet.'}</p>`;

	const role = installation.role === 'admin' ? 'admin' : 'member · read-only';
	const admin = installation.role === 'admin';
	const keyState = installation.hasKey ? `replace key ${installation.keyHint ?? '…'}` : 'paste the provider key';
	const keyTools = `<div class="inst-tools">
      <form method="POST" action="/dashboard/installations/${installation.id}/key">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label class="kicker" for="key-${installation.id}">Provider key</label>
        <input id="key-${installation.id}" name="api_key" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(keyState)}"${admin ? '' : ' disabled'}>
        <button class="btn btn-ghost" type="submit"${admin ? '' : ' disabled'}>Save key</button>
      </form>
      <form method="POST" action="/dashboard/installations/${installation.id}/test">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <button class="btn btn-ghost" type="submit"${admin && installation.hasKey ? '' : ' disabled'}>Test provider</button>
        <span class="field-help">One tiny call, so you find out here rather than in a pull request.</span>
      </form>
    </div>`;

	return `<article class="inst">
    <div class="inst-head">
      <h2 class="inst-name">${esc(installation.accountType === 'User' ? `@${installation.login}` : installation.login)}</h2>
      <span class="badge">${esc(role)}</span>
      <span class="badge">${esc(installation.accountType)}</span>
    </div>
    <div class="inst-meta">
      <span>installation <b>${installation.id}</b></span>
      <span>provider <b>${esc(installation.provider ?? 'not configured')}</b></span>
      <span>model <b>${esc(installation.model ?? '—')}</b></span>
      <span>key <b>${installation.hasKey ? 'stored, encrypted' : 'missing'}</b></span>
      <span>last review <b>${esc(installation.lastReviewAt ?? 'never')}</b></span>
      <span>repos <b>${installation.repos.length}</b></span>
    </div>
    ${keyTools}
    ${repos}
  </article>`;
}

function userStrip(user: SessionUser, csrf: string): string {
	return `<div class="user-strip">
        <span class="who">
          ${user.avatarUrl ? `<img class="avatar" src="${esc(user.avatarUrl)}" alt="" width="28" height="28">` : '<span class="avatar" aria-hidden="true"></span>'}
          <span class="kicker">signed in as @${esc(user.login)}</span>
        </span>
        <form method="POST" action="/auth/logout">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="btn btn-ghost" type="submit">Sign out</button>
        </form>
      </div>`;
}

export function dashboardPage(data: DashboardData): string {
	const { user, csrf, installations } = data;
	const repoCount = installations.reduce((total, i) => total + i.repos.length, 0);
	const enabledCount = installations.reduce((total, i) => total + i.repos.filter((r) => r.enabled).length, 0);

	const body =
		installations.length === 0
			? `<div class="card">
          <p class="card-title">No installations yet.</p>
          <p class="muted">Your GitHub account is signed in, but AlphaPR has not been installed on an account you can see. Install it first, then reload this page.</p>
          <div class="actions">${installLink()}<a class="btn btn-ghost" href="/dashboard">Reload</a></div>
        </div>`
			: installations.map((installation) => installationCard(installation, csrf)).join('');

	return shell(
		'Dashboard',
		`<div class="dash"><div class="shell">
      ${userStrip(user, csrf)}
      ${dashNav('overview')}
      <header class="page-head" style="margin-top: 20px;">
        <h1>Your installations.</h1>
        <p class="lede">${installations.length} installation${installations.length === 1 ? '' : 's'}, ${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'}, ${enabledCount} being reviewed. Open a repository to switch it off or override its provider, model, severity, tone or ignored paths. The installation-wide defaults still live on <a href="/setup">/setup</a>.</p>
      </header>
      ${errorBanner(installations)}
      ${body}
    </div></div>`,
		{ signedIn: true, login: user.login, csrf },
	);
}

export interface RepoSettingsData {
	user: SessionUser;
	csrf: string;
	installationId: number;
	accountLogin: string;
	accountType: string;
	repoFullName: string;
	role: 'admin' | 'member';
	saved: 'saved' | 'reset' | null;
	resolved: ResolvedRepoConfig;
	defaults: InstallationDefaults;
	override: RepoOverrideRow | null;
}

function selectField(
	id: string,
	label: string,
	options: readonly string[],
	selected: string | null,
	inherited: string,
	disabled: boolean,
): string {
	const inherit = `<option value=""${selected ? '' : ' selected'}>Inherit (${esc(inherited)})</option>`;
	const rest = options
		.map((option) => `<option value="${esc(option)}"${selected === option ? ' selected' : ''}>${esc(option)}</option>`)
		.join('');
	return `<div class="field">
      <label for="${id}">${esc(label)}${selected ? '<span class="badge">overridden</span>' : ''}</label>
      <select id="${id}" name="${id}"${disabled ? ' disabled' : ''}>${inherit}${rest}</select>
      <p class="field-help">Installation default: <code>${esc(inherited)}</code></p>
    </div>`;
}

/**
 * One repository's settings. Every field is an override: empty means "whatever
 * the installation says", which is what the placeholder and the help line show.
 */
export function repoSettingsPage(data: RepoSettingsData): string {
	const { user, csrf, installationId, accountLogin, accountType, repoFullName, role, saved, resolved, defaults, override } = data;
	const disabled = role !== 'admin';
	const [owner, name] = repoFullName.split('/');
	const inheritNote = (key: string) =>
		resolved.inherits[key as keyof typeof resolved.inherits] ? '' : '<span class="badge">overridden</span>';

	const banner =
		saved === null
			? ''
			: `<div class="dash-alert is-ok" role="status"><h2>${saved === 'reset' ? 'Back to inheriting.' : 'Saved.'}</h2>
    <p>${saved === 'reset' ? 'The override row is gone, so this repository follows the installation again.' : 'The next review of this repository uses these settings — no redeploy, no uninstall.'}</p></div>`;

	const content = `<div class="setup-card">
      <div class="setup-head"><span class="path">${esc(owner)} <span>/ ${esc(name)}</span></span><span>repo override</span></div>
      <form method="POST" action="/dashboard/installations/${installationId}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <div class="field-grid">
          <div class="field field-wide field-check">
            <input type="checkbox" id="enabled" name="enabled" value="1"${resolved.enabled ? ' checked' : ''}${disabled ? ' disabled' : ''}>
            <label for="enabled">Review this repository</label>
            <p class="field-help">Uncheck and reviews stop here — silently, with no comment and no check run. Other repositories keep going.</p>
          </div>
          <div class="field">
            <label for="provider">Provider ${inheritNote('provider')}</label>
            <input id="provider" name="provider" value="${esc(override?.provider ?? '')}" placeholder="${esc(defaults.provider)}"${disabled ? ' disabled' : ''}>
            <p class="field-help">Installation default: <code>${esc(defaults.provider)}</code></p>
          </div>
          <div class="field">
            <label for="model">Model ${inheritNote('model')}</label>
            <input id="model" name="model" value="${esc(override?.model ?? '')}" placeholder="${esc(defaults.model)}"${disabled ? ' disabled' : ''}>
            <p class="field-help">Installation default: <code>${esc(defaults.model)}</code></p>
          </div>
          ${selectField('severity_threshold', 'Severity threshold', ['all', 'minor', 'major'], override?.severity_threshold ?? null, defaults.severity_threshold, disabled)}
          ${selectField('review_tone', 'Review tone', ['thorough', 'concise'], override?.review_tone ?? null, defaults.review_tone, disabled)}
          <div class="field field-wide">
            <label for="ignore_paths">Ignore paths ${inheritNote('ignorePaths')}</label>
            <textarea id="ignore_paths" name="ignore_paths" rows="3" placeholder="${esc(defaults.ignore_paths)}"${disabled ? ' disabled' : ''}>${esc(override?.ignore_paths ?? '')}</textarea>
            <p class="field-help">Comma-separated globs. Installation default: <code>${esc(defaults.ignore_paths || 'none')}</code></p>
          </div>
        </div>
        <div class="setup-foot">
          <span class="form-status">${disabled ? 'Read-only — your role on this installation is member.' : `Editing @${esc(accountLogin)} (${esc(accountType)})`}</span>
          <div style="display: flex; flex-direction: row-reverse; justify-content: flex-end; gap: 10px;">
            <button class="btn btn-primary" type="submit"${disabled ? ' disabled' : ''}>Save</button>
            <button class="btn btn-ghost" type="submit" name="action" value="reset"${disabled ? ' disabled' : ''}>Reset to inherit</button>
          </div>
        </div>
      </form>
    </div>`;

	return shell(
		repoFullName,
		`<div class="dash"><div class="shell">
      ${userStrip(user, csrf)}
      <header class="page-head" style="margin-top: 28px;">
        <p class="kicker"><a href="/dashboard">/ dashboard</a> / installation ${installationId}</p>
        <h1>${esc(repoFullName)}</h1>
        <p class="lede">Overrides for this repository only. Blank fields keep inheriting from the installation, so changing a default on /setup still moves every repo that inherits it.</p>
      </header>
      ${banner}
      ${content}
    </div></div>`,
		{ signedIn: true, login: user.login, csrf },
	);
}

// ─── P2: review history and what it cost ───
//
// Two pages, one source of truth each: `reviewsPage` answers "what happened",
// `usagePage` answers "what did it add up to". Both are read-only and both are
// scoped by the same installation list the overview already uses.

function dashNav(active: 'overview' | 'reviews' | 'usage'): string {
	const link = (href: string, label: string, key: typeof active) =>
		`<a class="nav-link${active === key ? ' is-active' : ''}" href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
	return `<nav class="dash-nav" aria-label="Dashboard">
      ${link('/dashboard', 'Overview', 'overview')}
      ${link('/dashboard/reviews', 'Reviews', 'reviews')}
      ${link('/dashboard/usage', 'Usage', 'usage')}
    </nav>`;
}

export interface ReviewRowView {
	repoFullName: string;
	prNumber: number;
	headSha: string;
	model: string | null;
	provider: string | null;
	createdAt: string;
	inputTokens: number | null;
	outputTokens: number | null;
}

export interface ReviewsData {
	user: SessionUser;
	csrf: string;
	rows: ReviewRowView[];
	/** Every recorded review, so the page can be honest about truncation. */
	total: number;
	installations: number;
}

/** `2026-11-09 16:04:11` → `2026-11-09 16:04`. SQLite gives UTC; say so. */
function shortTime(value: string): string {
	return value.length >= 16 ? `${value.slice(0, 16)} UTC` : value;
}

export function reviewsPage(data: ReviewsData): string {
	const { user, csrf, rows } = data;
	const scope =
		data.total > rows.length
			? `Showing the ${rows.length} most recent of ${data.total} recorded reviews.`
			: `${data.total} recorded review${data.total === 1 ? '' : 's'}.`;

	const table =
		rows.length === 0
			? `<div class="card">
          <p class="card-title">No reviews recorded yet.</p>
          <p class="muted">History starts with the first review after v1.11.0 was deployed. Reviews AlphaPR posted before that are still remembered per pull request, but they were not recorded here.</p>
        </div>`
			: `<div class="dash-table-wrap">
        <table class="dash-table">
          <caption class="sr-only">Recent AlphaPR reviews, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Pull request</th>
              <th scope="col">Commit</th>
              <th scope="col">Model</th>
              <th scope="col" class="num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            ${rows
							.map((row) => {
								const tokens =
									row.inputTokens == null && row.outputTokens == null
										? '—'
										: `${(row.inputTokens ?? 0).toLocaleString('en-US')} in / ${(row.outputTokens ?? 0).toLocaleString('en-US')} out`;
								return `<tr>
                <td class="mono">${esc(shortTime(row.createdAt))}</td>
                <td><a href="https://github.com/${esc(row.repoFullName)}/pull/${row.prNumber}">${esc(row.repoFullName)} #${row.prNumber}</a></td>
                <td class="mono">${esc(row.headSha.slice(0, 7))}</td>
                <td class="mono">${esc(row.model ?? 'unknown')}${row.provider ? `<span class="muted"> · ${esc(row.provider)}</span>` : ''}</td>
                <td class="num mono">${esc(tokens)}</td>
              </tr>`;
							})
							.join('')}
          </tbody>
        </table>
      </div>`;

	return shell(
		'Review history',
		`<div class="dash"><div class="shell">
      ${userStrip(user, csrf)}
      ${dashNav('reviews')}
      <header class="page-head">
        <h1>What was reviewed.</h1>
        <p class="lede">One row per review AlphaPR posted, newest first, across the ${data.installations} installation${data.installations === 1 ? '' : 's'} you administer. A pull request you push to twice appears twice — the second row is the incremental review. ${scope}</p>
      </header>
      ${table}
    </div></div>`,
		{ signedIn: true, login: user.login, csrf },
	);
}

export interface UsageModelRow {
	model: string | null;
	provider: string | null;
	reviews: number;
	inputTokens: number;
	outputTokens: number;
	cost: number | null;
}

export interface UsageData {
	user: SessionUser;
	csrf: string;
	totals: { reviews: number; inputTokens: number; outputTokens: number };
	cost: number | null;
	byModel: UsageModelRow[];
	pricingAsOf: string;
	installations: number;
}

export function usagePage(data: UsageData): string {
	const { user, csrf, totals, byModel } = data;
	const fmt = (n: number) => n.toLocaleString('en-US');

	const headline = `<div class="stat-grid">
      <div class="stat">
        <p class="kicker">reviews</p>
        <p class="stat-value">${fmt(totals.reviews)}</p>
      </div>
      <div class="stat">
        <p class="kicker">input tokens</p>
        <p class="stat-value">${fmt(totals.inputTokens)}</p>
      </div>
      <div class="stat">
        <p class="kicker">output tokens</p>
        <p class="stat-value">${fmt(totals.outputTokens)}</p>
      </div>
      <div class="stat">
        <p class="kicker">estimated cost</p>
        <p class="stat-value">${data.cost == null ? '—' : formatUsd(data.cost)}</p>
      </div>
    </div>`;

	const models =
		byModel.length === 0
			? `<div class="card"><p class="muted">No usage recorded yet.</p></div>`
			: `<div class="dash-table-wrap">
        <table class="dash-table">
          <caption class="sr-only">Usage per model</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" class="num">Reviews</th>
              <th scope="col" class="num">Input</th>
              <th scope="col" class="num">Output</th>
              <th scope="col" class="num">Estimate</th>
            </tr>
          </thead>
          <tbody>
            ${byModel
							.map(
								(row) => `<tr>
              <td class="mono">${esc(row.model ?? 'unknown')}${row.provider ? `<span class="muted"> · ${esc(row.provider)}</span>` : ''}</td>
              <td class="num mono">${fmt(row.reviews)}</td>
              <td class="num mono">${fmt(row.inputTokens)}</td>
              <td class="num mono">${fmt(row.outputTokens)}</td>
              <td class="num mono">${row.cost == null ? '<span class="muted">not priced</span>' : formatUsd(row.cost)}</td>
            </tr>`,
							)
							.join('')}
          </tbody>
        </table>
      </div>`;

	const unpriced = byModel.some((row) => row.cost == null);

	return shell(
		'Usage',
		`<div class="dash"><div class="shell">
      ${userStrip(user, csrf)}
      ${dashNav('usage')}
      <header class="page-head">
        <h1>What it cost.</h1>
        <p class="lede">Every review AlphaPR has posted from the ${data.installations} installation${data.installations === 1 ? '' : 's'} you administer, with the tokens its provider reported. You pay the provider directly — nothing here is billed by AlphaPR.</p>
      </header>
      ${headline}
      ${models}
      <p class="fineprint">Estimates use list prices per million tokens recorded ${esc(data.pricingAsOf)}; providers change prices, so treat these as a yardstick, not an invoice. ${unpriced ? 'Models missing from the price table show tokens only — AlphaPR does not guess a price it does not know.' : ''} The review itself is counted; the optional PR summary call is not, which makes this a floor rather than a ceiling.</p>
    </div></div>`,
		{ signedIn: true, login: user.login, csrf },
	);
}
