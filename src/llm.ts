const SYSTEM_PROMPT = `You are a precise code reviewer. You receive a unified diff from a pull request and produce ONE review comment in GitHub-flavored Markdown.

OUTPUT FORMAT — follow this structure exactly:

Line 1 is always a verdict:
- If no real issues: \`✅ **LGTM** — no issues found.\` and STOP. Output nothing else.
- Otherwise: \`**Verdict:** ⚠️ N issues (X major, Y minor)\`

Then for each issue, worst first, separated by \`---\`:

### <severity emoji> <severity> — \`<file>:<line>\`
<One-sentence description of the problem.>

\`\`\`suggestion
<corrected code, only if you are confident in the exact fix>
\`\`\`
[OPTIONAL - included ONLY if you know the exact replacement code. If not, OMIT this block entirely. Never output an empty suggestion fence.]

<details><summary>Why this matters</summary>
<Brief explanation of the consequence if unfixed.>
</details>

SEVERITY TIERS:
- 🔴 Major: bugs, security issues, data loss, broken logic
- 🟡 Minor: error-handling gaps, misleading names, typos in user-facing text
- 🟢 Nit: style-level observations (use sparingly)

RULES:
- Maximum 5 issues. If more exist, show the worst 5 and end with one line: "Also noticed N minor items not shown."
- Comment ONLY on real issues in the diff. Do not invent problems. Do not review unchanged code.
- No greetings, no thanks, no sign-offs, no offers to help further.
- Only include a suggestion fence when you're confident in the exact replacement code; otherwise describe the fix in prose.
- File/line references must come from the diff hunks, not guesses.`;

export async function reviewDiff(
  diff: string,
  config: { apiKey: string; model: string },
  previousReview?: string,
): Promise<string> {
  const user_messages = [{
    role: "user",
    content: `Review this pull request diff:\n\n\`\`\`diff\n${diff}\n\`\`\``,
  }];

  if (previousReview) {
    user_messages.unshift({
      role: "user",
      content: `You previously reviewed this PR and said the following. Do NOT repeat points you already made - review only the new changes:\n\n${previousReview}`,
    });
  }
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        ...user_messages,
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };

  const review = data.choices[0]?.message?.content;
  if (!review) {
    throw new Error("OpenRouter response contained no choices");
  }

  const cleaned = review.replace(/```suggestion\s*```/g, "").trim();
  if (!cleaned) {
    throw new Error("Review was empty after sanitization");
  }
  return cleaned;
}