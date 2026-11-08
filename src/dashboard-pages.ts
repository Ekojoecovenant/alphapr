// Dashboard pages (ADR 0002, phase P0): sign-in, and a read-only view of what
// the signer's installations are doing. Server-rendered, same design system.

import { type SessionUser } from './auth';
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

function repoRow(repo: DashboardRepo): string {
	return `<li class="repo">
    <span class="repo-dot${repo.enabled ? '' : ' is-off'}" aria-hidden="true"></span>
    <span class="repo-name">${esc(repo.fullName)}</span>
    ${repo.private ? '<span class="repo-state">private</span>' : ''}
    ${repo.archived ? '<span class="repo-state">archived</span>' : ''}
    <span class="repo-state">${repo.enabled ? 'on' : 'off'}</span>
  </li>`;
}

function installationCard(installation: DashboardInstallation): string {
	const repos =
		installation.repos.length > 0
			? `<ul class="repo-list">${installation.repos.map(repoRow).join('')}</ul>`
			: `<p class="inst-empty">${installation.reposError ? esc(installation.reposError) : 'No repositories are visible to this installation yet.'}</p>`;

	const role = installation.role === 'admin' ? 'admin' : 'member · read-only';

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
    ${repos}
  </article>`;
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
			: installations.map(installationCard).join('');

	return shell(
		'Dashboard',
		`<div class="dash"><div class="shell">
      <div class="user-strip">
        <span class="who">
          ${user.avatarUrl ? `<img class="avatar" src="${esc(user.avatarUrl)}" alt="" width="28" height="28">` : '<span class="avatar" aria-hidden="true"></span>'}
          <span class="kicker">signed in as @${esc(user.login)}</span>
        </span>
        <form method="POST" action="/auth/logout">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="btn btn-ghost" type="submit">Sign out</button>
        </form>
      </div>
      <header class="page-head" style="margin-top: 28px;">
        <h1>Your installations.</h1>
        <p class="lede">${installations.length} installation${installations.length === 1 ? '' : 's'}, ${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'}, ${enabledCount} being reviewed. This view is read-only for now — changing the provider, the model or the key still happens on <a href="/setup">/setup</a>.</p>
      </header>
      ${errorBanner(installations)}
      ${body}
    </div></div>`,
		{ signedIn: true, login: user.login },
	);
}
