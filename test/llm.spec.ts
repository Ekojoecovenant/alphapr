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
    const text =
      "```json\n" +
      JSON.stringify({
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
      }) +
      "\n```";

    const result = parseReviewJson(text);

    expect(result).not.toBeNull();
    expect(result?.findings.length).toBe(1);
    expect(result?.findings[0].severity).toBe("major");
  });

  it("recovers JSON from a model's leaked reasoning monologue (real production fixture)", () => {
    const leakedText = `? Actually, the else clause at line 52 treats it as a context line and adds to newLine. But "--- a/file" is not a context line; it's a header. This could cause the line to be incorrectly numbered and added to validLines.

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

    const leakedResult = parseReviewJson(leakedText);

    expect(leakedResult).not.toBeNull();
    expect(leakedResult?.findings.length).toBe(1);
    expect(leakedResult?.findings[0].path).toBe("src/diff.ts");
    expect(leakedResult?.findings[0].severity).toBe("nit");
  });

  it("recovers unfenced JSON buried in prose, using string-aware brace matching (balanced case)", () => {
    const balancedText = `Here's my review after checking the code carefully.

{"verdict": "⚠️ 1 issues (1 major, 0 minor, 0 nits)", "findings": [{"path": "src/foo.ts", "line": 10, "severity": "major", "title": "Bad object literal", "body": "Uses {} incorrectly.", "suggestion": "const x = { a: 1 };"}]}`;

    const balancedResult = parseReviewJson(balancedText);

    expect(balancedResult).not.toBeNull();
    expect(balancedResult?.findings.length).toBe(1);
    expect(balancedResult?.findings[0].suggestion).toBe("const x = { a: 1 };");
  });

  it("recovers JSON with an UNBALANCED brace inside a string value (regression for CodeRabbit's catch)", () => {
    const unbalancedText = `Here's my review.

{"verdict": "⚠️ 1 issues (1 major, 0 minor, 0 nits)", "findings": [{"path": "src/foo.ts", "line": 10, "severity": "major", "title": "Bad snippet", "body": "Consider this fix.", "suggestion": "const x = {"}]}`;

    const unbalancedResult = parseReviewJson(unbalancedText);

    expect(unbalancedResult).not.toBeNull();
    expect(unbalancedResult?.findings.length).toBe(1);
    expect(unbalancedResult?.findings[0].suggestion).toBe("const x = {");
  });

  it("returns null for genuinely unparseable garbage (triggers the raw-text fallback upstream)", () => {
    const garbageText = "The model just refused to follow instructions and wrote a poem instead.";

    const garbageResult = parseReviewJson(garbageText);

    expect(garbageResult).toBeNull();
  });

  it("caps findings at 5 even if the model returns more", () => {
    const manyFindings = Array.from({ length: 8 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      severity: "minor",
      title: `Issue ${i}`,
      body: "Some issue.",
    }));

    const cappedText = JSON.stringify({ verdict: "⚠️ 8 issues", findings: manyFindings });
    const cappedResult = parseReviewJson(cappedText);

    expect(cappedResult?.findings.length).toBe(5);
  });

  it("rejects findings with an invalid severity value", () => {
    const invalidText = JSON.stringify({
      verdict: "⚠️ 1 issue",
      findings: [
        { path: "src/foo.ts", line: 1, severity: "catastrophic", title: "x", body: "y" },
      ],
    });

    const invalidResult = parseReviewJson(invalidText);

    expect(invalidResult?.findings.length).toBe(0);
  });
});