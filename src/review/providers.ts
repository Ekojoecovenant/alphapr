import type { TokenUsage } from '../types';
import { Provider } from './provider-types';

export interface ChatRequest {
	model: string;
	systemPrompt: string;
	userMessages: { role: string; content: string }[];
	maxTokens: number;
	reasoningMaxTokens?: number;
}

export interface ChatResponse {
	content: string | null;
	finishReason: string | null;
	rawBody: string;
	/** Null when the provider omitted usage — never invented. */
	usage: TokenUsage | null;
}

/** Read `prompt_tokens`/`completion_tokens` (OpenRouter and OpenAI share this shape). */
function usageFromChatCompletions(data: { usage?: { prompt_tokens?: number; completion_tokens?: number } }): TokenUsage | null {
	const usage = data.usage;
	if (!usage) return null;

	const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
	const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
	if (inputTokens === null && outputTokens === null) return null;

	return { inputTokens, outputTokens };
}

/** Read `input_tokens`/`output_tokens` (Anthropic's naming). */
function usageFromAnthropic(data: { usage?: { input_tokens?: number; output_tokens?: number } }): TokenUsage | null {
	const usage = data.usage;
	if (!usage) return null;

	const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
	const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
	if (inputTokens === null && outputTokens === null) return null;

	return { inputTokens, outputTokens };
}

export type ChatResult = { ok: true; data: ChatResponse } | { ok: false; status: number; body: string };

export interface ProviderAdapter {
	call(apiKey: string, req: ChatRequest): Promise<ChatResult>;
	/**
	 * Whether this provider can honour a reasoning-token budget for `model`.
	 *
	 * Asked per-adapter, not globally, because support is both provider- and
	 * model-specific: OpenRouter proxies arbitrary upstreams (so the model id is
	 * the only signal), Anthropic gates extended thinking behind specific model
	 * generations (an unsupported model with a thinking block is a hard 400),
	 * and OpenAI's o-series needs a different request shape than this adapter
	 * sends.
	 *
	 * Returning false is always safe — the request just omits the budget.
	 */
	supportsReasoning(model: string): boolean;
}

export function getAdapter(provider: Provider): ProviderAdapter {
	switch (provider) {
		case 'openrouter':
			return openRouterAdapter;
		case 'anthropic':
			return anthropicAdapter;
		case 'openai':
			return openAIAdapter;
	}
}

/**
 * OpenRouter's reasoning-model detection.
 *
 * OpenRouter proxies arbitrary upstream providers, so the model id is the only
 * signal available about whether it supports a reasoning budget. Matched by
 * substring against the configured model string. Add new reasoning models
 * here — this is the only place that needs to change.
 *
 * TODO: replace with real capability detection via OpenRouter's /models
 * endpoint (`supported_parameters` includes "reasoning"), cached per model.
 */
const REASONING_MODEL_MARKERS = ['-pro', 'deepseek-v4-flash-0731', 'o1-', 'o3-'] as const;

export function modelSupportsReasoning(model: string): boolean {
	return REASONING_MODEL_MARKERS.some((marker) => model.includes(marker));
}

export const openRouterAdapter: ProviderAdapter = {
	supportsReasoning: modelSupportsReasoning,
	async call(apiKey, req) {
		const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			signal: AbortSignal.timeout(120_000),
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://github.com/Ekojoecovenant/alphapr',
				'X-Title': 'AlphaPR',
			},
			body: JSON.stringify({
				model: req.model,
				max_tokens: req.maxTokens,
				...(req.reasoningMaxTokens ? { reasoning: { max_tokens: req.reasoningMaxTokens } } : {}),
				provider: { sort: 'throughput', require_parameters: true },
				messages: [{ role: 'system', content: req.systemPrompt }, ...req.userMessages],
			}),
		});

		const rawBody = await res.text();
		if (!res.ok) return { ok: false, status: res.status, body: rawBody.replace(/\s+/g, ' ').slice(0, 300) };

		const data = JSON.parse(rawBody) as {
			choices?: { message?: { content?: string }; finish_reason?: string }[];
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		return {
			ok: true,
			data: {
				content: data.choices?.[0]?.message?.content ?? null,
				finishReason: data.choices?.[0]?.finish_reason ?? null,
				rawBody,
				usage: usageFromChatCompletions(data),
			},
		};
	},
};

/**
 * Claude models that accept an extended-thinking budget.
 *
 * Combining a `thinking` block with a model that does not support it is a hard
 * 400, so this defaults to false: a model missing from this list simply gets no
 * budget rather than a broken request. Add new thinking-capable generations here.
 */
const ANTHROPIC_REASONING_MODEL_MARKERS = [
	'claude-3-7',
	'claude-sonnet-4',
	'claude-opus-4',
	'claude-haiku-4',
	'claude-sonnet-5',
	'claude-opus-5',
	'claude-haiku-5',
] as const;

function anthropicSupportsReasoning(model: string): boolean {
	return ANTHROPIC_REASONING_MODEL_MARKERS.some((marker) => model.includes(marker));
}

/**
 * Anthropic Messages API version.
 *
 * `2023-06-01` is the version every older SDK sends; `2026-10-21` is the current
 * one. The migration only removes `temperature`/`top_p`/`top_k` and rejects
 * document/citation blocks this adapter never sends, so the request shape used
 * here (model, max_tokens, system, messages, thinking) is unchanged.
 */
const ANTHROPIC_VERSION = '2026-10-21';

// NOTE: implemented per Anthropic's documented API shape but not yet verified
// against a live request/response. Test before enabling for any real tenant.
export const anthropicAdapter: ProviderAdapter = {
	supportsReasoning: anthropicSupportsReasoning,
	async call(apiKey, req) {
		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			signal: AbortSignal.timeout(120_000),
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': ANTHROPIC_VERSION,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: req.model,
				max_tokens: req.maxTokens,
				system: req.systemPrompt,
				messages: req.userMessages,
				...(req.reasoningMaxTokens ? { thinking: { type: 'enabled', budget_tokens: req.reasoningMaxTokens } } : {}),
			}),
		});

		const rawBody = await res.text();
		if (!res.ok) return { ok: false, status: res.status, body: rawBody.replace(/\s+/g, ' ').slice(0, 300) };

		const data = JSON.parse(rawBody) as {
			content?: { type: string; text?: string }[];
			stop_reason?: string;
			usage?: { input_tokens?: number; output_tokens?: number };
		};
		const textBlock = data.content?.find((b) => b.type === 'text');
		return {
			ok: true,
			data: {
				content: textBlock?.text ?? null,
				finishReason: data.stop_reason ?? null,
				rawBody,
				usage: usageFromAnthropic(data),
			},
		};
	},
};

/**
 * OpenAI's o-series reasoning models (o1, o3, o4, …).
 *
 * Matched by prefix rather than by an explicit list because every oN generation
 * shares one request shape — but *only* oN: standard chat models reject both
 * `max_completion_tokens` and `reasoning_effort`.
 */
const OPENAI_REASONING_MODEL = /^o\d/;

function openAISupportsReasoning(model: string): boolean {
	return OPENAI_REASONING_MODEL.test(model);
}

/**
 * Map AlphaPR's reasoning-token budget onto OpenAI's coarse effort dial.
 *
 * There is no token-for-token translation: `reasoning_effort` is the only
 * control, so this is a deliberate approximation. A budget at or below 4k
 * (AlphaPR's default is 2k) means "think, but stay cheap" → `low`; raising the
 * budget past 4k/16k escalates the dial.
 */
function openAIReasoningEffort(budget: number): 'low' | 'medium' | 'high' {
	if (budget <= 4000) return 'low';
	if (budget <= 16000) return 'medium';
	return 'high';
}

/**
 * o-series models reject a `system` message (o1, o1-mini and o3-mini all 400 on
 * it), so the instructions are folded into the first user turn instead.
 */
function foldSystemPrompt(systemPrompt: string, messages: ChatRequest['userMessages']): ChatRequest['userMessages'] {
	const [first, ...rest] = messages;
	if (!first) return [{ role: 'user', content: systemPrompt }];
	return [{ ...first, content: `${systemPrompt}\n\n${first.content}` }, ...rest];
}

/**
 * NOTE: implemented per OpenAI's documented API shape but not yet verified
 * against a live request/response. Test before enabling for any real tenant.
 */
export const openAIAdapter: ProviderAdapter = {
	supportsReasoning: openAISupportsReasoning,
	async call(apiKey, req) {
		const isReasoningModel = openAISupportsReasoning(req.model);
		if (!isReasoningModel && req.reasoningMaxTokens) {
			console.warn(`openAIAdapter: reasoningMaxTokens was set but "${req.model}" is not an o-series reasoning model — ignoring`);
		}

		const body = isReasoningModel
			? {
					model: req.model,
					// o-series rejects `max_tokens`; the completion budget goes here.
					max_completion_tokens: req.maxTokens,
					...(req.reasoningMaxTokens ? { reasoning_effort: openAIReasoningEffort(req.reasoningMaxTokens) } : {}),
					messages: foldSystemPrompt(req.systemPrompt, req.userMessages),
				}
			: {
					model: req.model,
					max_tokens: req.maxTokens,
					messages: [{ role: 'system', content: req.systemPrompt }, ...req.userMessages],
				};

		const res = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			signal: AbortSignal.timeout(120_000),
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});

		const rawBody = await res.text();
		if (!res.ok) return { ok: false, status: res.status, body: rawBody.replace(/\s+/g, ' ').slice(0, 300) };

		const data = JSON.parse(rawBody) as {
			choices?: { message?: { content?: string }; finish_reason?: string }[];
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		return {
			ok: true,
			data: {
				content: data.choices?.[0]?.message?.content ?? null,
				finishReason: data.choices?.[0]?.finish_reason ?? null,
				rawBody,
				usage: usageFromChatCompletions(data),
			},
		};
	},
};
