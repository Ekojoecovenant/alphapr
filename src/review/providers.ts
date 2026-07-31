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

export type ChatResult =
  | { ok: true; data: ChatResponse }
  | { ok: false; status: number; body: string };

export interface ProviderAdapter {
  call(apiKey: string, req: ChatRequest): Promise<ChatResult>;
}

export function getAdapter(provider: Provider): ProviderAdapter {
  switch (provider) {
    case "openrouter":
      return openRouterAdapter;
    case "anthropic":
      return anthropicAdapter;
    case "openai":
      return openAIAdapter;
  }
}

export const openRouterAdapter: ProviderAdapter = {
  async call(apiKey, req) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Ekojoecovenant/alphapr",
        "X-Title": "AlphaPR",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        ...(req.reasoningMaxTokens ? { reasoning: { max_tokens: req.reasoningMaxTokens } } : {}),
        provider: { sort: "throughput", require_parameters: true },
        messages: [{ role: "system", content: req.systemPrompt }, ...req.userMessages],
      }),
    });

    const rawBody = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body: rawBody.replace(/\s+/g, " ").slice(0, 300) };

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

// NOTE: implemented per Anthropic's documented API shape but not yet verified
// against a live request/response. Test before enabling for any real tenant.
export const anthropicAdapter: ProviderAdapter = {
  async call(apiKey, req) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.systemPrompt,
        messages: req.userMessages,
        ...(req.reasoningMaxTokens
          ? { thinking: { type: "enabled", budget_tokens: req.reasoningMaxTokens } }
          : {}),
      }),
    });

    const rawBody = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body: rawBody.replace(/\s+/g, " ").slice(0, 300) };

    const data = JSON.parse(rawBody) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
    };
    const textBlock = data.content?.find((b) => b.type === "text");
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
  async call(apiKey, req) {
    if (req.reasoningMaxTokens) {
      console.warn("openAIAdapter: reasoningMaxTokens was set but is not supported by this adapter (o-series models not yet implemented) — ignoring");
    }
    
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        messages: [{ role: "system", content: req.systemPrompt }, ...req.userMessages],
      }),
    });

    const rawBody = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body: rawBody.replace(/\s+/g, " ").slice(0, 300) };

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
