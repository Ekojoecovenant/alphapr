import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../src/auth';
import { handleDashboard } from '../src/dashboard';

vi.mock('../src/github/auth', () => ({
	createAppJWT: vi.fn(async () => 'app.jwt'),
	getInstallationToken: vi.fn(async (_jwt: string, id: number) => `inst-token-${id}`),
}));

import { createAppJWT, getInstallationToken } from '../src/github/auth';
import { makeFakeDb } from './helpers/fake-d1';

const ORIGIN = 'https://alphapr.test';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

function makeEnv(db: D1Database): Env {
	return { DB: db, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pem', SETUP_SIGNING_SECRET: 'secret' } as unknown as Env;
}

function signedInDb(
	installations: Array<Record<string, unknown>>,
	repos: Record<number, Array<{ owner: string; name: string; enabled: number }>> = {},
) {
	return makeFakeDb({
		sessions: [{ session_id: 'sid', last_used_at: null, expires_at: FUTURE, github_id: 4242, login: 'ekojoecovenant', avatar_url: null }],
		installations,
		repos,
	});
}

function dashboardRequest(path = '/dashboard', init: RequestInit = {}): Request {
	return new Request(`${ORIGIN}${path}`, {
		...init,
		headers: { Cookie: `${SESSION_COOKIE}=sid`, ...(init.headers ?? {}) },
	});
}

function installation(overrides: Record<string, unknown> = {}) {
	return {
		installation_id: 1,
		account_login: 'ekojoecovenant',
		account_type: 'User',
		role: 'admin',
		provider: 'openrouter',
		model: 'deepseek/deepseek-v4-flash-0731',
		api_key_encrypted: 'iv.ciphertext',
		last_error_code: null,
		last_error_message: null,
		last_error_at: null,
		last_review_at: '2026-11-04 19:52',
		...overrides,
	};
}

function mockRepoList(repos: Record<number, Array<{ full_name: string; private: boolean; archived: boolean }>>, calls: string[] = []) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			const m = url.match(/^https:\/\/api\.github\.com\/installation\/repositories/);
			if (m) {
				// The installation is encoded in the token the module mock hands back.
				const token = '';
				void token;
				const all = Object.values(repos).flat();
				return new Response(JSON.stringify({ total_count: all.length, repositories: all }), { status: 200 });
			}
			return new Response('not found', { status: 404 });
		}),
	);
}

beforeEach(() => {
	vi.mocked(createAppJWT).mockResolvedValue('app.jwt');
	vi.mocked(getInstallationToken).mockImplementation(async (_jwt: string, id: number) => `inst-token-${id}`);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('GET /dashboard when signed out', () => {
	it('offers sign-in instead of redirecting', async () => {
		const { db } = makeFakeDb();
		const res = await handleDashboard(new Request(`${ORIGIN}/dashboard`), makeEnv(db));

		expect(res?.status).toBe(200);
		const html = await res?.text();
		expect(html).toContain('Sign in with GitHub');
		expect(html).toContain('href="/auth/github"');
		// No user data leaks into the signed-out page.
		expect(html).not.toContain('ekojoecovenant');
	});
});

describe('GET /dashboard when signed in', () => {
	it('lists installations, their repos, and the settings in force', async () => {
		const { db } = signedInDb([installation()]);
		mockRepoList({ 1: [{ full_name: 'ekojoecovenant/alphapr', private: false, archived: false }] });

		const res = await handleDashboard(dashboardRequest(), makeEnv(db));
		const html = await res?.text();

		expect(res?.status).toBe(200);
		expect(html).toContain('signed in as @ekojoecovenant');
		expect(html).toContain('ekojoecovenant/alphapr');
		expect(html).toContain('deepseek/deepseek-v4-flash-0731');
		expect(html).toContain('stored, encrypted');
		expect(html).toContain('admin');
		expect(html).toContain('2026-11-04 19:52');
	});

	it('never renders an installation the user only has member access to', async () => {
		const { db } = signedInDb([installation({ account_login: 'ForXed', account_type: 'Organization', role: 'member' })]);
		const fetched: string[] = [];
		mockRepoList({ 1: [{ full_name: 'ForXed/api', private: true, archived: false }] }, fetched);

		const html = await (await handleDashboard(dashboardRequest(), makeEnv(db)))?.text();
		// The account, its repos and even its existence must not reach the page:
		// listing it would expose every repository the installation can see.
		expect(html).not.toContain('ForXed');
		expect(html).not.toContain('ForXed/api');
		expect(fetched).toHaveLength(0);
	});

	it('surfaces the last provider failure in a banner', async () => {
		const { db } = signedInDb([
			installation({
				last_error_code: '403',
				last_error_message: 'Key limit exceeded (total limit). $0.80 of $0.80 used; does not reset.',
				last_error_at: '2026-11-08 15:02',
			}),
		]);
		mockRepoList({ 1: [{ full_name: 'ekojoecovenant/alphapr', private: false, archived: false }] });

		const html = await (await handleDashboard(dashboardRequest(), makeEnv(db)))?.text();
		expect(html).toContain('One installation is failing');
		expect(html).toContain('Key limit exceeded');
	});

	it('shows a repo switched off in the overrides table as off', async () => {
		const { db } = signedInDb([installation()], { 1: [{ owner: 'ekojoecovenant', name: 'noisy', enabled: 0 }] });
		mockRepoList({
			1: [
				{ full_name: 'ekojoecovenant/alphapr', private: false, archived: false },
				{ full_name: 'ekojoecovenant/noisy', private: false, archived: false },
			],
		});

		const html = await (await handleDashboard(dashboardRequest(), makeEnv(db)))?.text();
		expect(html).toContain('is-off');
		expect(html).toContain('>off<');
		expect(html).toContain('2 repositor');
	});

	it('reports a GitHub failure per installation instead of failing the page', async () => {
		const { db } = signedInDb([installation()]);
		vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error('Installation auth failed (revoked or removed?): 404'));

		const res = await handleDashboard(dashboardRequest(), makeEnv(db));
		const html = await res?.text();

		expect(res?.status).toBe(200);
		expect(html).toContain('revoked or removed');
		expect(html).toContain('ekojoecovenant');
	});

	it('explains an empty dashboard when the user has no installations', async () => {
		const { db } = signedInDb([]);
		const html = await (await handleDashboard(dashboardRequest(), makeEnv(db)))?.text();

		expect(html).toContain('No installations yet.');
		expect(html).toContain('https://github.com/apps/alphapr-ai');
	});
});

describe('routing', () => {
	it('answers POST with 405 and an Allow header', async () => {
		const { db } = makeFakeDb();
		const res = await handleDashboard(dashboardRequest('/dashboard', { method: 'POST' }), makeEnv(db));
		expect(res?.status).toBe(405);
		expect(res?.headers.get('Allow')).toBe('GET');
	});

	it('404s an unknown dashboard sub-route', async () => {
		const { db } = makeFakeDb();
		const res = await handleDashboard(dashboardRequest('/dashboard/reviews'), makeEnv(db));
		expect(res?.status).toBe(404);
	});

	it('returns null for paths it does not own', async () => {
		const { db } = makeFakeDb();
		expect(await handleDashboard(new Request(`${ORIGIN}/setup`), makeEnv(db))).toBeNull();
		expect(await handleDashboard(new Request(`${ORIGIN}/dashboards`), makeEnv(db))).toBeNull();
	});
});
