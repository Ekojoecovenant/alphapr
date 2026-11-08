import type { TokenUsage } from '../types';

/** Total tokens across both sides of a call, or 0 when nothing was reported. */
export function totalTokens(usage: TokenUsage | null | undefined): number {
	if (!usage) return 0;
	return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/**
 * Human-readable token count, e.g. "12,431 tokens".
 *
 * Returns null when the provider reported nothing — a cost line invented from
 * a zero would be worse than showing no cost line at all.
 */
export function formatUsage(usage: TokenUsage | null | undefined): string | null {
	const total = totalTokens(usage);
	if (total <= 0) return null;
	return `${total.toLocaleString('en-US')} tokens`;
}
