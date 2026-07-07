const SYSTEM_PROMPT = `You are a precise code reviewer. You will receive a unified diff from a pull request.

Rules:
- Comment ONLY on real issues: bugs, security problems, logic errors, and significant maintainability concerns.
- Do NOT comment on style preferences or trivial nitpicks.
- If the diff looks fine, say so briefly — do not invent problems.
- Be specific: reference file names and what exactly is wrong.
- Format your review in GitHub-flavored Markdown.
- Keep it concise.`;

export async function reviewDiff(
  diff: string,
  config: { apiKey: string; model: string }
): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Review this pull request diff:\n\n\`\`\`diff\n${diff}\n\`\`\`` },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0].message.content;
}