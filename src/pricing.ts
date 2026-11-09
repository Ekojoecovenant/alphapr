// What a review cost, in dollars (ADR 0002, P2).
//
// AlphaPR is BYOK: the user pays their provider directly, so this is an
// estimate of *their* bill, not of ours. It is deliberately a small static
// table rather than a lookup service — no network call belongs in a page
// render, and a wrong number is worse than no number.
//
// Rules:
//   * unknown model → null, and the page shows tokens only. Never guess.
//   * prices are list prices in USD per million tokens, recorded as of the date
//     below. They drift; the page says so instead of pretending otherwise.
//   * matching is by longest prefix, so `gpt-4o-mini` wins over `gpt-4o`.

export interface Price {
	/** USD per million input tokens. */
	inputPerMillion: number;
	/** USD per million output tokens. */
	outputPerMillion: number;
}

export const PRICING_AS_OF = '2026-11';

const PRICES: Record<string, Price> = {
	'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
	'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
	'claude-sonnet-4': { inputPerMillion: 3, outputPerMillion: 15 },
	'claude-opus-4': { inputPerMillion: 15, outputPerMillion: 75 },
};

/** Null when the model is not in the table — the caller must not invent a price. */
export function priceFor(model: string | null): Price | null {
	if (!model) return null;
	const key = model.toLowerCase();
	const candidates = Object.keys(PRICES)
		.filter((name) => key.includes(name))
		.sort((a, b) => b.length - a.length);
	const match = candidates[0];
	return match ? (PRICES[match] ?? null) : null;
}

/** `null` when either the model is unknown or the token counts are unknown. */
export function estimateCost(
	model: string | null,
	inputTokens: number | null | undefined,
	outputTokens: number | null | undefined,
): number | null {
	const price = priceFor(model);
	if (!price) return null;
	if (inputTokens == null && outputTokens == null) return null;
	const cost = ((inputTokens ?? 0) / 1_000_000) * price.inputPerMillion + ((outputTokens ?? 0) / 1_000_000) * price.outputPerMillion;
	return cost;
}

/**
 * `$1.42`, `$0.0180`, or `< $0.0001`. Small amounts keep enough digits to be
 * useful: a single review usually costs fractions of a cent.
 */
export function formatUsd(amount: number | null): string | null {
	if (amount == null || Number.isNaN(amount)) return null;
	if (amount === 0) return '$0';
	if (amount < 0.0001) return '< $0.0001';
	if (amount < 1) return `$${amount.toFixed(4)}`;
	if (amount < 100) return `$${amount.toFixed(2)}`;
	return `$${Math.round(amount).toLocaleString('en-US')}`;
}
