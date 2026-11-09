import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfToken, SESSION_COOKIE } from '../src/auth';
import { handleDashboard } from '../src/dashboard';
import { invitedInstallations } from '../src/db';

vi.mock('../src/github/auth', () => ({
	createAppJWT: vi.fn(async () => 'app.jwt'),
	getInstallationToken: vi.fn(async (_jwt: string, id: number) => `inst-token-${id}`),
}));

import { createAppJWT, getInstallationToken } from '../src/github/auth';
import { makeFakeDb } from './helpers/fake-d1';

const ORIGIN = 'https://alphapr.test';
const SECRET = 'secret';
const PATH = '/dashboard/installations/12/members';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

function makeEnv(db: D1Database): Env {
	return { DB: db, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pem', SETUP_SIGNING_SECRET: SECRET } as unknown as Env;
}

const INSTALLATION = {
	provider: 'openrouter',
	model: 'deepseek/deepseek-v4-flash-0731',
	severity_threshold: 'all',
	review_tone: 'thorough',
	ignore_paths: 'dist/**',
	account_login: 'acme',
	api_key_encrypted: 'iv.ciphertext',
};

function makeDb(
	options: {
		role?: 'admin' | 'member';
		members?: Record<number, Array<{ github_login: string; added_by: string; created_at: string }>>;
	} = {},
) {
	return makeFakeDb({
		sessions: [{ session_id: 'sid', last_used_at: null, expires_at: FUTURE, github_id: 4242, login: 'ekojoecovenant', avatar_url: null }],
		access: { '4242:12': { role: options.role ?? 'admin', account_login: 'acme', account_type: 'Organization' } },
		installationConfig: INSTALLATION,
		members: options.members ?? {},
		installations: [
			{
				installation_id: 12,
				account_login: 'acme',
				account_type: 'Organization',
				role: options.role ?? 'admin',
				provider: INSTALLATION.provider,
				model: INSTALLATION.model,
				api_key_encrypted: INSTALLATION.api_key_encrypted,
				key_hint: null,
				last_error_code: null,
				last_error_message: null,
				last_error_at: null,
				last_review_at: null,
			},
		],
	});
}

function request(path = PATH, init: RequestInit = {}): Request {
	return new Request(`${ORIGIN}${path}`, {
		...init,
		headers: { Cookie: `${SESSION_COOKIE}=sid`, ...(init.headers ?? {}) },
	});
}

async function post(fields: Record<string, string>, path = PATH) {
	return request(path, {
		method: 'POST',
		body: new URLSearchParams(fields),
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	});
}

beforeEach(() => {
	vi.mocked(createAppJWT).mockResolvedValue('app.jwt');
	vi.mocked(getInstallationToken).mockImplementation(async (_jwt: string, id: number) => `inst-token-${id}`);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith('https://api.github.com/installation/repositories')) {
				return new Response(
					JSON.stringify({ total_count: 1, repositories: [{ full_name: 'acme/api', private: false, archived: false }] }),
					{ status: 200 },
				);
			}
			return new Response('not found', { status: 404 });
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('teammate invites', () => {
	it('stores an invited login and says so on the dashboard', async () => {
		const fake = makeDb();
		const res = await handleDashboard(
			await post({ action: 'add', login: 'octocat', csrf: await csrfToken('sid', SECRET) }),
			makeEnv(fake.db),
		);
		expect(res?.status).toBe(303);
		expect(res?.headers.get('Location')).toBe('/dashboard?saved=member-added');
		const insert = fake.writesStartingWith('INSERT OR IGNORE INTO members');
		expect(insert).toHaveLength(1);
		expect(insert[0]?.args).toEqual([12, 'octocat', 'ekojoecovenant']);
	});

	it('accepts a login with a leading @ and without the at-sign', async () => {
		const fake = makeDb();
		await handleDashboard(await post({ action: 'add', login: '@Octo-Cat', csrf: await csrfToken('sid', SECRET) }), makeEnv(fake.db));
		expect(fake.writesStartingWith('INSERT OR IGNORE INTO members')[0]?.args[1]).toBe('Octo-Cat');
	});

	it('reports an invite that already existed instead of doubling it', async () => {
		const fake = makeDb();
		// changes: 0 is what INSERT OR IGNORE reports for a duplicate.
		const duplicate = makeFakeDb({
			sessions: [{ session_id: 'sid', last_used_at: null, expires_at: FUTURE, github_id: 4242, login: 'ekojoecovenant', avatar_url: null }],
			access: { '4242:12': { role: 'admin', account_login: 'acme', account_type: 'Organization' } },
			installationConfig: INSTALLATION,
			changes: 0,
		});
		void fake;
		const res = await handleDashboard(
			await post({ action: 'add', login: 'octocat', csrf: await csrfToken('sid', SECRET) }),
			makeEnv(duplicate.db),
		);
		expect(res?.headers.get('Location')).toBe('/dashboard?saved=member-exists');
	});

	it('removes by login, case-insensitively', async () => {
		const fake = makeDb();
		const res = await handleDashboard(
			await post({ action: 'remove', login: 'OctoCat', csrf: await csrfToken('sid', SECRET) }),
			makeEnv(fake.db),
		);
		expect(res?.headers.get('Location')).toBe('/dashboard?saved=member-removed');
		expect(fake.writesStartingWith('DELETE FROM members')[0]?.args).toEqual([12, 'OctoCat']);
	});

	it('refuses a login that is not a GitHub login', async () => {
		const fake = makeDb();
		for (const login of ['', 'has space', 'double--hyphen', 'trailing-', 'a'.repeat(40), '<script>']) {
			const res = await handleDashboard(await post({ action: 'add', login, csrf: await csrfToken('sid', SECRET) }), makeEnv(fake.db));
			expect(res?.status).toBe(400);
			expect(await res?.text()).toContain('not a GitHub login');
		}
		expect(fake.writesStartingWith('INSERT OR IGNORE INTO members')).toHaveLength(0);
	});

	it('refuses an unknown action', async () => {
		const fake = makeDb();
		const res = await handleDashboard(
			await post({ action: 'promote', login: 'octocat', csrf: await csrfToken('sid', SECRET) }),
			makeEnv(fake.db),
		);
		expect(res?.status).toBe(400);
	});

	it('refuses a write without the CSRF token, and with a foreign one', async () => {
		const fake = makeDb();
		expect((await handleDashboard(await post({ action: 'add', login: 'octocat' }), makeEnv(fake.db)))?.status).toBe(403);
		const forged = await handleDashboard(await post({ action: 'add', login: 'octocat', csrf: 'nonsense' }), makeEnv(fake.db));
		expect(forged?.status).toBe(403);
		expect(fake.writesStartingWith('INSERT OR IGNORE INTO members')).toHaveLength(0);
	});

	it('lets a member see the team but not change it', async () => {
		const fake = makeDb({
			role: 'member',
			members: { 12: [{ github_login: 'octocat', added_by: 'ekojoecovenant', created_at: '2026-11-09 10:00:00' }] },
		});
		const page = await (await handleDashboard(request('/dashboard'), makeEnv(fake.db)))?.text();
		expect(page).toContain('@octocat');
		const res = await handleDashboard(
			await post({ action: 'add', login: 'mallory', csrf: await csrfToken('sid', SECRET) }),
			makeEnv(fake.db),
		);
		expect(res?.status).toBe(403);
		expect(await res?.text()).toContain('Your role on this installation is member');
	});

	it('answers 404 for an installation the caller cannot see', async () => {
		const fake = makeDb();
		const res = await handleDashboard(
			await post({ action: 'add', login: 'octocat', csrf: await csrfToken('sid', SECRET) }, '/dashboard/installations/99/members'),
			makeEnv(fake.db),
		);
		expect(res?.status).toBe(404);
	});

	it('is POST only', async () => {
		const fake = makeDb();
		const res = await handleDashboard(request(), makeEnv(fake.db));
		expect(res?.status).toBe(405);
		expect(res?.headers.get('Allow')).toBe('POST');
	});

	it('shows the saved message after a redirect', async () => {
		const fake = makeDb({ members: { 12: [{ github_login: 'octocat', added_by: 'ekojoecovenant', created_at: '2026-11-09 10:00:00' }] } });
		const page = await (await handleDashboard(request('/dashboard?saved=member-added'), makeEnv(fake.db)))?.text();
		expect(page).toContain('Teammate added.');
		expect(page).toContain('read-only');
		expect(page).toContain('Add teammate');
	});
});

describe('invitedInstallations', () => {
	it('matches a login case-insensitively across installations', async () => {
		const fake = makeDb({
			members: {
				12: [{ github_login: 'OctoCat', added_by: 'ekojoecovenant', created_at: '2026-11-09 10:00:00' }],
				15: [{ github_login: 'someone-else', added_by: 'ekojoecovenant', created_at: '2026-11-09 10:00:00' }],
			},
		});
		expect(await invitedInstallations(fake.db, 'octocat')).toEqual([12]);
		expect(await invitedInstallations(fake.db, 'nobody')).toEqual([]);
	});
});
