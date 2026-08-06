import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthorizedInstallations, hmacSign, hmacVerify } from '../src/setup';

const SECRET = 'test-secret-do-not-use-in-production';

type Inst = { id: number; account: { login: string; type: string } };

function install(id: number, login: string, type: string): Inst {
	return { id, account: { login, type } };
}

/** Stub globalThis.fetch for the user + org-membership calls getAuthorizedInstallations makes. */
function mockGitHub(meLogin: string, orgResponses: Record<string, Response>) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === 'https://api.github.com/user') {
			return new Response(JSON.stringify({ login: meLogin }), { status: 200 });
		}
		// https://api.github.com/orgs/{login}/memberships/{meLogin}
		const m = url.match(/^https:\/\/api\.github\.com\/orgs\/([^/]+)\/memberships\//);
		if (m) {
			const org = decodeURIComponent(m[1]);
			const res = orgResponses[org];
			if (res) return res;
			return new Response('{}', { status: 404 });
		}
		return new Response('not found', { status: 404 });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('getAuthorizedInstallations', () => {
	it('keeps a personal-account installation owned by the authenticated user', async () => {
		mockGitHub('ekojoe', {});
		const res = await getAuthorizedInstallations('tok', [install(1, 'ekojoe', 'User'), install(2, 'someone-else', 'User')]);
		expect(res.map((r) => r.id)).toEqual([1]);
	});

	it('keeps an org installation where the user is an active admin', async () => {
		mockGitHub('ekojoe', {
			ForXed: new Response(JSON.stringify({ role: 'admin', state: 'active' }), { status: 200 }),
		});
		const res = await getAuthorizedInstallations('tok', [install(10, 'ForXed', 'Organization')]);
		expect(res.map((r) => r.id)).toEqual([10]);
	});

	it('drops an org installation where the user is only a member (non-admin)', async () => {
		mockGitHub('ekojoe', {
			zaynTech: new Response(JSON.stringify({ role: 'member', state: 'active' }), { status: 200 }),
		});
		const res = await getAuthorizedInstallations('tok', [install(11, 'zaynTech', 'Organization')]);
		expect(res).toEqual([]);
	});

	it('drops an org installation with a 404 (genuinely not a member) without logging', async () => {
		const fetchMock = mockGitHub('ekojoe', {});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const res = await getAuthorizedInstallations('tok', [install(12, 'stranger', 'Organization')]);
		expect(res).toEqual([]);
		const orgCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/orgs/'));
		expect(orgCalls.length).toBe(1);
		expect(errSpy).not.toHaveBeenCalled();
	});

	it('drops an org installation with a 403 but logs loudly (missing app permission)', async () => {
		mockGitHub('ekojoe', {
			ForXed: new Response('{}', { status: 403 }),
		});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const res = await getAuthorizedInstallations('tok', [install(13, 'ForXed', 'Organization')]);
		expect(res).toEqual([]);
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('getAuthorizedInstallations: membership check for ForXed failed (403)'));
	});

	it('returns empty when /user cannot be fetched', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const res = await getAuthorizedInstallations('tok', [install(1, 'ekojoe', 'User')]);
		expect(res).toEqual([]);
		expect(errSpy).toHaveBeenCalled();
	});

	it('drops an org installation where an admin invite is still pending', async () => {
		mockGitHub('ekojoe', {
			ForXed: new Response(JSON.stringify({ role: 'admin', state: 'pending' }), { status: 200 }),
		});
		const res = await getAuthorizedInstallations('tok', [install(14, 'ForXed', 'Organization')]);
		expect(res).toEqual([]);
	});
});

describe('hmacSign / hmacVerify', () => {
	it('produces a signature that verifies successfully against the same data and secret', async () => {
		const sig = await hmacSign('hello world', SECRET);
		const valid = await hmacVerify('hello world', sig, SECRET);

		expect(valid).toBe(true);
	});

	it('rejects a signature if the data was tampered with', async () => {
		const sig = await hmacSign('hello world', SECRET);
		const valid = await hmacVerify('goodbye world', sig, SECRET);

		expect(valid).toBe(false);
	});

	it('rejects a signature if the secret is wrong', async () => {
		const sig = await hmacSign('hello world', SECRET);
		const valid = await hmacVerify('hello world', sig, 'a-different-secret');

		expect(valid).toBe(false);
	});

	it('rejects a signature of the wrong length instead of throwing', async () => {
		const valid = await hmacVerify('hello world', 'abc', SECRET);

		expect(valid).toBe(false);
	});

	it('produces a deterministic signature for the same input', async () => {
		const sig1 = await hmacSign('same input', SECRET);
		const sig2 = await hmacSign('same input', SECRET);

		// HMAC is deterministic — same data + secret always produces the same signature.
		// (Unlike the encrypted API keys in crypto.ts, which use a random IV every time.)
		expect(sig1).toBe(sig2);
	});

	it('produces different signatures for different secrets', async () => {
		const sig1 = await hmacSign('same input', 'secret-one');
		const sig2 = await hmacSign('same input', 'secret-two');

		expect(sig1).not.toBe(sig2);
	});
});
