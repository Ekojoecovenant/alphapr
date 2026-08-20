import { describe, expect, it } from 'vitest';
import { shouldSkipReview } from '../src/skip-review';

describe('shouldSkipReview', () => {
	it('matches the exact marker', () => {
		expect(shouldSkipReview('[skip alphapr]')).toBe(true);
	});

	it('matches case-insensitively', () => {
		expect(shouldSkipReview('[SKIP ALPHAPR]')).toBe(true);
		expect(shouldSkipReview('[Skip AlphaPr]')).toBe(true);
		expect(shouldSkipReview('sKiP aLpHaPr')).toBe(false); // brackets are part of the marker
	});

	it('matches when the marker is surrounded by other text', () => {
		expect(shouldSkipReview('WIP: fix login flow [skip alphapr]')).toBe(true);
		expect(shouldSkipReview('[skip alphapr] do not review')).toBe(true);
		expect(shouldSkipReview('fix: auth regression — [SKIP ALPHAPR] — see notes')).toBe(true);
	});

	it('does not match when the marker is absent', () => {
		expect(shouldSkipReview('fix: improve login flow')).toBe(false);
		expect(shouldSkipReview('skip alphapr without brackets')).toBe(false);
	});

	it('does not match an empty string', () => {
		expect(shouldSkipReview('')).toBe(false);
	});

	it('does not match the marker as a substring of a longer word', () => {
		// "[skip alphapr-please]" is a deliberately document decision: the literal
		// marker requires the closing bracket immediately after "alphapr", so a longer
		// token must not trigger a skip.
		expect(shouldSkipReview('[skip alphapr-please]')).toBe(false);
		expect(shouldSkipReview('[skip alphapreview]')).toBe(false);
	});
});
