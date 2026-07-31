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
    if (!res.ok) return { ok: false, status: res.status, body: rawBody.slice(0, 300) };

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

export function getAdapter(provider: "openrouter"): ProviderAdapter {
  switch (provider) {
    case "openrouter":
      return openRouterAdapter;
  }
}
