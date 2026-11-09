// Dashboard (ADR 0002). P0 shipped the read-only view; P1 adds the write that
// matters: switching a single repo on or off, and overriding its config,
// without uninstalling the whole account.
//
// Authorization rule: reading needs any role, writing needs `admin` — the same
// rule `getAuthorizedInstallations` already applies at sign-in (own install or
// org admin). CSRF is a double-submit token bound to the session.

import { csrfToken, getSessionUser, sessionCookie, verifyCsrf } from './auth';
import { type DashboardInstallation, dashboardPage, repoSettingsPage, signInPage } from './dashboard-pages';
import { createAppJWT, getInstallationToken } from './github/auth';
import {
	clearRepoOverride,
	getRepoOverride,
	loadInstallationDefaults,
	loadRepoConfig,
	REVIEW_TONES,
	type RepoOverridePatch,
	SEVERITY_THRESHOLDS,
	saveRepoOverride,
} from './review-config';

const GITHUB_API = 'https://api.github.com';

/** decodeURIComponent throws on malformed input (`%zz`); a bad path is a 404, not a 500. */
function safeDecode(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

interface InstallationRow {
	installation_id: number;
	account_login: string;
	account_type: string;
	role: string;
	provider: string | null;
	model: string | null;
	api_key_encrypted: string | null;
	last_error_code: string | null;
	last_error_message: string | null;
	last_error_at: string | null;
	last_review_at: string | null;
}

interface AccessRow {
	role: string;
	account_login: string;
	account_type: string;
}

interface GitHubRepo {
	full_name: string;
	private: boolean;
	archived: boolean;
}

async function listRepos(token: string, installationId: number): Promise<GitHubRepo[]> {
	const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'alphapr' },
	});
	if (!res.ok) {
		throw new Error(`GitHub returned ${res.status} while listing repositories`);
	}
	const data = (await res.json()) as { repositories: GitHubRepo[] };
	return data.repositories ?? [];
}

async function loadInstallations(env: Env, userId: number): Promise<DashboardInstallation[]> {
	const rows = await env.DB.prepare(
		`SELECT ui.installation_id, ui.account_login, ui.account_type, ui.role,
            i.provider, i.model, i.api_key_encrypted,
            i.last_error_code, i.last_error_message, i.last_error_at, i.last_review_at
     FROM user_installations ui
     LEFT JOIN installations i ON i.installation_id = ui.installation_id
     WHERE ui.user_id = ?
     ORDER BY ui.account_login COLLATE NOCASE`,
	)
		.bind(userId)
		.all<InstallationRow>();

	const installations: DashboardInstallation[] = [];
	const appJwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY).catch((err) => {
		console.error(`Dashboard: could not mint an app JWT (${err instanceof Error ? err.message : err})`);
		return null;
	});

	for (const row of rows.results ?? []) {
		// `enabled` lives in our table, defaulted to on when no row exists yet.
		const overrides = await env.DB.prepare(`SELECT owner, name, enabled FROM repos WHERE installation_id = ?`)
			.bind(row.installation_id)
			.all<{ owner: string; name: string; enabled: number }>();
		const enabledByRepo = new Map((overrides.results ?? []).map((r) => [`${r.owner}/${r.name}`.toLowerCase(), r.enabled === 1]));

		let repos: GitHubRepo[] = [];
		let reposError: string | null = null;

		if (!appJwt) {
			reposError = 'Could not authenticate with GitHub — check the App private key.';
		} else {
			try {
				const token = await getInstallationToken(appJwt, row.installation_id);
				repos = await listRepos(token, row.installation_id);
			} catch (err) {
				reposError = err instanceof Error ? err.message : String(err);
			}
		}

		installations.push({
			id: row.installation_id,
			login: row.account_login,
			accountType: row.account_type,
			role: row.role === 'admin' ? 'admin' : 'member',
			provider: row.provider,
			model: row.model,
			hasKey: !!row.api_key_encrypted,
			lastError:
				row.last_error_code || row.last_error_message || row.last_error_at
					? { code: row.last_error_code, message: row.last_error_message, at: row.last_error_at }
					: null,
			lastReviewAt: row.last_review_at,
			repos: repos
				.map((repo) => ({
					fullName: repo.full_name,
					// Absent from the table means "inherit", and the installation is on.
					enabled: enabledByRepo.get(repo.full_name.toLowerCase()) ?? true,
					private: repo.private,
					archived: repo.archived,
				}))
				.sort((a, b) => a.fullName.localeCompare(b.fullName)),
			reposError,
		});
	}

	return installations;
}

function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
	});
}

function redirect(location: string): Response {
	return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'private, no-store' } });
}

function messagePage(heading: string, detail: string, status: number): Response {
	const safe = (value: string) => value.replace(/[<>&"]/g, '');
	return html(
		`<!doctype html><meta charset="utf-8"><title>${safe(heading)}</title>
<style>body{margin:0;padding:64px 24px;font:16px/1.6 ui-sans-serif,system-ui,sans-serif;color:#0a0a0a;background:#fff}
main{max-width:34rem;margin:0 auto}h1{font-size:1.4rem;letter-spacing:-0.02em;margin:0 0 10px}p{margin:0 0 20px;color:#3b3b3b}
a{color:#0f766e}</style>
<main><h1>${safe(heading)}</h1><p>${safe(detail)}</p><a href="/dashboard">Back to the dashboard</a></main>`,
		status,
	);
}

/** The caller's role on an installation, or null when they cannot see it at all. */
async function accessFor(env: Env, userId: number, installationId: number): Promise<AccessRow | null> {
	const row = await env.DB.prepare(
		`SELECT role, account_login, account_type FROM user_installations WHERE user_id = ? AND installation_id = ?`,
	)
		.bind(userId, installationId)
		.first<AccessRow>();
	if (!row) return null;
	return { role: row.role === 'admin' ? 'admin' : 'member', account_login: row.account_login, account_type: row.account_type };
}

/**
 * Does this repo really belong to this installation? Asked of GitHub, not of
 * our own tables — otherwise a crafted path could create a `repos` row for a
 * repository the installation cannot even see.
 */
async function findRepo(env: Env, installationId: number, owner: string, name: string): Promise<GitHubRepo | null> {
	const appJwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
	const token = await getInstallationToken(appJwt, installationId);
	const repos = await listRepos(token, installationId);
	const wanted = `${owner}/${name}`.toLowerCase();
	return repos.find((repo) => repo.full_name.toLowerCase() === wanted) ?? null;
}

function splitFullName(fullName: string): { owner: string; name: string } {
	const [owner, name] = fullName.split('/');
	return { owner, name };
}

/** GET/POST /dashboard/installations/:id/repos/:owner/:name */
async function handleRepoRoute(request: Request, env: Env, installationId: number, rawOwner: string, rawName: string): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) return html(signInPage(), request.method === 'POST' ? 401 : 200);

	const access = await accessFor(env, user.githubId, installationId);
	if (!access) {
		return messagePage('Not found', 'That installation is not one you can see.', 404);
	}

	const owner = safeDecode(rawOwner);
	const name = safeDecode(rawName);
	if (owner === null || name === null) {
		return messagePage('Not found', 'That repository path is not valid.', 404);
	}

	let repo: GitHubRepo | null;
	try {
		repo = await findRepo(env, installationId, owner, name);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Dashboard: could not verify ${owner}/${name} against GitHub: ${message}`);
		return messagePage(
			'GitHub did not answer',
			`AlphaPR could not confirm that repository belongs to this installation (${message}).`,
			502,
		);
	}
	if (!repo) {
		return messagePage('Not found', `${owner}/${name} is not a repository this installation can see.`, 404);
	}

	// GitHub's spelling, so the row cannot fork on casing.
	const canonical = splitFullName(repo.full_name);
	const settingsPath = `/dashboard/installations/${installationId}/repos/${encodeURIComponent(canonical.owner)}/${encodeURIComponent(canonical.name)}`;

	if (request.method === 'POST') {
		if (access.role !== 'admin') {
			return messagePage('Read-only', 'Your role on this installation is member, so you can look but not change anything.', 403);
		}

		const form = await request.formData();
		if (!(await verifyCsrf(request, user.sessionId, env.SETUP_SIGNING_SECRET, form))) {
			return messagePage('That form expired', 'Reload the page and try again — the anti-forgery token did not match.', 403);
		}

		const action = String(form.get('action') ?? 'save');
		if (action === 'reset') {
			await clearRepoOverride(env.DB, installationId, canonical.owner, canonical.name);
			return redirect(`${settingsPath}?saved=reset`);
		}

		const text = (key: string): string | null => {
			const value = form.get(key);
			const trimmed = typeof value === 'string' ? value.trim() : '';
			return trimmed === '' ? null : trimmed;
		};

		// A crafted form could carry anything; only the values the review path
		// understands may be stored, or the row would quietly mean nothing.
		const choice = <T extends string>(key: string, allowed: readonly T[], label: string): T | null | Response => {
			const raw = text(key);
			if (raw === null) return null;
			if ((allowed as readonly string[]).includes(raw)) return raw as T;
			return messagePage('Not saved', `${label} has to be one of ${allowed.join(', ')}.`, 400);
		};

		const severityThreshold = choice('severity_threshold', SEVERITY_THRESHOLDS, 'Severity threshold');
		if (severityThreshold instanceof Response) return severityThreshold;
		const reviewTone = choice('review_tone', REVIEW_TONES, 'Review tone');
		if (reviewTone instanceof Response) return reviewTone;

		const patch: RepoOverridePatch = {
			enabled: form.get('enabled') === 'on' || form.get('enabled') === '1',
			provider: text('provider'),
			model: text('model'),
			severityThreshold,
			reviewTone,
			ignorePaths: text('ignore_paths'),
		};

		await saveRepoOverride(env.DB, installationId, canonical.owner, canonical.name, patch);
		return redirect(`${settingsPath}?saved=1`);
	}

	const resolved = await loadRepoConfig(env.DB, installationId, canonical.owner, canonical.name);
	const defaults = await loadInstallationDefaults(env.DB, installationId);
	if (!resolved || !defaults) {
		return messagePage('Not configured yet', `Installation ${installationId} has no provider or key stored. Run /setup for it first.`, 404);
	}

	const csrf = await csrfToken(user.sessionId, env.SETUP_SIGNING_SECRET);
	const saved = new URL(request.url).searchParams.get('saved');

	const response = html(
		repoSettingsPage({
			user,
			csrf,
			installationId,
			accountLogin: access.account_login,
			accountType: access.account_type,
			repoFullName: repo.full_name,
			role: access.role === 'admin' ? 'admin' : 'member',
			saved: saved === '1' ? 'saved' : saved === 'reset' ? 'reset' : null,
			resolved,
			defaults,
			override: await getRepoOverride(env.DB, installationId, canonical.owner, canonical.name),
		}),
	);
	response.headers.append('Set-Cookie', sessionCookie(request, user.sessionId));
	return response;
}

const REPO_ROUTE = /^\/dashboard\/installations\/(\d+)\/repos\/([^/]+)\/([^/]+)$/;

/** Route handler for /dashboard*, or null for anything else. */
export async function handleDashboard(request: Request, env: Env): Promise<Response | null> {
	const { pathname } = new URL(request.url);

	const repoMatch = REPO_ROUTE.exec(pathname);
	if (repoMatch) {
		if (request.method !== 'GET' && request.method !== 'POST') {
			return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
		}
		return handleRepoRoute(request, env, Number(repoMatch[1]), repoMatch[2], repoMatch[3]);
	}

	if (pathname !== '/dashboard') {
		return pathname.startsWith('/dashboard/') ? new Response('not found', { status: 404 }) : null;
	}

	if (request.method !== 'GET') {
		return new Response('method not allowed', { status: 405, headers: { Allow: 'GET' } });
	}

	const user = await getSessionUser(request, env);
	if (!user) return html(signInPage());

	const csrf = await csrfToken(user.sessionId, env.SETUP_SIGNING_SECRET);

	let installations: DashboardInstallation[];
	try {
		installations = await loadInstallations(env, user.githubId);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Dashboard failed to load installations: ${message}`);
		return html(
			signInPage().replace(
				'<div class="card">',
				`<div class="dash-alert" role="alert"><h2>The dashboard could not load.</h2><p>${message.replace(/[<>&]/g, '')}</p></div><div class="card">`,
			),
			500,
		);
	}

	const response = html(dashboardPage({ user, csrf, installations }));
	response.headers.append('Set-Cookie', sessionCookie(request, user.sessionId));
	return response;
}
