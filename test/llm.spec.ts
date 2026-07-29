import { describe, it, expect } from "vitest";
import { parseReviewJson } from "../src/llm";

describe("parseReviewJson", () => {
  it("parses clean, unfenced JSON directly", () => {
    const text = JSON.stringify({
      verdict: "✅ LGTM — no issues found.",
      findings: [],
    });

    const result = parseReviewJson(text);

    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("✅ LGTM — no issues found.");
    expect(result?.findings).toEqual([]);
  });

  it("parses JSON wrapped in a markdown fence", () => {
    const text = "```json\n" + JSON.stringify({
      verdict: "⚠️ 1 issues (1 major, 0 minor, 0 nits)",
      findings: [
        {
          path: "src/foo.ts",
          line: 5,
          severity: "major",
          title: "Missing null check",
          body: "This could throw.",
        },
      ],
    }) + "\n```";

    const result = parseReviewJson(text);

    expect(result).not.toBeNull();
    expect(result?.findings.length).toBe(1);
    expect(result?.findings[0].severity).toBe("major");
  });

  it("recovers JSON from a model's leaked reasoning monologue (real production fixture)", () => {
    // This is the ACTUAL output AlphaPR received from deepseek-v4-flash on PR #10,
    // before the multi-strategy extractor existed. The model thought out loud in
    // plain prose, then eventually emitted a fenced JSON block at the very end.
    const text = `? Actually, the else clause at line 52 treats it as a context line and adds to newLine. But "--- a/file" is not a context line; it's a header. This could cause the line to be incorrectly numbered and added to validLines.

Let's trace: The code enters the loop, reads "diff --git ..." -> handled.

I think the logic is correct for standard unified diffs. No major issues.

Thus, the verdict should be "LGTM" with no issues, or maybe mention the missing newline as a nit.

I'll write it.\`\`\`json
{
  "verdict": "⚠️ 1 issue (0 major, 0 minor, 1 nit)",
  "findings": [
    {
      "path": "src/diff.ts",
      "line": 60,
      "severity": "nit",
      "title": "Missing newline at end of file",
      "body": "The file does not end with a newline, which is a common style convention."
    }
  ]
}
\`\`\``;

    const result = parseReviewJson(text);

    expect(result).not.toBeNull();
    expect(result?.findings.length).toBe(1);
    expect(result?.findings[0].path).toBe("src/diff.ts");
    expect(result?.findings[0].severity).toBe("nit");
  });

  it("recovers unfenced JSON buried in prose, using string-aware brace matching", () => {
    // Regression test for the bug CodeRabbit caught: a suggestion containing
    // "{" or "}" must not break the brace-depth counter.
    const text = `Here's my review after checking the code carefully.

{"verdict": "⚠️ 1 issues (1 major, 0 minor, 0 nits)", "findings": [{"path": "src/foo.ts", "line": 10, "severity": "major", "title": "Bad object literal", "body": "Uses {} incorrectly.", "suggestion": "const x = { a: 1 };"}]}`;

    const result = parseReviewJson(text);

    expect(result).not.toBeNull();
    expect(result?.findings.length).toBe(1);
    expect(result?.findings[0].suggestion).toBe("const x = { a: 1 };");
  });

  it("returns null for genuinely unparseable garbage (triggers the raw-text fallback upstream)", () => {
    const text = "The model just refused to follow instructions and wrote a poem instead.";

    const result = parseReviewJson(text);

    expect(result).toBeNull();
  });

  it("caps findings at 5 even if the model returns more", () => {
    const findings = Array.from({ length: 8 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      severity: "minor",
      title: `Issue ${i}`,
      body: "Some issue.",
    }));

    const text = JSON.stringify({ verdict: "⚠️ 8 issues", findings });
    const result = parseReviewJson(text);

    expect(result?.findings.length).toBe(5);
  });

  it("rejects findings with an invalid severity value", () => {
    const text = JSON.stringify({
      verdict: "⚠️ 1 issue",
      findings: [
        { path: "src/foo.ts", line: 1, severity: "catastrophic", title: "x", body: "y" },
      ],
    });

    const result = parseReviewJson(text);

    // The malformed finding is silently dropped, not crashed on
    expect(result?.findings.length).toBe(0);
  });
});