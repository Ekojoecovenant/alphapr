import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfToken, SESSION_COOKIE } from '../src/auth';
import { encryptSecret } from '../src/crypto';
import { handleDashboard } from '../src/dashboard';
import { makeFakeDb } from './helpers/fake-d1';

const ORIGIN = 'https://alphapr.test';
const SECRET = 'secret';
const MASTER = 'a'.repeat(64);
const FUTURE = new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
const STORED_KEY = 'sk-or-v1-abcdefghijklmnopwxyz';

function makeEnv(db: D1Database): Env {
	return {
		DB: db,
		GITHUB_APP_ID: '1',
		GITHUB_APP_PRIVATE_KEY: 'pem',
		SETUP_SIGNING_SECRET: SECRET,
		KEY_ENCRYPTION_SECRET: MASTER,
	} as unknown as Env;
}

async function makeDb(role: 'admin' | 'member', storedKey: string | null, changes = 1) {
	return makeFakeDb({
		sessions: [{ session_id: 'sid', last_used_at: null, expires_at: FUTURE, github_id: 4242, login: 'ekojoe', avatar_url: null }],
		access: { '4242:12': { role, account_login: 'acme', account_type: 'Organization' } },
		changes,
		installationConfig: {
			provider: 'openrouter',
			model: 'deepseek/deepseek-v4-flash-0731',
			api_key_encrypted: storedKey,
			key_hint: storedKey ? '…wxyz' : null,
		},
	});
}

function request(path: string, body?: Record<string, string>) {
	return new Request(`${ORIGIN}${path}`, {
		method: 'POST',
		body: body ? new URLSearchParams(body) : undefined,
		headers: { Cookie: `${SESSION_COOKIE}=sid`, 'Content-Type': 'application/x-www-form-urlencoded' },
	});
}

const csrf = () => csrfToken('sid', SECRET);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('POST /dashboard/installations/:id/key', () => {
	it('stores ciphertext and a four-character hint, never the plaintext', async () => {
		const { db, writesStartingWith } = await makeDb('admin', null);
		const res = await handleDashboard(request('/dashboard/installations/12/key', { csrf: await csrf(), api_key: STORED_KEY }), makeEnv(db));

		expect(res?.status).toBe(303);
		const [write] = writesStartingWith('UPDATE installations');
		expect(write).toBeDefined();
		expect(write.args[1]).toBe('…wxyz');
		expect(String(write.args[0])).not.toContain(STORED_KEY);
		expect(write.args[2]).toBe(12);
	});

	it('reports a missing installation instead of claiming the key was saved', async () => {
		const { db } = await makeDb('admin', null, 0);
		const res = await handleDashboard(request('/dashboard/installations/12/key', { csrf: await csrf(), api_key: STORED_KEY }), makeEnv(db));

		expect(res?.status).toBe(404);
		expect(await res?.text()).toContain('no longer exists');
	});

	it('refuses a value too short to be a key', async () => {
		const { db, writesStartingWith } = await makeDb('admin', null);
		const res = await handleDashboard(request('/dashboard/installations/12/key', { csrf: await csrf(), api_key: 'sk-1' }), makeEnv(db));

		expect(res?.status).toBe(400);
		expect(writesStartingWith('UPDATE installations')).toHaveLength(0);
	});

	it('refuses a member, and writes nothing', async () => {
		const { db, writesStartingWith } = await makeDb('member', null);
		const res = await handleDashboard(request('/dashboard/installations/12/key', { csrf: await csrf(), api_key: STORED_KEY }), makeEnv(db));

		expect(res?.status).toBe(403);
		expect(writesStartingWith('UPDATE installations')).toHaveLength(0);
	});

	it('refuses a post without the CSRF token', async () => {
		const { db, writesStartingWith } = await makeDb('admin', null);
		const res = await handleDashboard(request('/dashboard/installations/12/key', { api_key: STORED_KEY }), makeEnv(db));

		expect(res?.status).toBe(403);
		expect(writesStartingWith('UPDATE installations')).toHaveLength(0);
	});
});

describe('POST /dashboard/installations/:id/test', () => {
	beforeEach(async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
							usage: { prompt_tokens: 12, completion_tokens: 1 },
						}),
						{ status: 200 },
					),
			),
		);
	});

	it('answers with what the provider said and how long it took', async () => {
		const { db } = await makeDb('admin', await encryptSecret(STORED_KEY, MASTER));
		const res = await handleDashboard(request('/dashboard/installations/12/test', { csrf: await csrf() }), makeEnv(db));
		const text = (await res?.text()) ?? '';

		expect(res?.status).toBe(200);
		expect(text).toContain('Provider answered');
		expect(text).toContain('openrouter answered in');
		expect(text).toContain('replied ok');
	});

	it('reports a refusal instead of pretending the key works', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Key limit exceeded' } }), { status: 403 })),
		);
		const { db } = await makeDb('admin', await encryptSecret(STORED_KEY, MASTER));
		const res = await handleDashboard(request('/dashboard/installations/12/test', { csrf: await csrf() }), makeEnv(db));

		expect(res?.status).toBe(502);
		expect(await res?.text()).toContain('Provider refused');
	});

	it('says so when there is no key to test', async () => {
		const { db } = await makeDb('admin', null);
		const res = await handleDashboard(request('/dashboard/installations/12/test', { csrf: await csrf() }), makeEnv(db));

		expect(res?.status).toBe(400);
		expect(await res?.text()).toContain('No key yet');
	});
});
