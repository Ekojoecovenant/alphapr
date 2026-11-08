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
		};
		return {
			ok: true,
			data: {
				content: data.choices?.[0]?.message?.content ?? null,
				finishReason: data.choices?.[0]?.finish_reason ?? null,
				rawBody,
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
const ANTHROPIC_REASONING_MODEL_MARKERS = ['claude-3-7', 'claude-sonnet-4', 'claude-opus-4', 'claude-haiku-4'] as const;

function anthropicSupportsReasoning(model: string): boolean {
	return ANTHROPIC_REASONING_MODEL_MARKERS.some((marker) => model.includes(marker));
}

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
				'anthropic-version': '2023-06-01',
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
		};
		const textBlock = data.content?.find((b) => b.type === 'text');
		return {
			ok: true,
			data: {
				content: textBlock?.text ?? null,
				finishReason: data.stop_reason ?? null,
				rawBody,
			},
		};
	},
};

/**
 * NOTE: does not support OpenAI's reasoning models (o1/o3 series) — they use
 * a different request shape (max_completion_tokens, no `reasoning` field,
 * different message/temperature constraints). Only standard chat models
 * (gpt-4o, gpt-4o-mini, etc.) are supported by this adapter currently.
 *
 * NOTE: implemented per OpenAI's documented API shape but not yet verified
 * against a live request/response. Test before enabling for any real tenant.
 */
export const openAIAdapter: ProviderAdapter = {
	/**
	 * Always false: this adapter sends the standard chat-completions shape, which
	 * o-series reasoning models reject — they need `max_completion_tokens` and
	 * `reasoning_effort` instead of `max_tokens` and a reasoning budget. Flip this
	 * to a model check once that request path is implemented.
	 */
	supportsReasoning: () => false,
	async call(apiKey, req) {
		if (req.reasoningMaxTokens) {
			console.warn(
				'openAIAdapter: reasoningMaxTokens was set but is not supported by this adapter (o-series models not yet implemented) — ignoring',
			);
		}

		const res = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			signal: AbortSignal.timeout(120_000),
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: req.model,
				max_tokens: req.maxTokens,
				messages: [{ role: 'system', content: req.systemPrompt }, ...req.userMessages],
			}),
		});

		const rawBody = await res.text();
		if (!res.ok) return { ok: false, status: res.status, body: rawBody.replace(/\s+/g, ' ').slice(0, 300) };

		const data = JSON.parse(rawBody) as {
			choices?: { message?: { content?: string }; finish_reason?: string }[];
		};
		return {
			ok: true,
			data: {
				content: data.choices?.[0]?.message?.content ?? null,
				finishReason: data.choices?.[0]?.finish_reason ?? null,
				rawBody,
			},
		};
	},
};
