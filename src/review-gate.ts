import { shouldSkipReview } from './skip-review';
import type { ReviewAction } from './types';

/** Pull-request actions the review pipeline reacts to. */
export const REVIEW_ACTIONS: readonly ReviewAction[] = ['opened', 'synchronize', 'ready_for_review'];

export function isReviewAction(action: string): action is ReviewAction {
	return (REVIEW_ACTIONS as readonly string[]).includes(action);
}

/** Why a pull request was not reviewed. Used for logging — never shown to users. */
export type SkipReason = 'draft' | 'skip-marker' | 'already-reviewed';

export type ReviewGateDecision = { run: true } | { run: false; reason: SkipReason };

/**
 * Whether this exact commit has already been reviewed for this PR.
 *
 * GitHub can deliver the same webhook more than once, and two deliveries
 * arriving close together can both be dispatched before either review has
 * finished. Re-reviewing an identical commit costs a full LLM call and posts
 * duplicate comments, so it is refused.
 */
export function isAlreadyReviewed(lastReviewedSha: string | null | undefined, headSha: string): boolean {
	return lastReviewedSha === headSha;
}

/**
 * Decide whether a pull-request event should start a review.
 *
 * Every reason to skip is checked *before* any GitHub API call or LLM spend —
 * a skipped event costs nothing. Order matters only for the log: a draft that
 * also carries the skip marker reports "draft", which is the more specific,
 * more fixable reason.
 */
export function decideReview(input: {
	draft: boolean | undefined;
	title: string;
	headSha: string;
	lastReviewedSha: string | null;
}): ReviewGateDecision {
	if (input.draft === true) {
		return { run: false, reason: 'draft' };
	}
	if (shouldSkipReview(input.title)) {
		return { run: false, reason: 'skip-marker' };
	}
	if (isAlreadyReviewed(input.lastReviewedSha, input.headSha)) {
		return { run: false, reason: 'already-reviewed' };
	}
	return { run: true };
}
