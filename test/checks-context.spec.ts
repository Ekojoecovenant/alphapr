import { describe, it, expect } from "vitest";
import { summarizeExternalChecks } from "../src/review/llm";

describe("summarizeExternalChecks", () => {
  it("returns null when there are no failing checks", () => {
    expect(summarizeExternalChecks([])).toBeNull();
  });

  it("includes the check name and a truncated summary", () => {
    const result = summarizeExternalChecks([
      { name: "ESLint", conclusion: "failure", summary: "3 errors found", text: null },
    ]);
    expect(result).toContain("ESLint");
    expect(result).toContain("3 errors found");
  });

  it("caps at 5 checks even if more are provided", () => {
    const checks = Array.from({ length: 8 }, (_, i) => ({
      name: `Check ${i}`,
      conclusion: "failure",
      summary: "failed",
      text: null,
    }));
    const result = summarizeExternalChecks(checks);
    expect(result?.split("\n- ").length).toBeLessThanOrEqual(6); // 5 items + intro line
  });
});
