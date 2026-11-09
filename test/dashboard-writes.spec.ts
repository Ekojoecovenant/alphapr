import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfToken, SESSION_COOKIE } from '../src/auth';
import { handleDashboard } from '../src/dashboard';

vi.mock('../src/github/auth', () => ({
	createAppJWT: vi.fn(async () => 'app.jwt'),
	getInstallationToken: vi.fn(async (_jwt: string, id: number) => `inst-token-${id}`),
}));

import { createAppJWT, getInstallationToken } from '../src/github/auth';
import { makeFakeDb } from './helpers/fake-d1';

const ORIGIN = 'https://alphapr.test';
const SECRET = 'secret';
const PATH = '/dashboard/installations/12/repos/acme/api';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

function makeEnv(db: D1Database): Env {
	return { DB: db, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pem', SETUP_SIGNING_SECRET: SECRET } as unknown as Env;
}

const INSTALLATION = {
	provider: 'openrouter',
	model: 'deepseek/deepseek-v4-flash-0731',
	severity_threshold: 'all',
	review_tone: 'thorough',
	ignore_paths: 'dist/**, docs/**',
	account_login: 'acme',
	api_key_encrypted: 'iv.ciphertext',
};

function makeDb(role: 'admin' | 'member', overrides: Record<string, unknown> | null = null) {
	return makeFakeDb({
		sessions: [{ session_id: 'sid', last_used_at: null, expires_at: FUTURE, github_id: 4242, login: 'ekojoecovenant', avatar_url: null }],
		access: { '4242:12': { role, account_login: 'acme', account_type: 'Organization' } },
		installationConfig: INSTALLATION,
		repoOverrides: overrides ? { '12:acme/api': overrides } : {},
	});
}

function mockRepoList(fullNames: string[] = ['acme/api', 'acme/web']) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith('https://api.github.com/installation/repositories')) {
				return new Response(
					JSON.stringify({
						total_count: fullNames.length,
						repositories: fullNames.map((full_name) => ({ full_name, private: false, archived: false })),
					}),
					{ status: 200 },
				);
			}
			return new Response('not found', { status: 404 });
		}),
	);
}

function request(path = PATH, init: RequestInit = {}): Request {
	return new Request(`${ORIGIN}${path}`, {
		...init,
		headers: { Cookie: `${SESSION_COOKIE}=sid`, ...(init.headers ?? {}) },
	});
}

async function post(fields: Record<string, string>, path = PATH) {
	const body = new URLSearchParams(fields);
	return request(path, {
		method: 'POST',
		body,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	});
}

async function csrf(): Promise<string> {
	return csrfToken('sid', SECRET);
}

beforeEach(() => {
	vi.mocked(createAppJWT).mockResolvedValue('app.jwt');
	vi.mocked(getInstallationToken).mockImplementation(async (_jwt: string, id: number) => `inst-token-${id}`);
	mockRepoList();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('GET repo settings', () => {
	it('shows an admin the resolved values it would inherit', async () => {
		const { db } = makeDb('admin');
		const res = await handleDashboard(request(), makeEnv(db));
		const html = await res?.text();

		expect(res?.status).toBe(200);
		expect(html).toContain('acme/api');
		expect(html).toContain('placeholder="openrouter"');
		expect(html).toContain('Installation default: <code>dist/**, docs/**</code>');
		expect(html).toContain('Inherit (all)');
		expect(html).toContain('Save');
	});

	it('renders a member read-only: controls disabled, nothing submittable', async () => {
		const { db } = makeDb('member');
		const html = await (await handleDashboard(request(), makeEnv(db)))?.text();

		expect(html).toContain('Read-only — your role on this installation is member.');
		expect(html).toContain('<button class="btn btn-primary" type="submit" disabled>');
		expect(html).toContain('name="provider" value="" placeholder="openrouter" disabled');
	});

	it('marks the fields that are overridden', async () => {
		const { db } = makeDb('admin', {
			enabled: 1,
			provider: 'anthropic',
			model: null,
			severity_threshold: null,
			review_tone: null,
			ignore_paths: null,
		});
		const html = await (await handleDashboard(request(), makeEnv(db)))?.text();

		expect(html).toContain('value="anthropic"');
		expect(html).toContain('Provider <span class="badge">overridden</span>');
	});

	it('confirms a save with a banner instead of trusting the redirect', async () => {
		const { db } = makeDb('admin');
		const html = await (await handleDashboard(request(`${PATH}?saved=1`), makeEnv(db)))?.text();
		expect(html).toContain('Saved.');
	});

	it('sends a signed-out visitor to sign-in', async () => {
		const { db } = makeDb('admin');
		const res = await handleDashboard(new Request(`${ORIGIN}${PATH}`), makeEnv(db));
		expect(res?.status).toBe(200);
		expect(await res?.text()).toContain('Sign in with GitHub');
	});
});

describe('POST repo settings', () => {
	it('saves every override for an admin', async () => {
		const { db, writesStartingWith } = makeDb('admin');
		const res = await handleDashboard(
			await post({
				csrf: await csrf(),
				enabled: '1',
				provider: 'anthropic',
				model: 'claude-sonnet-5',
				severity_threshold: 'major',
				review_tone: 'concise',
				ignore_paths: 'dist/**',
			}),
			makeEnv(db),
		);

		expect(res?.status).toBe(303);
		expect(res?.headers.get('Location')).toBe(`${PATH}?saved=1`);

		const inserts = writesStartingWith('INSERT INTO repos');
		expect(inserts).toHaveLength(1);
		expect(inserts[0].args).toEqual([12, 'acme', 'api', 1, 'anthropic', 'claude-sonnet-5', 'major', 'concise', 'dist/**']);
	});

	it('stores an unchecked box as disabled, not as "inherit"', async () => {
		const { db, writesStartingWith } = makeDb('admin');
		await handleDashboard(await post({ csrf: await csrf(), provider: '', model: '' }), makeEnv(db));

		const inserts = writesStartingWith('INSERT INTO repos');
		expect(inserts[0].args).toEqual([12, 'acme', 'api', 0, null, null, null, null, null]);
	});

	it('treats blank fields as "inherit" rather than empty strings', async () => {
		const { db, writesStartingWith } = makeDb('admin');
		await handleDashboard(await post({ csrf: await csrf(), enabled: '1', provider: '  ', model: ' ' }), makeEnv(db));

		// A null column is what `mergeRepoConfig` reads as "use the installation's value".
		expect(writesStartingWith('INSERT INTO repos')[0].args).toEqual([12, 'acme', 'api', 1, null, null, null, null, null]);
	});

	it('resets to inherit by deleting the row', async () => {
		const { db, writesStartingWith } = makeDb('admin', {
			enabled: 0,
			provider: 'anthropic',
			model: null,
			severity_threshold: null,
			review_tone: null,
			ignore_paths: null,
		});
		const res = await handleDashboard(await post({ csrf: await csrf(), action: 'reset' }), makeEnv(db));

		expect(res?.status).toBe(303);
		expect(res?.headers.get('Location')).toBe(`${PATH}?saved=reset`);
		expect(writesStartingWith('DELETE FROM repos')[0].args).toEqual([12, 'acme', 'api']);
		expect(writesStartingWith('INSERT INTO repos')).toHaveLength(0);
	});

	it('refuses a member, and writes nothing', async () => {
		const { db, writesStartingWith } = makeDb('member');
		const res = await handleDashboard(await post({ csrf: await csrf(), enabled: '1' }), makeEnv(db));

		expect(res?.status).toBe(403);
		expect(writesStartingWith('INSERT INTO repos')).toHaveLength(0);
		expect(writesStartingWith('DELETE FROM repos')).toHaveLength(0);
	});

	it('refuses a missing or forged CSRF token, and writes nothing', async () => {
		const { db, writesStartingWith } = makeDb('admin');

		const missing = await handleDashboard(await post({ enabled: '1' }), makeEnv(db));
		expect(missing?.status).toBe(403);

		const forged = await handleDashboard(await post({ csrf: 'deadbeef', enabled: '1' }), makeEnv(db));
		expect(forged?.status).toBe(403);

		expect(writesStartingWith('INSERT INTO repos')).toHaveLength(0);
		expect(writesStartingWith('DELETE FROM repos')).toHaveLength(0);
	});

	it('refuses a repo this installation cannot see', async () => {
		const { db, writesStartingWith } = makeDb('admin');
		const res = await handleDashboard(
			await post({ csrf: await csrf(), enabled: '0' }, '/dashboard/installations/12/repos/acme/secret-repo'),
			makeEnv(db),
		);

		expect(res?.status).toBe(404);
		expect(writesStartingWith('INSERT INTO repos')).toHaveLength(0);
		expect(writesStartingWith('DELETE FROM repos')).toHaveLength(0);
	});

	it('refuses an installation the caller has no role on', async () => {
		const { db, writesStartingWith } = makeDb('admin');
		const res = await handleDashboard(
			await post({ csrf: await csrf(), enabled: '0' }, '/dashboard/installations/99/repos/acme/api'),
			makeEnv(db),
		);

		expect(res?.status).toBe(404);
		expect(writesStartingWith('INSERT INTO repos')).toHaveLength(0);
		expect(writesStartingWith('DELETE FROM repos')).toHaveLength(0);
	});

	it('answers an unsupported method with 405 rather than treating it as a GET', async () => {
		const { db, writesStartingWith } = makeDb('admin');
		const res = await handleDashboard(request(PATH, { method: 'DELETE' }), makeEnv(db));

		expect(res?.status).toBe(405);
		expect(res?.headers.get('Allow')).toBe('GET, POST');
		expect(writesStartingWith('INSERT INTO repos')).toHaveLength(0);
		expect(writesStartingWith('DELETE FROM repos')).toHaveLength(0);
	});
});

describe('fixes from AlphaPR review (PR #46, #49)', () => {
	it('makes the top-bar sign-out carry the CSRF token it is checked against', async () => {
		const { db } = makeDb('admin');
		const html = (await (await handleDashboard(request(), makeEnv(db)))?.text()) ?? '';
		const form = html.slice(html.indexOf('action="/auth/logout"'), html.indexOf('</form>', html.indexOf('action="/auth/logout"')));

		expect(form).toContain('name="csrf"');
		expect(form).toContain(`value="${await csrf()}"`);
	});

	it('puts Save before Reset to inherit, so Enter saves instead of wiping the overrides', async () => {
		const { db } = makeDb('admin', {
			enabled: 1,
			provider: 'anthropic',
			model: null,
			severity_threshold: null,
			review_tone: null,
			ignore_paths: null,
		});
		const html = (await (await handleDashboard(request(), makeEnv(db)))?.text()) ?? '';

		const save = html.indexOf('class="btn btn-primary" type="submit"');
		const reset = html.indexOf('name="action" value="reset"');

		expect(save).toBeGreaterThan(-1);
		expect(reset).toBeGreaterThan(-1);
		expect(save).toBeLessThan(reset);
	});

	it('answers a malformed escape in the path with 404 rather than throwing', async () => {
		const { db } = makeDb('admin');
		const res = await handleDashboard(request('/dashboard/installations/12/repos/acme%zz/api'), makeEnv(db));

		expect(res?.status).toBe(404);
	});

	it('refuses a severity value the review path would not understand', async () => {
		const { db, writesStartingWith } = makeDb('admin');
		const res = await handleDashboard(await post({ csrf: await csrf(), severity_threshold: 'everything' }), makeEnv(db));

		expect(res?.status).toBe(400);
		expect(await res?.text()).toContain('Not saved');
		expect(writesStartingWith('INSERT INTO repos')).toHaveLength(0);
	});

	it('refuses an unknown review tone the same way', async () => {
		const { db, writesStartingWith } = makeDb('admin');
		const res = await handleDashboard(await post({ csrf: await csrf(), review_tone: 'verbose' }), makeEnv(db));

		expect(res?.status).toBe(400);
		expect(writesStartingWith('INSERT INTO repos')).toHaveLength(0);
	});

	it('badges the severity and tone selects once they stop inheriting', async () => {
		const { db } = makeDb('admin', {
			enabled: 1,
			provider: null,
			model: null,
			severity_threshold: 'major',
			review_tone: 'concise',
			ignore_paths: null,
		});
		const html = (await (await handleDashboard(request(), makeEnv(db)))?.text()) ?? '';

		expect(html).toContain('<label for="severity_threshold">Severity threshold<span class="badge">overridden</span></label>');
		expect(html).toContain('<label for="review_tone">Review tone<span class="badge">overridden</span></label>');
	});
});

describe('step-up before a write', () => {
	function staleDb() {
		const createdAt = new Date(Date.now() - 30 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
		return makeFakeDb({
			sessions: [
				{
					session_id: 'sid',
					created_at: createdAt,
					last_used_at: null,
					expires_at: FUTURE,
					github_id: 4242,
					login: 'ekojoecovenant',
					avatar_url: null,
				},
			],
			access: { '4242:12': { role: 'admin', account_login: 'acme', account_type: 'Organization' } },
			installationConfig: INSTALLATION,
			repoOverrides: {},
		});
	}

	it('sends an old session back through GitHub instead of writing', async () => {
		const { db, writesStartingWith } = staleDb();
		const res = await handleDashboard(await post({ csrf: await csrf() }), makeEnv(db));

		expect(res?.status).toBe(302);
		expect(res?.headers.get('Location')).toBe(`/auth/github?next=${encodeURIComponent(PATH)}`);
		expect(writesStartingWith('INSERT INTO repos')).toHaveLength(0);
	});

	it('does the same for a key change', async () => {
		const { db, writesStartingWith } = staleDb();
		const res = await handleDashboard(
			await post({ csrf: await csrf(), api_key: 'sk-new-key-1234' }, '/dashboard/installations/12/key'),
			makeEnv(db),
		);

		expect(res?.status).toBe(302);
		expect(res?.headers.get('Location')).toContain('/auth/github?next=');
		expect(writesStartingWith('UPDATE installations SET api_key_encrypted')).toHaveLength(0);
	});

	it('still lets an old session read the page', async () => {
		const { db } = staleDb();
		const res = await handleDashboard(request(), makeEnv(db));

		expect(res?.status).toBe(200);
		expect(await res?.text()).toContain('Reset to inherit');
	});
});
