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
//   * an id matches only when it is the model itself or that model plus a
//     version suffix (`gpt-4o-mini-2024-07-18`, `…-latest`). A name that merely
//     *contains* a known model — a community fine-tune called
//     `gpt-4o-distill` — is a different product at a different price, so it is
//     not priced at all.

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

/** `openai/gpt-4o-mini` → `gpt-4o-mini`; a bare id is left alone. */
function withoutVendor(id: string): string {
	return id.replace(/^[a-z0-9._-]+\//, '');
}

const VERSION_SUFFIX = /^-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{6}|latest|preview|v\d+)$/;

/** Longest first, so `gpt-4o-mini` is tested before `gpt-4o`. Built once. */
const KNOWN_MODELS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** Null when the model is not in the table — the caller must not invent a price. */
export function priceFor(model: string | null): Price | null {
	if (!model) return null;
	const id = withoutVendor(model.toLowerCase().trim());
	for (const name of KNOWN_MODELS) {
		if (id === name) return PRICES[name] ?? null;
		if (id.startsWith(name) && VERSION_SUFFIX.test(id.slice(name.length))) return PRICES[name] ?? null;
	}
	return null;
}

/**
 * `null` when the model is unknown **or** either token count is missing. A
 * provider that reports one side and not the other did not tell us enough to
 * price the call, and costing the missing side as zero would understate the
 * bill with the same confidence as a complete figure.
 */
export function estimateCost(
	model: string | null,
	inputTokens: number | null | undefined,
	outputTokens: number | null | undefined,
): number | null {
	if (inputTokens == null || outputTokens == null) return null;
	const price = priceFor(model);
	if (!price) return null;
	return (inputTokens / 1_000_000) * price.inputPerMillion + (outputTokens / 1_000_000) * price.outputPerMillion;
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
