/**
 * Decide whether a PR should be skipped by the review pipeline.
 *
 * A PR is skipped when its title contains the literal marker "[skip alphapr]"
 * (case-insensitive) anywhere in the string. The marker must appear as its own
 * token — a lookalike like "[skip alphapr-please]" does NOT match, because the
 * closing bracket is not immediately after "alphapr".
 */
export function shouldSkipReview(title: string): boolean {
	return title.toLowerCase().includes('[skip alphapr]');
}
