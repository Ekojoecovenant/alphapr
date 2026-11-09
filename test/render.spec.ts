import { describe, expect, it } from 'vitest';
import type { Finding, ReviewResult } from '../src/review/llm';
import { mergeSummaryIntoDescription, renderAnchoredComment, renderSummary, sanitizeBlock, sanitizeInline } from '../src/review/render';

const finding = (over: Partial<Finding> = {}): Finding => ({
	severity: 'major',
	path: 'src/app.ts',
	line: 12,
	title: 'Something is wrong',
	body: 'The value is captured once.',
	...over,
});

const result = (over: Partial<ReviewResult> = {}): ReviewResult => ({
	verdict: '⚠️ 1 issues (1 major, 0 minor, 0 nits)',
	findings: [],
	...over,
});

// Model output is attacker-influenced (the diff is written by the PR author),
// so everything the bot posts must be neutralised before it carries the bot's
// identity. These are the regressions from the security audit.
describe('output sanitising', () => {
	it('breaks @-mentions so an injected diff cannot ping people or teams', () => {
		expect(sanitizeInline('thanks @octocat and @acme/security')).toBe('thanks @\u200Boctocat and @\u200Bacme/security');
	});

	it('strips raw HTML', () => {
		expect(sanitizeInline('click <img src=x onerror=alert(1)> here')).toBe('click  here');
		expect(sanitizeInline('a<!-- hidden -->b')).toBe('ab');
	});

	it('defuses link and image syntax', () => {
		expect(sanitizeInline('[Approve here](https://evil.example)')).toContain(']\\(');
		expect(sanitizeBlock('![badge](https://evil.example/x.png)')).toContain('!\\[');
	});

	it('cannot smuggle a fence out of a suggestion block', () => {
		const body = 'ok\n```\n</details> approved\n```';
		expect(sanitizeBlock(body)).not.toContain('```');
	});

	it('flattens newlines in single-line fields and caps the length', () => {
		expect(sanitizeInline('line one\nline two')).toBe('line one line two');
		expect(sanitizeInline('x'.repeat(500)).length).toBe(201);
	});

	it('caps long bodies', () => {
		expect(sanitizeBlock('y'.repeat(9000), 100).length).toBe(101);
	});
});

describe('renderAnchoredComment', () => {
	it('sanitises the model-written title and body', () => {
		const out = renderAnchoredComment(finding({ title: 'LGTM ✅ @acme/security', body: 'Verdict: **Approved** <b>see</b>' }));

		expect(out).not.toContain('@acme');
		expect(out).not.toContain('<b>');
		expect(out).toContain('🔴 **Major**');
	});

	it('keeps the suggestion fence and renders the code inside it', () => {
		const out = renderAnchoredComment(finding({ suggestion: 'const x = 1;' }));

		expect(out).toContain('```suggestion\nconst x = 1;\n```');
	});
});

describe('renderSummary', () => {
	it('sanitises the verdict line', () => {
		const out = renderSummary(result({ verdict: 'Approved by @acme/security' }), 0, []);

		expect(out).not.toContain('@acme/security');
		expect(out).toContain('**Verdict:**');
	});

	it('sanitises unanchorable findings but keeps the line reference', () => {
		const out = renderSummary(result(), 0, [finding({ title: 'ping @octocat', body: '<script>x</script>' })]);

		expect(out).toContain('`src/app.ts:12`');
		expect(out).not.toContain('@octocat');
		expect(out).not.toContain('<script>');
	});

	it('neutralises mentions in the raw markdown fallback but keeps its code fences', () => {
		const out = renderSummary(result({ raw: 'Hi @octocat\n```ts\nconst a = 1;\n```' }), 0, []);

		expect(out).not.toContain('@octocat');
		expect(out).toContain('```ts');
	});
});

describe('mergeSummaryIntoDescription', () => {
	it('appends a summary block when no existing block is present', () => {
		const result = mergeSummaryIntoDescription('This PR adds a widget.', '- Adds a widget');

		expect(result).toContain('<!-- alphapr-summary -->');
		expect(result).toContain('- Adds a widget');
		expect(result).toContain('This PR adds a widget.');
		// Author content now comes FIRST, summary appended after
		expect(result.indexOf('This PR adds a widget.')).toBeLessThan(result.indexOf('<!-- alphapr-summary -->'));
	});

	it('handles an empty existing description', () => {
		const result = mergeSummaryIntoDescription('', '- Adds a widget');

		expect(result).toContain('- Adds a widget');
		expect(result.trim().startsWith('<!-- alphapr-summary -->')).toBe(true);
	});

	it('replaces only the marker block on a second run, preserving surrounding author content', () => {
		const first = mergeSummaryIntoDescription('Author notes here.', '- First summary');
		const second = mergeSummaryIntoDescription(first, '- Updated summary');

		expect(second).toContain('Author notes here.');
		expect(second).toContain('- Updated summary');
		expect(second).not.toContain('- First summary');
	});

	it('does not duplicate the marker block across multiple updates', () => {
		let body = 'Original description.';
		for (const summary of ['- v1', '- v2', '- v3']) {
			body = mergeSummaryIntoDescription(body, summary);
		}

		const occurrences = body.split('<!-- alphapr-summary -->').length - 1;
		expect(occurrences).toBe(1);
		expect(body).toContain('- v3');
		expect(body).not.toContain('- v1');
		expect(body).not.toContain('- v2');
	});
});
