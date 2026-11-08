import { describe, expect, it } from 'vitest';
import { formatUsage, totalTokens } from '../src/review/usage';

describe('totalTokens', () => {
	it('adds both sides of the call', () => {
		expect(totalTokens({ inputTokens: 900, outputTokens: 100 })).toBe(1000);
	});

	it('counts a side the provider omitted as zero', () => {
		expect(totalTokens({ inputTokens: 500, outputTokens: null })).toBe(500);
		expect(totalTokens({ inputTokens: null, outputTokens: 250 })).toBe(250);
	});

	it('returns 0 when there is no usage at all', () => {
		expect(totalTokens(null)).toBe(0);
		expect(totalTokens(undefined)).toBe(0);
		expect(totalTokens({ inputTokens: null, outputTokens: null })).toBe(0);
	});
});

describe('formatUsage', () => {
	it('formats with thousands separators', () => {
		expect(formatUsage({ inputTokens: 12000, outputTokens: 431 })).toBe('12,431 tokens');
	});

	it('formats a four-digit total with a separator too', () => {
		expect(formatUsage({ inputTokens: 900, outputTokens: 100 })).toBe('1,000 tokens');
	});

	it('returns null rather than inventing a cost line when nothing was reported', () => {
		// Showing "0 tokens" would be a lie the reader cannot distinguish from a
		// free review; no line at all is the honest answer.
		expect(formatUsage(null)).toBeNull();
		expect(formatUsage({ inputTokens: null, outputTokens: null })).toBeNull();
		expect(formatUsage({ inputTokens: 0, outputTokens: 0 })).toBeNull();
	});
});
