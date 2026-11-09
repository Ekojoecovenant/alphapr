import { afterEach, describe, expect, it, vi } from 'vitest';
import { csrfToken, getSessionUser, handleAuth, SESSION_COOKIE } from '../src/auth';
import { hmacSign } from '../src/setup';
import { makeFakeDb } from './helpers/fake-d1';

const SECRET = 'test-signing-secret';
const CLIENT_ID = 'Iv23testclientid';
const CLIENT_SECRET = 'client-secret-value';
const ORIGIN = 'https://alphapr.test';

function makeEnv(db: D1Database): Env {
	return { DB: db, GITHUB_CLIENT_ID: CLIENT_ID, GITHUB_CLIENT_SECRET: CLIENT_SECRET, SETUP_SIGNING_SECRET: SECRET } as unknown as Env;
}

/** A valid signed state plus the nonce cookie that must accompany it. */
async function stateAndNonce(): Promise<{ state: string; nonce: string }> {
	const ts = Date.now().toString();
	const nonce = 'a'.repeat(32);
	const payload = `${ts}.${nonce}`;
	return { state: `${payload}.${await hmacSign(payload, SECRET)}`, nonce };
}

type FetchHandler = (url: string) => Response | undefined;

function mockFetch(handler: FetchHandler) {
	const mock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		return handler(url) ?? new Response('not found', { status: 404 });
	});
	vi.stubGlobal('fetch', mock);
	return mock;
}

function ghUser(login = 'ekojoecovenant', id = 4242) {
	return new Response(JSON.stringify({ id, login, avatar_url: 'https://avatars.example/u.png' }), { status: 200 });
}

function ghInstallations(installations: Array<{ id: number; account: { login: string; type: string } }>) {
	return new Response(JSON.stringify({ total_count: installations.length, installations }), { status: 200 });
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('GET /auth/github', () => {
	it('redirects to GitHub with a signed state and a browser-bound nonce', async () => {
		const { db } = makeFakeDb();
		const res = await handleAuth(new Request(`${ORIGIN}/auth/github`), makeEnv(db));

		expect(res?.status).toBe(302);
		const location = new URL(res?.headers.get('Location') ?? '');
		expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
		expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
		expect(location.searchParams.get('scope')).toBe('read:user');
		expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);

		const state = location.searchParams.get('state') ?? '';
		const [ts, nonce, sig] = state.split('.');
		expect(ts).toBeTruthy();
		expect(await hmacSign(`${ts}.${nonce}`, SECRET)).toBe(sig);

		const cookie = res?.headers.get('Set-Cookie') ?? '';
		expect(cookie).toContain(`alphapr_auth_nonce=${nonce}`);
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain('Path=/auth');
	});

	it('does not answer a POST', async () => {
		const { db } = makeFakeDb();
		const res = await handleAuth(new Request(`${ORIGIN}/auth/github`, { method: 'POST' }), makeEnv(db));
		expect(res?.status).toBe(404);
	});
});

describe('GET /auth/callback', () => {
	it('rejects a state that was tampered with', async () => {
		const { db } = makeFakeDb();
		const { nonce } = await stateAndNonce();
		const req = new Request(`${ORIGIN}/auth/callback?code=abc&state=1.${nonce}.deadbeef`, {
			headers: { Cookie: `alphapr_auth_nonce=${nonce}` },
		});

		const res = await handleAuth(req, makeEnv(db));
		expect(res?.status).toBe(400);
		expect(await res?.text()).toContain('not valid');
	});

	it('rejects a state minted for a different browser', async () => {
		const { db } = makeFakeDb();
		const { state } = await stateAndNonce();
		const req = new Request(`${ORIGIN}/auth/callback?code=abc&state=${state}`, {
			headers: { Cookie: 'alphapr_auth_nonce=someone-elses-nonce' },
		});

		const res = await handleAuth(req, makeEnv(db));
		expect(res?.status).toBe(400);
		expect(await res?.text()).toContain('different browser');
	});

	it('rejects a state older than ten minutes', async () => {
		const { db } = makeFakeDb();
		const ts = (Date.now() - 11 * 60 * 1000).toString();
		const nonce = 'b'.repeat(32);
		const payload = `${ts}.${nonce}`;
		const state = `${payload}.${await hmacSign(payload, SECRET)}`;
		const req = new Request(`${ORIGIN}/auth/callback?code=abc&state=${state}`, {
			headers: { Cookie: `alphapr_auth_nonce=${nonce}` },
		});

		const res = await handleAuth(req, makeEnv(db));
		expect(res?.status).toBe(400);
		expect(await res?.text()).toContain('expired');
	});

	it('signs in, records admin and read-only installations, and opens a session', async () => {
		const { db, writes } = makeFakeDb();
		const { state, nonce } = await stateAndNonce();

		mockFetch((url) => {
			if (url === 'https://github.com/login/oauth/access_token') {
				return new Response(JSON.stringify({ access_token: 'gho_user_token' }), { status: 200 });
			}
			if (url === 'https://api.github.com/user') return ghUser();
			if (url === 'https://api.github.com/user/installations') {
				return ghInstallations([
					{ id: 1, account: { login: 'ekojoecovenant', type: 'User' } },
					{ id: 2, account: { login: 'ForXed', type: 'Organization' } },
				]);
			}
			if (url.startsWith('https://api.github.com/orgs/ForXed/memberships/')) {
				return new Response(JSON.stringify({ role: 'member', state: 'active' }), { status: 200 });
			}
			return undefined;
		});

		const req = new Request(`${ORIGIN}/auth/callback?code=abc&state=${state}`, {
			headers: { Cookie: `alphapr_auth_nonce=${nonce}` },
		});
		const res = await handleAuth(req, makeEnv(db));

		expect(res?.status).toBe(302);
		expect(res?.headers.get('Location')).toBe('/dashboard');

		// Two cookies must travel as two headers. Sent as one, the browser reads
		// the nonce-clearing Max-Age=0 as part of the session cookie and deletes
		// the session immediately — sign-in then looks like a page refresh.
		const cookies = res?.headers.getSetCookie() ?? [];
		expect(cookies).toHaveLength(2);
		const sessionCookieHeader = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
		expect(sessionCookieHeader).toContain('HttpOnly');
		expect(sessionCookieHeader).toContain('Max-Age=2592000');
		expect(sessionCookieHeader).not.toContain('Max-Age=0');
		expect(cookies.some((c) => c.startsWith('alphapr_auth_nonce=') && c.includes('Max-Age=0'))).toBe(true);

		const userWrite = writes.find((w) => w.sql.includes('INSERT INTO users'));
		expect(userWrite?.args.slice(0, 2)).toEqual([4242, 'ekojoecovenant']);

		const installationWrites = writes.filter((w) => w.sql.includes('INSERT INTO user_installations'));
		expect(installationWrites).toHaveLength(2);
		// Personal install owned by the signer is admin; the org where they are
		// only a member is not.
		expect(installationWrites.map((w) => [w.args[1], w.args[4]])).toEqual([
			[1, 'admin'],
			[2, 'member'],
		]);

		const sessionWrite = writes.find((w) => w.sql.includes('INSERT INTO sessions'));
		expect(sessionWrite?.args[1]).toBe(4242);
		expect(String(sessionWrite?.args[2])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it('shows a clear error when GitHub refuses the token exchange', async () => {
		const { db } = makeFakeDb();
		const { state, nonce } = await stateAndNonce();
		mockFetch((url) =>
			url === 'https://github.com/login/oauth/access_token'
				? new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 })
				: undefined,
		);

		const req = new Request(`${ORIGIN}/auth/callback?code=abc&state=${state}`, {
			headers: { Cookie: `alphapr_auth_nonce=${nonce}` },
		});
		const res = await handleAuth(req, makeEnv(db));
		expect(res?.status).toBe(400);
		expect(await res?.text()).toContain('did not authorize');
	});
});

describe('getSessionUser', () => {
	it('returns null when no cookie is present', async () => {
		const { db } = makeFakeDb();
		expect(await getSessionUser(new Request(`${ORIGIN}/dashboard`), makeEnv(db))).toBeNull();
	});

	it('returns null for an expired session row', async () => {
		const { db } = makeFakeDb({
			sessions: [
				{
					session_id: 'sid',
					last_used_at: '2026-01-01 00:00:00',
					expires_at: '2026-01-02 00:00:00',
					github_id: 1,
					login: 'ekojoecovenant',
					avatar_url: null,
				},
			],
		});
		const req = new Request(`${ORIGIN}/dashboard`, { headers: { Cookie: `${SESSION_COOKIE}=sid` } });
		expect(await getSessionUser(req, makeEnv(db))).toBeNull();
	});

	it('returns the user and refreshes a stale last_used_at', async () => {
		const future = new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
		const { db, writes } = makeFakeDb({
			sessions: [
				{
					session_id: 'sid',
					last_used_at: '2026-01-01 00:00:00',
					expires_at: future,
					github_id: 7,
					login: 'ekojoecovenant',
					avatar_url: null,
				},
			],
		});
		const req = new Request(`${ORIGIN}/dashboard`, { headers: { Cookie: `${SESSION_COOKIE}=sid` } });

		const user = await getSessionUser(req, makeEnv(db));
		expect(user).toMatchObject({ sessionId: 'sid', githubId: 7, login: 'ekojoecovenant' });
		expect(writes.some((w) => w.sql.includes('UPDATE sessions SET last_used_at'))).toBe(true);
		// Sliding expiry: the deadline must move with the stamp, or '30 days idle' is a lie.
		expect(writes.some((w) => w.sql.includes("expires_at = datetime('now', ?)"))).toBe(true);
	});

	it('does not write on every request when last_used_at is fresh', async () => {
		const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
		const future = new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
		const { db, writes } = makeFakeDb({
			sessions: [{ session_id: 'sid', last_used_at: now, expires_at: future, github_id: 7, login: 'x', avatar_url: null }],
		});
		const req = new Request(`${ORIGIN}/dashboard`, { headers: { Cookie: `${SESSION_COOKIE}=sid` } });

		expect(await getSessionUser(req, makeEnv(db))).not.toBeNull();
		expect(writes).toHaveLength(0);
	});
});

describe('POST /auth/logout', () => {
	const future = new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

	function seededDb() {
		return makeFakeDb({
			sessions: [{ session_id: 'sid', last_used_at: null, expires_at: future, github_id: 7, login: 'ekojoecovenant', avatar_url: null }],
		});
	}

	function logoutRequest(csrf: string): Request {
		const body = new FormData();
		body.set('csrf', csrf);
		return new Request(`${ORIGIN}/auth/logout`, {
			method: 'POST',
			headers: { Cookie: `${SESSION_COOKIE}=sid` },
			body,
		});
	}

	it('deletes the session and clears the cookie when the token is valid', async () => {
		const { db, writes } = seededDb();
		const res = await handleAuth(logoutRequest(await csrfToken('sid', SECRET)), makeEnv(db));

		expect(res?.status).toBe(302);
		expect(res?.headers.get('Location')).toBe('/');
		expect(res?.headers.get('Set-Cookie')).toContain(`${SESSION_COOKIE}=;`);
		expect(writes.some((w) => w.sql.includes('DELETE FROM sessions'))).toBe(true);
	});

	it('refuses a request without a valid CSRF token', async () => {
		const { db, writes } = seededDb();
		const res = await handleAuth(logoutRequest('forged'), makeEnv(db));

		expect(res?.status).toBe(400);
		expect(writes.some((w) => w.sql.includes('DELETE FROM sessions'))).toBe(false);
	});
});
