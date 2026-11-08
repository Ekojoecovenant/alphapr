// GET /dashboard (ADR 0002, P0). Read-only: installations, their repositories,
// and the last failure of each. No writes, no settings, no key material.

import { csrfToken, getSessionUser } from './auth';
import { type DashboardInstallation, dashboardPage, signInPage } from './dashboard-pages';
import { createAppJWT, getInstallationToken } from './github/auth';

const GITHUB_API = 'https://api.github.com';

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

/** Route handler for /dashboard*, or null for anything else. */
export async function handleDashboard(request: Request, env: Env): Promise<Response | null> {
	const { pathname } = new URL(request.url);
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

	return html(dashboardPage({ user, csrf, installations }));
}
