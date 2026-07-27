export type Severity = "major" | "minor" | "nit";

export interface Finding {
  path: string;
  line: number;
  severity: Severity;
  title: string;
  body: string;
  suggestion?: string;
}

export interface ReviewResult {
  /** One-line verdict, e.g. "⚠️ 2 issues (1 major, 1 minor)" or "✅ LGTM — no issues found." */
  verdict: string;
  findings: Finding[];
  /** Set when the model's output couldn't be parsed as JSON — raw text fallback */
  raw?: string;
}

const SYSTEM_PROMPT = `You are a precise code reviewer. You receive a unified diff in which every line of the NEW version of each file is prefixed with its line number, like "42: + const x = 1;".

Respond with ONLY a JSON object — no markdown fences, no prose before or after — in exactly this shape:

{
  "verdict": "one-line summary",
  "findings": [
    {
      "path": "src/file.ts",
      "line": 42,
      "severity": "major",
      "title": "Short description of the problem",
      "body": "1-3 sentences: what is wrong and its consequence if unfixed.",
      "suggestion": "the corrected code for exactly that one line"
    }
  ]
}

RULES:
- "line" MUST be one of the numeric prefixes shown in the diff for that file. Never invent line numbers.
- "severity" is "major" (bugs, security issues, data loss, broken logic), "minor" (error-handling gaps, misleading names, typos in user-facing text), or "nit" (style-level; use sparingly).
- "suggestion" is optional. Include it ONLY if you are confident in the exact replacement for that single line. It must contain only the replacement code — no backticks, no fences, no line-number prefix. Omit the field entirely otherwise.
- Maximum 5 findings, worst first. If more exist, include the worst 5 and mention the rest in the verdict.
- Comment ONLY on real issues in the diff. Do not invent problems. Do not review unchanged code.
- If there are no real issues: "verdict" is "✅ LGTM — no issues found." and "findings" is [].
- If there are issues: "verdict" is "⚠️ N issues (X major, Y minor, Z nits)" adjusted to the actual counts.`;

const VALID_SEVERITIES = new Set<string>(["major", "minor", "nit"]);

function parseReviewJson(text: string): ReviewResult | null {
  // Tolerate models that wrap output in fences despite instructions
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const data = JSON.parse(cleaned) as { verdict?: unknown; findings?: unknown };
    if (typeof data.verdict !== "string" || !Array.isArray(data.findings)) return null;

    const findings: Finding[] = [];
    for (const f of data.findings) {
      if (
        typeof f?.path === "string" &&
        typeof f?.line === "number" &&
        Number.isInteger(f.line) &&
        typeof f?.severity === "string" &&
        VALID_SEVERITIES.has(f.severity) &&
        typeof f?.title === "string" &&
        typeof f?.body === "string" &&
        (f.suggestion === undefined || typeof f.suggestion === "string")
      ) {
        findings.push({
          path: f.path,
          line: f.line,
          severity: f.severity as Severity,
          title: f.title,
          body: f.body,
          suggestion:
            typeof f.suggestion === "string" && f.suggestion.trim() ? f.suggestion : undefined,
        });
      }
    }
    return { verdict: data.verdict, findings: findings.slice(0, 5) };
  } catch {
    return null;
  }
}

export async function reviewDiff(
  annotatedDiff: string,
  config: { apiKey: string; model: string },
  previousReview?: string
): Promise<ReviewResult> {
  const userMessages: { role: string; content: string }[] = [];

  if (previousReview) {
    userMessages.push({
      role: "user",
      content: `You previously reviewed this PR and said the following. Do NOT repeat points you already made — review only the new changes:

${previousReview}`,
    });
  }

  userMessages.push({
    role: "user",
    content: `Review this pull request diff:

${annotatedDiff}`,
  });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/Ekojoecovenant/alphapr",
      "X-Title": "AlphaPR",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 8000,
      reasoning: { max_tokens: 2000 },
      provider: { sort: "throughput" },
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...userMessages],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter error: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    error?: unknown;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(
      `OpenRouter returned no content. finish_reason=${data.choices?.[0]?.finish_reason ?? "n/a"} body=${JSON.stringify(data).slice(0, 500)}`
    );
  }

  const parsed = parseReviewJson(content);
  if (parsed) return parsed;

  // Graceful degradation: model ignored the JSON contract — fall back to raw text
  console.log("Review output was not valid JSON; falling back to raw text");
  return { verdict: "", findings: [], raw: content.trim() };
}