/**
 * Contract tests for the provider adapters.
 *
 * These pin the WIRE FORMAT each adapter sends and the response shape it
 * accepts — the exact things that break in production and that no amount of
 * unit-testing the rest of the pipeline would catch. They do not hit a live
 * API: `fetch` is stubbed and the request body is asserted against each
 * provider's documented contract.
 *
 * Treat a failure here as "the request we send no longer matches the API we
 * claim to speak" — not as a flaky test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, parseProvider } from '../src/review/provider-types';
import {
	anthropicAdapter,
	type ChatRequest,
	getAdapter,
	modelSupportsReasoning,
	openAIAdapter,
	openRouterAdapter,
} from '../src/review/providers';

/** The subset of each provider's request body these tests assert on. */
interface CapturedBody {
	model?: string;
	max_tokens?: number;
	system?: string;
	messages?: { role: string; content: string }[];
	reasoning?: { max_tokens: number };
	thinking?: { type: string; budget_tokens: number };
	provider?: { sort?: string; require_parameters?: boolean };
}

interface CapturedRequest {
	url: string;
	method: string | undefined;
	headers: Record<string, string>;
	body: CapturedBody;
	signal: AbortSignal | null | undefined;
}

/** Stub globalThis.fetch, returning the adapter's outbound request for assertions. */
function stubFetch(response: Response) {
	let captured: CapturedRequest | undefined;

	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.body === undefined || init.body === null) {
			throw new Error('adapter sent no request body');
		}
		captured = {
			url: String(input),
			method: init.method,
			headers: (init.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init.body)) as CapturedBody,
			signal: init.signal,
		};
		return response;
	});

	vi.stubGlobal('fetch', fetchMock);

	return {
		fetchMock,
		request: (): CapturedRequest => {
			if (!captured) throw new Error('fetch was never called');
			return captured;
		},
	};
}

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
	return {
		model: 'test-model',
		systemPrompt: 'SYSTEM',
		userMessages: [{ role: 'user', content: 'USER' }],
		maxTokens: 1000,
		...overrides,
	};
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status });
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('getAdapter', () => {
	it('returns the OpenRouter adapter for "openrouter"', () => {
		expect(getAdapter('openrouter')).toBe(openRouterAdapter);
	});

	it('returns the Anthropic adapter for "anthropic"', () => {
		expect(getAdapter('anthropic')).toBe(anthropicAdapter);
	});

	it('returns the OpenAI adapter for "openai"', () => {
		expect(getAdapter('openai')).toBe(openAIAdapter);
	});

	it('has an adapter for every declared provider (exhaustiveness)', () => {
		for (const provider of PROVIDERS) {
			expect(typeof getAdapter(provider).call).toBe('function');
		}
	});
});

describe('parseProvider', () => {
	it('passes through every known provider unchanged', () => {
		for (const provider of PROVIDERS) {
			expect(parseProvider(provider)).toBe(provider);
		}
	});

	it('falls back to openrouter and warns loudly for an unrecognized value', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		expect(parseProvider('anthopic')).toBe('openrouter');
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('anthopic'));
	});

	it('falls back to openrouter for an empty string', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		expect(parseProvider('')).toBe('openrouter');
		expect(warnSpy).toHaveBeenCalled();
	});
});

describe('modelSupportsReasoning', () => {
	it('detects the known reasoning-model markers', () => {
		expect(modelSupportsReasoning('deepseek/deepseek-v4-pro')).toBe(true);
		expect(modelSupportsReasoning('deepseek-v4-flash-0731')).toBe(true);
		expect(modelSupportsReasoning('openai/o1-preview')).toBe(true);
		expect(modelSupportsReasoning('o3-mini')).toBe(true);
	});

	it('returns false for standard chat models', () => {
		expect(modelSupportsReasoning('deepseek/deepseek-v4-flash')).toBe(false);
		expect(modelSupportsReasoning('gpt-4o')).toBe(false);
		expect(modelSupportsReasoning('anthropic/claude-sonnet-4-5')).toBe(false);
	});
});

describe('openRouterAdapter', () => {
	it('posts to the OpenRouter chat completions endpoint', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openRouterAdapter.call('key-123', makeRequest());

		const { url, method } = request();
		expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
		expect(method).toBe('POST');
	});

	it('authenticates with a bearer token and identifies AlphaPR', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openRouterAdapter.call('key-123', makeRequest());

		const { headers } = request();
		expect(headers.Authorization).toBe('Bearer key-123');
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['HTTP-Referer']).toBe('https://github.com/Ekojoecovenant/alphapr');
		expect(headers['X-Title']).toBe('AlphaPR');
	});

	it('sends the system prompt as the first message', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openRouterAdapter.call('key-123', makeRequest());

		const { body } = request();
		expect(body.messages).toEqual([
			{ role: 'system', content: 'SYSTEM' },
			{ role: 'user', content: 'USER' },
		]);
		expect(body.model).toBe('test-model');
		expect(body.max_tokens).toBe(1000);
	});

	it('asks for a throughput-sorted provider that honors the requested parameters', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openRouterAdapter.call('key-123', makeRequest());

		expect(request().body.provider).toEqual({ sort: 'throughput', require_parameters: true });
	});

	it('omits the reasoning field when no reasoning budget is set', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openRouterAdapter.call('key-123', makeRequest());

		expect(request().body.reasoning).toBeUndefined();
	});

	it('sends reasoning.max_tokens when a reasoning budget is set', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openRouterAdapter.call('key-123', makeRequest({ reasoningMaxTokens: 2000 }));

		expect(request().body.reasoning).toEqual({ max_tokens: 2000 });
	});

	it('attaches a timeout signal so a hung provider cannot stall the queue', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openRouterAdapter.call('key-123', makeRequest());

		const { signal } = request();
		expect(signal).toBeDefined();
		expect(signal?.aborted).toBe(false);
	});

	it('parses content and finish_reason from the first choice', async () => {
		stubFetch(
			jsonResponse({
				choices: [{ message: { content: 'the review' }, finish_reason: 'stop' }],
			}),
		);

		const result = await openRouterAdapter.call('key-123', makeRequest());

		expect(result).toEqual({
			ok: true,
			data: { content: 'the review', finishReason: 'stop', rawBody: expect.any(String) },
		});
	});

	it('returns null fields when the response has no choices', async () => {
		stubFetch(jsonResponse({}));

		const result = await openRouterAdapter.call('key-123', makeRequest());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.content).toBeNull();
			expect(result.data.finishReason).toBeNull();
		}
	});

	it('returns ok:false with the status and a truncated body on a non-2xx response', async () => {
		stubFetch(new Response('x'.repeat(400), { status: 429 }));

		const result = await openRouterAdapter.call('key-123', makeRequest());

		expect(result).toEqual({ ok: false, status: 429, body: 'x'.repeat(300) });
	});

	it('collapses whitespace in the error body so diagnostics are not wasted on blank lines', async () => {
		stubFetch(new Response('first line\n\n\nsecond line', { status: 500 }));

		const result = await openRouterAdapter.call('key-123', makeRequest());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.body).toBe('first line second line');
			expect(result.body).not.toContain('\n');
		}
	});
});

describe('anthropicAdapter', () => {
	it('posts to the Anthropic messages endpoint with Anthropic auth headers', async () => {
		const { request } = stubFetch(jsonResponse({ content: [] }));
		await anthropicAdapter.call('sk-ant-123', makeRequest());

		const { url, method, headers } = request();
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		expect(method).toBe('POST');
		expect(headers['x-api-key']).toBe('sk-ant-123');
		expect(headers['anthropic-version']).toBe('2023-06-01');
		expect(headers['Content-Type']).toBe('application/json');
		// Anthropic rejects a Bearer token — it must not be sent.
		expect(headers.Authorization).toBeUndefined();
	});

	it('sends the system prompt at the TOP LEVEL, never as a message (regression)', async () => {
		const { request } = stubFetch(jsonResponse({ content: [] }));
		await anthropicAdapter.call('sk-ant-123', makeRequest());

		const { body } = request();
		expect(body.system).toBe('SYSTEM');
		// The classic bug: leaking the system prompt into `messages` as
		// { role: 'system' }, which Anthropic answers with a 400.
		expect(body.messages).toEqual([{ role: 'user', content: 'USER' }]);
		expect(body.messages?.some((m) => m.role === 'system')).toBe(false);
		expect(body.model).toBe('test-model');
		expect(body.max_tokens).toBe(1000);
	});

	it('omits thinking when no reasoning budget is set', async () => {
		const { request } = stubFetch(jsonResponse({ content: [] }));
		await anthropicAdapter.call('sk-ant-123', makeRequest());

		expect(request().body.thinking).toBeUndefined();
	});

	it('enables thinking with the requested budget when a reasoning budget is set', async () => {
		const { request } = stubFetch(jsonResponse({ content: [] }));
		await anthropicAdapter.call('sk-ant-123', makeRequest({ reasoningMaxTokens: 2000 }));

		expect(request().body.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
	});

	it('attaches a timeout signal so a hung provider cannot stall the queue', async () => {
		const { request } = stubFetch(jsonResponse({ content: [] }));
		await anthropicAdapter.call('sk-ant-123', makeRequest());

		const { signal } = request();
		expect(signal).toBeDefined();
		expect(signal?.aborted).toBe(false);
	});

	it('extracts the text block and maps stop_reason to finishReason', async () => {
		stubFetch(
			jsonResponse({
				content: [{ type: 'text', text: 'the review' }],
				stop_reason: 'end_turn',
			}),
		);

		const result = await anthropicAdapter.call('sk-ant-123', makeRequest());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.content).toBe('the review');
			expect(result.data.finishReason).toBe('end_turn');
		}
	});

	it('skips non-text blocks such as thinking', async () => {
		stubFetch(
			jsonResponse({
				content: [
					{ type: 'thinking', text: 'internal monologue' },
					{ type: 'text', text: 'the review' },
				],
				stop_reason: 'end_turn',
			}),
		);

		const result = await anthropicAdapter.call('sk-ant-123', makeRequest());

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.content).toBe('the review');
	});

	it('returns null content when there is no text block', async () => {
		stubFetch(jsonResponse({ content: [{ type: 'thinking', text: 'only thoughts' }], stop_reason: 'max_tokens' }));

		const result = await anthropicAdapter.call('sk-ant-123', makeRequest());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.content).toBeNull();
			expect(result.data.finishReason).toBe('max_tokens');
		}
	});

	it('returns ok:false with a collapsed, truncated body on a non-2xx response', async () => {
		stubFetch(new Response(`{\n  "error": "${'x'.repeat(400)}"\n}`, { status: 400 }));

		const result = await anthropicAdapter.call('sk-ant-123', makeRequest());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(400);
			expect(result.body.length).toBe(300);
			expect(result.body).not.toContain('\n');
			expect(result.body.startsWith('{ "error": "')).toBe(true);
		}
	});
});

describe('openAIAdapter', () => {
	it('posts to the OpenAI chat completions endpoint with a bearer token', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openAIAdapter.call('sk-openai-123', makeRequest());

		const { url, method, headers } = request();
		expect(url).toBe('https://api.openai.com/v1/chat/completions');
		expect(method).toBe('POST');
		expect(headers.Authorization).toBe('Bearer sk-openai-123');
		expect(headers['Content-Type']).toBe('application/json');
	});

	it('sends the system prompt as the first message', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openAIAdapter.call('sk-openai-123', makeRequest());

		const { body } = request();
		expect(body.messages).toEqual([
			{ role: 'system', content: 'SYSTEM' },
			{ role: 'user', content: 'USER' },
		]);
		expect(body.model).toBe('test-model');
		expect(body.max_tokens).toBe(1000);
	});

	it('never sends reasoning or thinking fields', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openAIAdapter.call('sk-openai-123', makeRequest({ reasoningMaxTokens: 2000 }));

		const { body } = request();
		expect(body.reasoning).toBeUndefined();
		expect(body.thinking).toBeUndefined();
	});

	it('attaches a timeout signal so a hung provider cannot stall the queue', async () => {
		const { request } = stubFetch(jsonResponse({ choices: [] }));
		await openAIAdapter.call('sk-openai-123', makeRequest());

		const { signal } = request();
		expect(signal).toBeDefined();
		expect(signal?.aborted).toBe(false);
	});

	it('warns and drops the reasoning budget, since o-series models are not supported yet', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));

		const result = await openAIAdapter.call('sk-openai-123', makeRequest({ reasoningMaxTokens: 2000 }));

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reasoningMaxTokens'));
		expect(result.ok).toBe(true);
	});

	it('does not warn when no reasoning budget is set', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		stubFetch(jsonResponse({ choices: [] }));

		await openAIAdapter.call('sk-openai-123', makeRequest());

		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('parses content and finish_reason from the first choice', async () => {
		stubFetch(
			jsonResponse({
				choices: [{ message: { content: 'the review' }, finish_reason: 'stop' }],
			}),
		);

		const result = await openAIAdapter.call('sk-openai-123', makeRequest());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.content).toBe('the review');
			expect(result.data.finishReason).toBe('stop');
		}
	});

	it('returns null content when the message content is absent', async () => {
		stubFetch(jsonResponse({ choices: [{ finish_reason: 'length' }] }));

		const result = await openAIAdapter.call('sk-openai-123', makeRequest());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.content).toBeNull();
			expect(result.data.finishReason).toBe('length');
		}
	});

	it('returns ok:false with the status and a truncated body on a non-2xx response', async () => {
		stubFetch(new Response('unauthorized', { status: 401 }));

		const result = await openAIAdapter.call('sk-openai-123', makeRequest());

		expect(result).toEqual({ ok: false, status: 401, body: 'unauthorized' });
	});
});
