import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfToken, SESSION_COOKIE } from '../src/auth';
import { handleDashboard } from '../src/dashboard';

vi.mock('../src/github/auth', () => ({
	createAppJWT: vi.fn(async () => 'app.jwt'),
	getInstallationToken: vi.fn(async (_jwt: string, id: number) => `inst-token-${id}`),
}));

vi.mock('../src/crypto', () => ({
	decryptSecret: vi.fn(async () => 'sk-live-abcdef123456'),
	encryptSecret: vi.fn(async () => 'iv.ciphertext'),
}));

import { createAppJWT, getInstallationToken } from '../src/github/auth';
import { makeFakeDb } from './helpers/fake-d1';

const ORIGIN = 'https://alphapr.test';
const SECRET = 'secret';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
const REPO_PATH = '/dashboard/installations/12/repos/acme/api';
const MEMBERS_PATH = '/dashboard/installations/12/members';
const KEY_PATH = '/dashboard/installations/12/key';

const INSTALLATION = {
	provider: 'openrouter',
	model: 'deepseek/deepseek-v4-flash-0731',
	severity_threshold: 'all',
	review_tone: 'thorough',
	ignore_paths: 'dist/**',
	account_login: 'acme',
	api_key_encrypted: 'iv.ciphertext',
};

function makeEnv(db: D1Database): Env {
	return { DB: db, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pem', SETUP_SIGNING_SECRET: SECRET } as unknown as Env;
}

function makeDb(
	options: {
		audit?: Array<{
			installation_id: number;
			actor_login: string;
			action: string;
			target: string;
			detail: string | null;
			created_at: string;
		}>;
	} = {},
) {
	return makeFakeDb({
		sessions: [{ session_id: 'sid', last_used_at: null, expires_at: FUTURE, github_id: 4242, login: 'ekojoecovenant', avatar_url: null }],
		access: { '4242:12': { role: 'admin', account_login: 'acme', account_type: 'Organization' } },
		installationConfig: INSTALLATION,
		installations: [
			{
				installation_id: 12,
				account_login: 'acme',
				account_type: 'Organization',
				role: 'admin',
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
		audit: options.audit ?? [],
	});
}

function request(path: string, init: RequestInit = {}): Request {
	return new Request(`${ORIGIN}${path}`, {
		...init,
		headers: { Cookie: `${SESSION_COOKIE}=sid`, ...(init.headers ?? {}) },
	});
}

async function post(fields: Record<string, string>, path: string) {
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
			return new Response('{}', { status: 200 });
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('audit trail', () => {
	it('records a repository settings change as a diff of only what changed', async () => {
		const fake = makeDb();
		const csrf = await csrfToken('sid', SECRET);

		await handleDashboard(
			await post(
				{
					csrf,
					action: 'save',
					enabled: 'on',
					provider: 'anthropic',
					model: 'claude-sonnet-5',
					severity_threshold: 'major',
					review_tone: 'concise',
					ignore_paths: 'dist/**',
				},
				REPO_PATH,
			),
			makeEnv(fake.db),
		);

		const entries = fake.writesStartingWith('INSERT INTO audit_log');
		expect(entries).toHaveLength(1);
		// args are (installation_id, actor_login, action, target, detail)
		const [installationId, actor, action, target, detail] = entries[0].args as [number, string, string, string, string | null];
		expect([installationId, actor, action, target]).toEqual([12, 'ekojoecovenant', 'repo.updated', 'acme/api']);
		const parsed = JSON.parse(detail ?? '{}');
		expect(parsed.provider).toEqual({ from: null, to: 'anthropic' });
		expect(parsed.model).toEqual({ from: null, to: 'claude-sonnet-5' });
		// Each recorded field carries both sides, so the trail reads as a diff
		// rather than a dump of the row after the change.
		expect(parsed.ignorePaths).toEqual({ from: null, to: 'dist/**' });
	});

	it('records a reset with what was removed', async () => {
		const fake = makeDb();
		fake.db; // keep the fake alive for the read of the prior override
		const priorDb = makeFakeDb({
			sessions: [{ session_id: 'sid', last_used_at: null, expires_at: FUTURE, github_id: 4242, login: 'ekojoecovenant', avatar_url: null }],
			access: { '4242:12': { role: 'admin', account_login: 'acme', account_type: 'Organization' } },
			installationConfig: INSTALLATION,
			repos: { 12: [{ owner: 'acme', name: 'api', enabled: 1 }] },
			repoOverrides: {
				'12:acme/api': {
					enabled: 0,
					provider: 'anthropic',
					model: 'claude-sonnet-5',
					severity_threshold: 'major',
					review_tone: 'concise',
					ignore_paths: null,
				},
			},
			installations: [],
		});

		const csrf = await csrfToken('sid', SECRET);
		await handleDashboard(await post({ csrf, action: 'reset' }, REPO_PATH), makeEnv(priorDb.db));

		const entries = priorDb.writesStartingWith('INSERT INTO audit_log');
		expect(entries).toHaveLength(1);
		expect(entries[0].args[2]).toBe('repo.reset');
		expect(String(entries[0].args[4])).toContain('anthropic');
	});

	it('records a key replacement by its masked hint, never the key', async () => {
		const fake = makeDb();
		const csrf = await csrfToken('sid', SECRET);

		await handleDashboard(await post({ csrf, api_key: 'sk-live-abcdef123456' }, KEY_PATH), makeEnv(fake.db));

		const entries = fake.writesStartingWith('INSERT INTO audit_log');
		expect(entries).toHaveLength(1);
		expect(entries[0].args[2]).toBe('key.replaced');
		expect(entries[0].args[3]).toBe('openrouter key');
		expect(String(entries[0].args[4])).toContain('…3456');
		expect(JSON.stringify(entries[0].args)).not.toContain('sk-live-abcdef123456');
	});

	it('records an invite and a removal by login', async () => {
		const fake = makeDb();
		const csrf = await csrfToken('sid', SECRET);

		await handleDashboard(await post({ csrf, action: 'add', login: '@octocat' }, MEMBERS_PATH), makeEnv(fake.db));
		await handleDashboard(await post({ csrf, action: 'remove', login: 'OctoCat' }, MEMBERS_PATH), makeEnv(fake.db));

		const entries = fake.writesStartingWith('INSERT INTO audit_log');
		expect(entries.map((entry) => entry.args[2])).toEqual(['member.added', 'member.removed']);
		expect(entries.map((entry) => entry.args[3])).toEqual(['octocat', 'OctoCat']);
	});

	it('does not record an invite that already existed', async () => {
		const fake = makeFakeDb({
			sessions: [{ session_id: 'sid', last_used_at: null, expires_at: FUTURE, github_id: 4242, login: 'ekojoecovenant', avatar_url: null }],
			access: { '4242:12': { role: 'admin', account_login: 'acme', account_type: 'Organization' } },
			installationConfig: INSTALLATION,
			changes: 0,
			installations: [],
		});
		const csrf = await csrfToken('sid', SECRET);

		await handleDashboard(await post({ csrf, action: 'add', login: 'octocat' }, MEMBERS_PATH), makeEnv(fake.db));

		expect(fake.writesStartingWith('INSERT INTO audit_log')).toHaveLength(0);
	});
});

describe('GET /dashboard/activity', () => {
	it('renders recorded changes in words, with the diff inline', async () => {
		const fake = makeDb({
			audit: [
				{
					installation_id: 12,
					actor_login: 'ekojoecovenant',
					action: 'repo.updated',
					target: 'acme/api',
					detail: JSON.stringify({ provider: { from: null, to: 'anthropic' } }),
					created_at: '2026-11-18 22:10:00',
				},
			],
		});

		const res = await handleDashboard(request('/dashboard/activity'), makeEnv(fake.db));
		const body = await res?.text();

		expect(res?.status).toBe(200);
		expect(body).toContain('Who changed what.');
		expect(body).toContain('Repo settings changed');
		expect(body).toContain('provider: inherit → anthropic');
		expect(body).toContain('@ekojoecovenant');
		expect(body).toContain('2026-11-18 22:10 UTC');
		expect(body).toContain('1 recorded change.');
		expect(body).toContain('aria-current="page"');
	});

	it('says so plainly when nothing has been changed yet', async () => {
		const fake = makeDb();
		const body = await (await handleDashboard(request('/dashboard/activity'), makeEnv(fake.db)))?.text();
		expect(body).toContain('Nothing has been changed from the dashboard yet.');
	});

	it('shows only the installations the user administers', async () => {
		const fake = makeDb({
			audit: [
				{
					installation_id: 99,
					actor_login: 'someone-else',
					action: 'repo.reset',
					target: 'other/repo',
					detail: null,
					created_at: '2026-11-18 22:10:00',
				},
			],
		});
		const body = await (await handleDashboard(request('/dashboard/activity'), makeEnv(fake.db)))?.text();
		expect(body).not.toContain('other/repo');
		expect(body).not.toContain('someone-else');
	});

	it('is read-only', async () => {
		const fake = makeDb();
		const res = await handleDashboard(await post({}, '/dashboard/activity'), makeEnv(fake.db));
		expect(res?.status).toBe(405);
		expect(res?.headers.get('Allow')).toBe('GET');
	});
});
