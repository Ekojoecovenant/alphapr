// /setup/save: what it will accept, and what it refuses.
//
// The form token used to be a portable bearer credential — anyone who could read
// the rendered page could replay it for ten minutes. It is now bound to a nonce
// cookie set on the browser that completed the OAuth round trip, so the token on
// its own is not enough.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSetup, hmacSign } from '../src/setup';
import { makeFakeDb } from './helpers/fake-d1';

const ORIGIN = 'https://alphapr.test';
const SECRET = 'test-signing-secret';
const BINDING = 'abcdef0123456789abcdef0123456789';

function makeEnv(db: D1Database): Env {
	return {
		DB: db,
		GITHUB_APP_ID: '1',
		GITHUB_APP_PRIVATE_KEY: 'pem',
		SETUP_SIGNING_SECRET: SECRET,
		KEY_ENCRYPTION_SECRET: 'a'.repeat(64),
	} as unknown as Env;
}

/** A token exactly as /setup/callback mints it for browser `binding`. */
async function formToken(options: { binding?: string; expiresInMs?: number; allowed?: string } = {}): Promise<string> {
	const digest = await hmacSign(`setup-binding:${options.binding ?? BINDING}`, SECRET);
	const payload = `${options.allowed ?? '12:acme'}|${Date.now() + (options.expiresInMs ?? 600_000)}|${digest}`;
	return `${payload}.${await hmacSign(payload, SECRET)}`;
}

function saveRequest(fields: Record<string, string>, cookie?: string): Request {
	const body = new URLSearchParams({
		installationId: '12',
		provider: 'openrouter',
		model: 'deepseek/deepseek-v4-flash-0731',
		severityThreshold: 'all',
		reviewTone: 'thorough',
		ignorePaths: '',
		...fields,
	});
	const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
	if (cookie !== undefined) headers.Cookie = cookie;
	return new Request(`${ORIGIN}/setup/save`, { method: 'POST', headers, body });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('POST /setup/save token binding', () => {
	it('saves when the token and the browser cookie agree', async () => {
		const { db, writes } = makeFakeDb({ installationConfig: { api_key_encrypted: 'stored' } });
		const res = await handleSetup(
			saveRequest({ token: await formToken(), apiKey: 'sk-or-v1-abcdefghij' }, `alphapr_setup_binding=${BINDING}`),
			makeEnv(db),
		);

		expect(res?.status).toBe(200);
		expect(writes.some((w) => w.sql.includes('INSERT INTO installations'))).toBe(true);
		// The binding is spent: the success page clears the cookie.
		expect(res?.headers.getSetCookie().some((c) => c.startsWith('alphapr_setup_binding=') && c.includes('Max-Age=0'))).toBe(true);
	});

	it('refuses the token when the browser has no binding cookie', async () => {
		const { db, writes } = makeFakeDb({ installationConfig: { api_key_encrypted: 'stored' } });
		const res = await handleSetup(saveRequest({ token: await formToken(), apiKey: 'sk-or-v1-abcdefghij' }), makeEnv(db));

		expect(res?.status).toBe(403);
		expect(writes.some((w) => w.sql.includes('INSERT INTO installations'))).toBe(false);
	});

	it('refuses a token minted for a different browser', async () => {
		const { db, writes } = makeFakeDb({ installationConfig: { api_key_encrypted: 'stored' } });
		const token = await formToken({ binding: 'a-different-browser' });
		const res = await handleSetup(saveRequest({ token, apiKey: 'sk-or-v1-abcdefghij' }, `alphapr_setup_binding=${BINDING}`), makeEnv(db));

		expect(res?.status).toBe(403);
		expect(writes.some((w) => w.sql.includes('INSERT INTO installations'))).toBe(false);
	});

	it('still refuses an expired token before looking at the cookie', async () => {
		const { db } = makeFakeDb({ installationConfig: { api_key_encrypted: 'stored' } });
		const res = await handleSetup(
			saveRequest({ token: await formToken({ expiresInMs: -1000 }), apiKey: 'sk-or-v1-abcdefghij' }, `alphapr_setup_binding=${BINDING}`),
			makeEnv(db),
		);

		expect(res?.status).toBe(400);
	});

	it('still refuses a tampered token', async () => {
		const { db } = makeFakeDb({ installationConfig: { api_key_encrypted: 'stored' } });
		const token = (await formToken()).replace('12:acme', '99:other');
		const res = await handleSetup(saveRequest({ token, apiKey: 'sk-or-v1-abcdefghij' }, `alphapr_setup_binding=${BINDING}`), makeEnv(db));

		expect(res?.status).toBe(400);
	});

	it('still refuses an installation the token does not list', async () => {
		const { db } = makeFakeDb({ installationConfig: { api_key_encrypted: 'stored' } });
		const res = await handleSetup(
			saveRequest({ installationId: '77', token: await formToken(), apiKey: 'sk-or-v1-abcdefghij' }, `alphapr_setup_binding=${BINDING}`),
			makeEnv(db),
		);

		expect(res?.status).toBe(403);
	});
});

describe('setup pages carry security headers', () => {
	it('sends a CSP, nosniff and no-store with every HTML error page', async () => {
		const { db } = makeFakeDb();
		const res = await handleSetup(
			new Request(`${ORIGIN}/setup/callback?code=x&state=1.2.3`, { headers: { Cookie: 'alphapr_setup_nonce=2' } }),
			makeEnv(db),
		);

		expect(res?.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
		expect(res?.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res?.headers.get('Cache-Control')).toBe('no-store');
		expect(res?.headers.get('X-Frame-Options')).toBe('DENY');
	});
});
