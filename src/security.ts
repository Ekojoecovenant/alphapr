// Security headers for every HTML page this worker serves (audit finding f).
//
// The pages are self-contained: inline styles, inline scripts, one Google Fonts
// stylesheet and (on the landing page only) three.js from a CDN. A CSP that
// allows exactly that still blocks the thing that matters — instructions from a
// page to load and run code from anywhere else.

export interface CspOptions {
	/** Extra script origins, e.g. the three.js CDN. Inline scripts are always allowed. */
	scripts?: string[];
	/** Extra `connect-src` origins. */
	connect?: string[];
}

const BASE = [
	"default-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"object-src 'none'",
	"img-src 'self' data:",
	"font-src 'self' https://fonts.gstatic.com",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"manifest-src 'self'",
];

/**
 * `'unsafe-inline'` for scripts is unavoidable while the theme boot script and the
 * page script are inline (they must run before paint). It is still worth having:
 * the directive that stops a compromised dependency from exfiltrating a session
 * is `script-src`'s origin list, and that list is `'self'` plus whatever the page
 * genuinely loads.
 */
export function contentSecurityPolicy(options: CspOptions = {}): string {
	const scripts = ["'self'", "'unsafe-inline'", ...(options.scripts ?? [])].join(' ');
	const connect = ["'self'", ...(options.connect ?? [])].join(' ');
	return [...BASE, `script-src ${scripts}`, `connect-src ${connect}`].join('; ');
}

export interface HtmlHeaderOptions {
	csp?: CspOptions;
	/** Defaults to `no-store`: every page here reflects a signed-in, per-tenant view. */
	cacheControl?: string;
}

export function htmlHeaders(options: HtmlHeaderOptions = {}): Record<string, string> {
	return {
		'Content-Type': 'text/html; charset=utf-8',
		'Content-Security-Policy': contentSecurityPolicy(options.csp),
		'Cache-Control': options.cacheControl ?? 'no-store',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
		'Referrer-Policy': 'no-referrer',
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Cross-Origin-Resource-Policy': 'same-origin',
		'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
	};
}

export const THREE_CDN_ORIGIN = 'https://unpkg.com';
