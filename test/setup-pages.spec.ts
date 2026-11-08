import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../src/review/provider-types';
import { configFormPage } from '../src/setup-pages';

const base = {
	installationOptions: '<option value="1">acme (1)</option>',
	currentProvider: 'openrouter',
	currentModel: 'deepseek/deepseek-v4-flash',
	currentSeverity: 'all',
	currentTone: 'thorough',
	currentIgnorePaths: '',
	formToken: 'payload.sig',
};

/** The provider values the form actually offers, in document order. */
function providerOptionValues(html: string): string[] {
	const select = html.match(/<select name="provider">([\s\S]*?)<\/select>/)?.[1] ?? '';
	return [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
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
		const known =
			configFormPage({ ...base, currentProvider: 'anthropic' }).match(/<select name="provider">([\s\S]*?)<\/select>/)?.[1] ?? '';
		expect(known.match(/selected/g)?.length).toBe(1);

		// A provider removed from the union (or a hand-edited row) must not select
		// two options at once — the browser would otherwise pick the last one.
		const unknown = configFormPage({ ...base, currentProvider: 'gone' }).match(/<select name="provider">([\s\S]*?)<\/select>/)?.[1] ?? '';
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
