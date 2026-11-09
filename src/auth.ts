// Sign in with GitHub, and the session that keeps you signed in (ADR 0002, P0).
//
// Deliberately boring: the user token is used once to discover installations and
// then dropped. Auth tokens stay inside the worker, where they are bound to an
// installation and expire on their own.

import { invitedInstallations } from './db';
import { htmlHeaders } from './security';
import { getAuthorizedInstallations, hmacSign, hmacVerify, randomHex } from './setup';

export const SESSION_COOKIE = 'alphapr_session';
const NONCE_COOKIE = 'alphapr_auth_nonce';
const NEXT_COOKIE = 'alphapr_auth_next';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days of idle
/** A session dies after this long no matter how much it is used. */
const SESSION_MAX_SECONDS = 7 * 24 * 60 * 60;
/** Writes require a session this fresh, which forces a new role snapshot. */
export const STEP_UP_SECONDS = 24 * 60 * 60;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh the `last_used_at` stamp at most this often, to keep reads read-ish. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const GITHUB_API = 'https://api.github.com';

export interface SessionUser {
	sessionId: string;
	githubId: number;
	login: string;
	avatarUrl: string | null;
	/** When this session was opened; the absolute cap and step-up both read it. */
	createdAt: string;
}

interface RawInstallation {
	id: number;
	account: { login: string; type: string };
}

export function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get('Cookie');
	if (!header) return null;
	for (const part of header.split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === name) return rest.join('=');
	}
	return null;
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: htmlHeaders() });
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
	return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}

function secure(request: Request): string {
	// `Secure` cookies are not stored over plain http, which would make the
	// dashboard untestable under `wrangler dev`. Production is always https.
	const { hostname } = new URL(request.url);
	const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
	return isLocal ? '' : '; Secure';
}

function cookieHeader(request: Request, name: string, value: string, maxAgeSeconds: number, path = '/'): string {
	return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAgeSeconds}${secure(request)}`;
}

function clearCookie(request: Request, name: string, path = '/'): string {
	return `${name}=; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=0${secure(request)}`;
}

/** SQLite text timestamp ("YYYY-MM-DD HH:MM:SS"), matching `datetime('now')`. */
function sqlTimestamp(date: Date): string {
	return date.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Re-issue the session cookie so its Max-Age tracks the sliding expiry; without
 * this the row outlives the cookie and the user is signed out anyway.
 */
export function sessionCookie(request: Request, sessionId: string): string {
	return cookieHeader(request, SESSION_COOKIE, sessionId, SESSION_TTL_SECONDS);
}

/**
 * CSRF for state-changing dashboard requests. The token is derived from the
 * session id and signed with the existing HMAC helper, so it needs no cookie and
 * cannot be minted without the session it protects.
 */
export async function csrfToken(sessionId: string, secret: string): Promise<string> {
	return hmacSign(`csrf:${sessionId}`, secret);
}

export async function verifyCsrf(request: Request, sessionId: string, secret: string, form: FormData): Promise<boolean> {
	const submitted = String(form.get('csrf') ?? '');
	if (!submitted) return false;
	return hmacVerify(`csrf:${sessionId}`, submitted, secret);
}

/** Resolve the caller's session, or null when they are not signed in. */
export async function getSessionUser(request: Request, env: Env): Promise<SessionUser | null> {
	const sessionId = readCookie(request, SESSION_COOKIE);
	if (!sessionId) return null;

	const row = await env.DB.prepare(
		`SELECT s.id AS session_id, s.created_at, s.last_used_at, u.github_id, u.login, u.avatar_url
     FROM sessions s JOIN users u ON u.github_id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now') AND s.created_at > datetime('now', ?)`,
	)
		.bind(sessionId, `-${SESSION_MAX_SECONDS} seconds`)
		.first<{
			session_id: string;
			created_at: string;
			last_used_at: string | null;
			github_id: number;
			login: string;
			avatar_url: string | null;
		}>();

	if (!row) return null;

	if (!row.last_used_at || Date.now() - Date.parse(`${row.last_used_at}Z`) > TOUCH_INTERVAL_MS) {
		// Sliding expiry: a session dies after 30 days of *not* being used, so
		// the stamp and the deadline move together.
		await env.DB.prepare(`UPDATE sessions SET last_used_at = datetime('now'), expires_at = datetime('now', ?) WHERE id = ?`)
			.bind(`+${SESSION_TTL_SECONDS} seconds`, sessionId)
			.run();
	}

	return {
		sessionId: row.session_id,
		githubId: row.github_id,
		login: row.login,
		avatarUrl: row.avatar_url,
		createdAt: row.created_at,
	};
}

/**
 * The role row written at sign-in is a snapshot: if it is removed on GitHub we
 * would never hear about it. Writes therefore require a session opened within
 * `STEP_UP_SECONDS`, which means a role that changed is picked up at the next
 * write rather than at the next 30-day expiry.
 */
export function sessionIsStale(user: SessionUser): boolean {
	const opened = Date.parse(`${user.createdAt.replace(' ', 'T')}Z`);
	return !Number.isFinite(opened) || Date.now() - opened > STEP_UP_SECONDS * 1000;
}

/** Send a stale-session write back through GitHub, returning to the same page. */
export function stepUpResponse(request: Request): Response {
	const url = new URL(request.url);
	const next = `${url.pathname}${url.search}`;
	return redirect(`/auth/github?next=${encodeURIComponent(next)}`);
}

async function createSession(env: Env, githubId: number): Promise<string> {
	const id = randomHex(32);
	const expiresAt = sqlTimestamp(new Date(Date.now() + SESSION_TTL_SECONDS * 1000));
	await env.DB.prepare(`INSERT INTO sessions (id, user_id, expires_at, last_used_at) VALUES (?, ?, ?, datetime('now'))`)
		.bind(id, githubId, expiresAt)
		.run();
	return id;
}

async function destroySession(env: Env, sessionId: string): Promise<void> {
	await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
}

/**
 * Only a same-origin absolute path: no scheme, no `//` host, no backslash
 * (browsers read `\` as `/`, so `/\evil.com` is an open redirect), no control
 * characters, and short enough to live in a cookie.
 */
export function safeNextPath(value: string | null | undefined): string | null {
	if (!value) return null;
	if (!value.startsWith('/') || value.startsWith('//')) return null;
	if (value.includes('\\') || value.length > 200) return null;
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return null; // header-splitting characters
	}
	return value;
}

interface GitHubUser {
	id: number;
	login: string;
	avatar_url: string | null;
}

/** Route handler for /auth/*, or null for anything else. */
export async function handleAuth(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith('/auth/')) return null;

	// 1) Start the round trip. The nonce is bound to this browser so a code
	//    delivered from another browser's flow is rejected.
	if (url.pathname === '/auth/github' && request.method === 'GET') {
		const ts = Date.now().toString();
		const nonce = randomHex(16);
		const payload = `${ts}.${nonce}`;
		const state = `${payload}.${await hmacSign(payload, env.SETUP_SIGNING_SECRET)}`;

		const redirectUrl = new URL('https://github.com/login/oauth/authorize');
		redirectUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
		redirectUrl.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
		redirectUrl.searchParams.set('scope', 'read:user');
		redirectUrl.searchParams.set('state', state);

		const res = redirect(redirectUrl.toString());
		res.headers.append('Set-Cookie', cookieHeader(request, NONCE_COOKIE, nonce, 600, '/auth'));
		const next = safeNextPath(url.searchParams.get('next'));
		if (next) {
			// Kept out of the state blob so a crafted state cannot choose the
			// destination; the cookie is written only by this route. Separate
			// headers, never one comma-joined value — browsers treat that as a
			// single cookie and drop the rest.
			res.headers.append('Set-Cookie', cookieHeader(request, NEXT_COOKIE, next, 600, '/auth'));
		}

		return res;
	}

	// 2) Callback: verify, exchange, upsert the user, snapshot installations,
	//    open a session. The GitHub token dies here.
	if (url.pathname === '/auth/callback' && request.method === 'GET') {
		const code = url.searchParams.get('code');
		const state = url.searchParams.get('state') ?? '';
		const [ts, nonce, signature] = state.split('.');
		const cookieNonce = readCookie(request, NONCE_COOKIE);

		if (!code || !ts || !nonce || !signature || !(await hmacVerify(`${ts}.${nonce}`, signature, env.SETUP_SIGNING_SECRET))) {
			return signInErrorPage('That sign-in link is not valid. Start again from the dashboard.', 400);
		}
		if (!cookieNonce || cookieNonce !== nonce) {
			return signInErrorPage('That sign-in link was started in a different browser.', 400);
		}
		if (Date.now() - Number.parseInt(ts, 10) > OAUTH_STATE_TTL_MS) {
			return signInErrorPage('That sign-in link expired. Start again.', 400);
		}

		const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				code,
			}),
		});

		let accessToken: string | undefined;
		try {
			({ access_token: accessToken } = (await tokenRes.json()) as { access_token?: string });
		} catch {
			return signInErrorPage("GitHub's response could not be read.", 502);
		}
		if (!accessToken) {
			return signInErrorPage('GitHub did not authorize this sign-in.', 400);
		}

		const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'alphapr' };

		const meRes = await fetch(`${GITHUB_API}/user`, { headers });
		if (!meRes.ok) {
			return signInErrorPage(`Could not read your GitHub account (${meRes.status}).`, 502);
		}
		const me = (await meRes.json()) as GitHubUser;

		const instRes = await fetch(`${GITHUB_API}/user/installations`, { headers });
		if (!instRes.ok) {
			return signInErrorPage(`Could not read your installations (${instRes.status}).`, 502);
		}
		const { installations } = (await instRes.json()) as { installations: RawInstallation[] };

		// Only installations this user can actually administer. GitHub's
		// /user/installations also lists installations where the user merely has
		// access to one repository — showing those would leak every other repo on
		// the account, so they are dropped here and never written.
		const authorized = await getAuthorizedInstallations(accessToken, installations);

		await env.DB.prepare(
			`INSERT INTO users (github_id, login, avatar_url, last_seen_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(github_id) DO UPDATE SET
         login = excluded.login,
         avatar_url = excluded.avatar_url,
         last_seen_at = datetime('now')`,
		)
			.bind(me.id, me.login, me.avatar_url)
			.run();

		// Replace the snapshot: an installation the user lost access to should
		// disappear, not linger from a previous sign-in.
		await env.DB.prepare(`DELETE FROM user_installations WHERE user_id = ?`).bind(me.id).run();
		for (const installation of authorized) {
			await env.DB.prepare(
				`INSERT OR IGNORE INTO user_installations (user_id, installation_id, account_login, account_type, role)
         VALUES (?, ?, ?, ?, ?)`,
			)
				.bind(me.id, installation.id, installation.account.login, installation.account.type, 'admin')
				.run();
		}

		// Explicitly invited teammates get a read-only row — but only for
		// installations GitHub still lists for them, so losing repo access on
		// GitHub removes the view on the next sign-in without this code having
		// to know anything about teams or repo permissions.
		const adminIds = new Set(authorized.map((installation) => installation.id));
		const invited = new Set(await invitedInstallations(env.DB, me.login));
		for (const installation of installations) {
			if (!invited.has(installation.id) || adminIds.has(installation.id)) continue;
			await env.DB.prepare(
				`INSERT OR IGNORE INTO user_installations (user_id, installation_id, account_login, account_type, role)
         VALUES (?, ?, ?, ?, ?)`,
			)
				.bind(me.id, installation.id, installation.account.login, installation.account.type, 'member')
				.run();
		}
		const sessionId = await createSession(env, me.id);

		const next = safeNextPath(readCookie(request, NEXT_COOKIE)) ?? '/dashboard';

		// Two cookies, two headers. Joining them with "; " makes the browser read
		// the second one's attributes as part of the first — which turned the
		// session cookie into a Max-Age=0 deletion and made sign-in look like a
		// page refresh.
		const response = new Response(null, { status: 302, headers: { Location: next } });
		response.headers.append('Set-Cookie', cookieHeader(request, SESSION_COOKIE, sessionId, SESSION_TTL_SECONDS));
		response.headers.append('Set-Cookie', clearCookie(request, NONCE_COOKIE, '/auth'));
		response.headers.append('Set-Cookie', clearCookie(request, NEXT_COOKIE, '/auth'));
		return response;
	}

	// 3) Sign out: delete the row, clear the cookie. Real revocation, not a
	//    cookie the browser might keep.
	if (url.pathname === '/auth/logout' && request.method === 'POST') {
		const user = await getSessionUser(request, env);
		if (!user) return redirect('/');

		const form = await request.formData();
		if (!(await verifyCsrf(request, user.sessionId, env.SETUP_SIGNING_SECRET, form))) {
			return signInErrorPage('That sign-out request could not be verified.', 400);
		}

		await destroySession(env, user.sessionId);
		return redirect('/', { 'Set-Cookie': clearCookie(request, SESSION_COOKIE) });
	}

	return new Response('not found', { status: 404 });
}

function signInErrorPage(message: string, status: number): Response {
	return htmlResponse(
		`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sign-in problem · AlphaPR</title>
    <meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 34rem; margin: 12vh auto; padding: 0 24px; line-height: 1.55;">
      <h1 style="font-size: 1.4rem;">Sign-in problem</h1>
      <p>${message.replace(/[<>&]/g, '')}</p>
      <p><a href="/dashboard">Back to the dashboard</a></p>
    </body></html>`,
		status,
	);
}
