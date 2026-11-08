import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../src/review/provider-types';
import { configFormPage, errorPage, landingPage, noInstallationsPage, successPage } from '../src/setup-pages';

const base = {
	installationOptions: '<option value="1">acme (1)</option>',
	currentProvider: 'openrouter',
	currentModel: 'deepseek/deepseek-v4-flash',
	currentSeverity: 'all',
	currentTone: 'thorough',
	currentIgnorePaths: '',
	formToken: 'payload.sig',
};

/** The provider <select> block, whatever attributes the element carries. */
function providerSelect(html: string): string {
	return html.match(/<select[^>]*name="provider"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
}

/** The provider values the form actually offers, in document order. */
function providerOptionValues(html: string): string[] {
	return [...providerSelect(html).matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

describe('configFormPage — provider selection', () => {
	it('renders every declared provider as an option (exhaustiveness)', () => {
		// Adding a provider to the union without exposing it in the setup form would
		// make it unreachable for tenants, even though the backend accepts it.
		expect(providerOptionValues(configFormPage(base))).toEqual([...PROVIDERS]);
	});

	it('pre-selects OpenRouter by default', () => {
		const html = configFormPage(base);

		expect(html).toContain('<option value="openrouter" selected>');
		expect(html).not.toContain('<option value="anthropic" selected>');
	});

	it('pre-selects the provider the installation already saved', () => {
		const html = configFormPage({ ...base, currentProvider: 'anthropic' });

		expect(html).toContain('<option value="anthropic" selected>');
		expect(html).not.toContain('<option value="openrouter" selected>');
	});

	it('selects exactly one provider, and nothing when the stored value is unknown', () => {
		const known = providerSelect(configFormPage({ ...base, currentProvider: 'anthropic' }));
		expect(known.match(/selected/g)?.length).toBe(1);

		// A provider removed from the union (or a hand-edited row) must not select
		// two options at once — the browser would otherwise pick the last one.
		const unknown = providerSelect(configFormPage({ ...base, currentProvider: 'gone' }));
		expect(unknown.match(/selected/g)).toBeNull();
		expect(unknown).toContain('<option value="openrouter"');
	});

	it('keeps the chosen provider for the save request', () => {
		const html = configFormPage({ ...base, currentProvider: 'openai' });

		// The select must live inside the form that posts to /setup/save.
		const form = html.match(/<form method="POST" action="\/setup\/save">[\s\S]*?<\/form>/)?.[0] ?? '';
		expect(form).toContain('name="provider"');
		expect(form).toContain('<option value="openai" selected>');
	});

	it('keeps the unverified warning next to the provider field', () => {
		const html = configFormPage(base);

		expect(html).toContain('have not been tested against live APIs');
	});
});

describe('configFormPage — the save path still works', () => {
	it('posts every field src/setup.ts reads, and the signed token', () => {
		const html = configFormPage(base);
		const form = html.match(/<form method="POST" action="\/setup\/save">[\s\S]*?<\/form>/)?.[0] ?? '';

		for (const name of ['installationId', 'provider', 'apiKey', 'model', 'severityThreshold', 'reviewTone', 'ignorePaths']) {
			expect(form).toContain(`name="${name}"`);
		}
		expect(form).toContain(`<input type="hidden" name="token" value="payload.sig">`);
		expect(form).toContain('<button class="btn btn-primary" type="submit">');
	});

	it('escapes the values it round-trips', () => {
		const html = configFormPage({ ...base, currentModel: '"><script>alert(1)</script>', currentIgnorePaths: "a'b" });

		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('a&#39;b');
	});

	it('labels every control with a matching id', () => {
		const html = configFormPage(base);
		const labels = [...html.matchAll(/<label for="([^"]+)">/g)].map((m) => m[1]);
		const controls = [...html.matchAll(/<(?:select|input)[^>]*id="([^"]+)"[^>]*name="([^"]+)"/g)].map((m) => m[1]);

		expect(labels.sort()).toEqual(controls.sort());
	});
});

describe('Split Signal shell', () => {
	it('ships both themes as custom properties and one data-theme switch', () => {
		const html = landingPage();

		expect(html).toContain(':root {');
		expect(html).toContain('--paper: #ffffff');
		expect(html).toContain('--brand: #0f766e');
		expect(html).toContain('--accent: #ff5c00');
		expect(html).toContain('[data-theme="dark"] {');
		expect(html).toContain('--paper: #0d1112');
		expect(html).toContain('--brand: #3acbb9');
	});

	it('resolves the theme before first paint and exposes a toggle', () => {
		const html = landingPage();

		// The boot script runs in <head>, before the body paints.
		expect(html.indexOf("localStorage.getItem('alphapr-theme')")).toBeLessThan(html.indexOf('<body>'));
		expect(html).toContain("setAttribute('data-theme'");
		expect(html).toContain('<button class="theme-toggle" id="themeToggle" type="button" aria-pressed="false"');
		expect(html).toContain('aria-label="Toggle theme"');
	});

	it('stays usable without JavaScript and without the CDN', () => {
		const landing = landingPage();

		// The static fallback is in the markup, not injected by script.
		expect(landing).toContain('class="scene-fallback"');
		expect(landing).toContain('data-scene="fallback"');
		expect(landing).toContain('Skip to content');
		expect(landing).toContain('<main id="main">');
	});

	it('only pulls three.js on the landing page', () => {
		expect(landingPage()).toContain('unpkg.com/three@0.160.0/build/three.min.js');
		expect(configFormPage(base)).not.toContain('unpkg.com/three');
		expect(successPage('acme', 1)).not.toContain('unpkg.com/three');
		expect(errorPage('nope')).not.toContain('unpkg.com/three');
		expect(noInstallationsPage()).not.toContain('unpkg.com/three');
	});
});

describe('landingPage — sample review demo', () => {
	it('keeps the Apply button out of any form and as a real button', () => {
		const html = landingPage();

		expect(html).toContain('<button class="apply" id="applySuggestion" type="button" aria-pressed="false">');
		expect(html).not.toMatch(/<form[\s\S]*applySuggestion/);
		expect(html).toContain('id="applyLive" aria-live="polite"');
	});

	it('anchors the sample finding to the line it talks about', () => {
		const html = landingPage();

		expect(html).toContain('src/auth/session.ts');
		expect(html).toContain('L42–L47');
		expect(html).toContain('major · correctness');
		expect(html).toContain('Suggested change');
	});
});

describe('simple pages', () => {
	it('escapes an error message and offers a way back', () => {
		const html = errorPage('<b>bad</b>');

		expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
		expect(html).toContain('href="/setup"');
	});

	it('drops the retry link when the caller passes showRetry: false', () => {
		expect(errorPage('nope', { showRetry: false })).not.toContain('href="/setup">Start over');
	});

	it('tells the truth on the success and no-installation pages', () => {
		expect(successPage('acme', 42)).toContain('<dd>42</dd>');
		expect(noInstallationsPage()).toContain('github.com/apps/alphapr-ai');
	});
});
