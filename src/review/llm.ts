import { PermanentError } from '../errors';
import { Provider } from './provider-types';
import { getAdapter } from './providers';

export type Severity = "major" | "minor" | "nit";

export interface Finding {
  path: string;
  line: number;
  endLine?: number; // set when suggestion replaces a MULTI-LINE span (line through endLine)
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
- If there are issues: "verdict" is "⚠️ N issues (X major, Y minor, Z nits)" adjusted to the actual counts.
- "endLine" is optional. Set it ONLY when "suggestion" replaces MORE THAN ONE line. In that case "line" is the FIRST line of the span and "endLine" is the LAST line — both must be numeric prefixes shown in the diff for that file, and "suggestion" must contain the FULL replacement for every line from "line" through "endLine" inclusive. If your suggestion only touches a single line, omit "endLine" entirely.`;

const VALID_SEVERITIES = new Set<string>(["major", "minor", "nit"]);

function tryParse(text: string): ReviewResult | null {
  try {
    const data = JSON.parse(text) as { verdict?: unknown; findings?: unknown };
    if (typeof data.verdict !== "string" || !Array.isArray(data.findings)) return null;

    const findings: Finding[] = [];
    for (const f of data.findings) {
      if (
        typeof f?.path === "string" &&
        typeof f?.line === "number" &&
        Number.isInteger(f.line) &&
        (f.endLine === undefined ||
          (typeof f.endLine === "number" && Number.isInteger(f.endLine) && f.endLine > f.line)) &&
        typeof f?.severity === "string" &&
        VALID_SEVERITIES.has(f.severity) &&
        typeof f?.title === "string" &&
        typeof f?.body === "string" &&
        (f.suggestion === undefined || typeof f.suggestion === "string")
      ) {
        findings.push({
          path: f.path,
          line: f.line,
          endLine: typeof f.endLine === "number" ? f.endLine : undefined,
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

export function parseReviewJson(text: string): ReviewResult | null {
  const trimmed = text.trim();

  // Strategy 1: the whole output is JSON (possibly fenced at the edges)
  const edgeCleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const direct = tryParse(edgeCleaned);
  if (direct) return direct;

  // Strategy 2: JSON is inside a fence ANYWHERE (e.g., after leaked reasoning).
  // Take the LAST fenced block — reasoning may quote earlier partial JSON.
  const fenceMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fenceMatches.length - 1; i >= 0; i--) {
    const parsed = tryParse(fenceMatches[i][1].trim());
    if (parsed) return parsed;
  }

  // Strategy 3: unfenced JSON buried in prose — brace-match from the last
  // occurrence of '"verdict"' back to its opening brace, forward to its close.
  // Must be string-aware: braces inside JSON string values (e.g. a code
  // suggestion containing "{") must not affect the depth count.
  const anchor = trimmed.lastIndexOf('"verdict"');
  if (anchor !== -1) {
    const start = trimmed.lastIndexOf("{", anchor);
    if (start !== -1) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const parsed = tryParse(trimmed.slice(start, i + 1));
            if (parsed) return parsed;
            break;
          }
        }
      }
    }
  }

  return null;
}

export interface ReviewConfig {
  apiKey: string;
  model: string;
  reviewTone: "thorough" | "concise";
  supportsReasoning?: boolean;
  provider: Provider;
}

export async function reviewDiff(
  annotatedDiff: string,
  config: ReviewConfig,
  previousReview?: string
): Promise<ReviewResult> {
  const toneInstruction =
    config.reviewTone === "concise"
      ? "\n\nTONE: Be concise. Maximum 3 findings. Keep each body to one sentence."
      : "\n\nTONE: Be thorough. Maximum 5 findings. Explain each finding's consequence fully.";

  const userMessages: { role: string; content: string }[] = [];

  if (previousReview) {
    userMessages.push({
      role: "user",
      content: `You previously reviewed this PR and said the following. Do NOT repeat points you already made — review only the new changes:\n\n${previousReview}`,
    });
  }

  userMessages.push({
    role: "user",
    content: `Review this pull request diff:\n\n${annotatedDiff}`,
  });

  const adapter = getAdapter(config.provider);
  const result = await adapter.call(config.apiKey, {
    model: config.model,
    systemPrompt: SYSTEM_PROMPT + toneInstruction,
    userMessages,
    maxTokens: 8000,
    reasoningMaxTokens: config.supportsReasoning ? 2000 : undefined,
  });

  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      throw new PermanentError(`${config.provider} auth error: ${result.status} ${result.body}`);
    }
    throw new Error(`${config.provider} error: ${result.status} ${result.body}`);
  }

  if (!result.data.content) {
    throw new Error(
      `${config.provider} returned no content. finish_reason=${result.data.finishReason ?? "n/a"} body=${result.data.rawBody.replace(/\s+/g, " ").slice(0, 500)}`
    );
  }

  const parsed = parseReviewJson(result.data.content);
  if (parsed) return parsed;

  console.log("Review output was not valid JSON; falling back to raw text");
  return { verdict: "", findings: [], raw: result.data.content.trim() };
}

// ========== SUMMARY ============ //
const SUMMARY_PROMPT = `You summarize a pull request's overall changes for its description. Group your output under relevant headers using "###" from this set — use only the ones that apply, in this order: New Features, Bug Fixes, Chores, Tests, Documentation. Under each header, list 1-4 concise bullet points. Skip a header entirely if nothing in the diff fits it. If none of these headers apply, output a single bullet point describing the change without a header. Describe WHAT changed and WHY it matters — not line-by-line implementation detail. Do not wrap the whole output in a code fence. Output ONLY the headers and bullet points, nothing else.`;

/** Best-effort PR description summary. Returns null on any failure — never throws. */
export async function generateSummary(
  fullDiff: string,
  config: { apiKey: string; model: string }
): Promise<string | null> {
  // Large diffs would blow the model's context; cap defensively.
  const truncatedDiff = fullDiff.length > 20_000 ? fullDiff.slice(0, 20_000) + "\n... (truncated)" : fullDiff;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Ekojoecovenant/alphapr",
        "X-Title": "AlphaPR",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 800,
        // No `reasoning` field here: this is a short summarize-only call,
        // not worth burning output budget on reasoning tokens.
        messages: [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: `Summarize this pull request diff:\n\n${truncatedDiff}` },
        ],
      }),
    });

    if (!res.ok) {
      console.warn(`generateSummary: OpenRouter error ${res.status} ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content?.trim()) {
      console.warn("generateSummary: OpenRouter returned empty content");
      return null;
    }
    return content.trim();
  } catch (err) {
    console.warn(`generateSummary: request failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
