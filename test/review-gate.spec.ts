import { describe, expect, it } from 'vitest';
import { decideReview, isAlreadyReviewed, isReviewAction, REVIEW_ACTIONS } from '../src/review-gate';

const HEAD = 'abc123def456';

function gate(overrides: Partial<Parameters<typeof decideReview>[0]> = {}) {
	return decideReview({
		draft: false,
		title: 'feat: add a thing',
		headSha: HEAD,
		lastReviewedSha: null,
		...overrides,
	});
}

describe('isReviewAction', () => {
	it('accepts every action the pipeline handles', () => {
		for (const action of REVIEW_ACTIONS) {
			expect(isReviewAction(action)).toBe(true);
		}
	});

	it('rejects actions that must not trigger a review', () => {
		// `edited` deliberately absent: a title edit is not a code change.
		expect(isReviewAction('edited')).toBe(false);
		expect(isReviewAction('closed')).toBe(false);
		expect(isReviewAction('reopened')).toBe(false);
		expect(isReviewAction('')).toBe(false);
	});
});

describe('isAlreadyReviewed', () => {
	it('is true only for an exact commit match', () => {
		expect(isAlreadyReviewed(HEAD, HEAD)).toBe(true);
		expect(isAlreadyReviewed('different', HEAD)).toBe(false);
	});

	it('is false when this PR has never been reviewed', () => {
		expect(isAlreadyReviewed(null, HEAD)).toBe(false);
		expect(isAlreadyReviewed(undefined, HEAD)).toBe(false);
	});
});

describe('decideReview', () => {
	it('runs a review for a normal, new, non-draft PR', () => {
		expect(gate()).toEqual({ run: true });
	});

	it('runs a review when the head commit differs from the last reviewed one', () => {
		expect(gate({ lastReviewedSha: 'older-sha' })).toEqual({ run: true });
	});

	it('skips a draft PR', () => {
		expect(gate({ draft: true })).toEqual({ run: false, reason: 'draft' });
	});

	it('does not treat an undefined draft flag as a draft', () => {
		// Older payloads and some API shapes omit `draft` entirely.
		expect(gate({ draft: undefined })).toEqual({ run: true });
	});

	it('skips a PR whose title carries the skip marker', () => {
		expect(gate({ title: 'WIP [skip alphapr]' })).toEqual({ run: false, reason: 'skip-marker' });
	});

	it('skips a commit that has already been reviewed', () => {
		expect(gate({ lastReviewedSha: HEAD })).toEqual({ run: false, reason: 'already-reviewed' });
	});

	it('reports draft ahead of the skip marker, so the most fixable reason wins', () => {
		expect(gate({ draft: true, title: 'WIP [skip alphapr]' })).toEqual({ run: false, reason: 'draft' });
	});

	it('reports the skip marker ahead of an already-reviewed commit', () => {
		const decision = gate({ title: '[skip alphapr] whatever', lastReviewedSha: HEAD });
		expect(decision).toEqual({ run: false, reason: 'skip-marker' });
	});
});
