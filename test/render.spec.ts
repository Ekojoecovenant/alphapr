import { describe, it, expect } from "vitest";
import { mergeSummaryIntoDescription } from "../src/review/render";

describe("mergeSummaryIntoDescription", () => {
  it("appends a summary block when no existing block is present", () => {
    const result = mergeSummaryIntoDescription("This PR adds a widget.", "- Adds a widget");

    expect(result).toContain("<!-- alphapr-summary -->");
    expect(result).toContain("- Adds a widget");
    expect(result).toContain("This PR adds a widget.");
    // Author content now comes FIRST, summary appended after
    expect(result.indexOf("This PR adds a widget.")).toBeLessThan(
      result.indexOf("<!-- alphapr-summary -->")
    );
  });

  it("handles an empty existing description", () => {
    const result = mergeSummaryIntoDescription("", "- Adds a widget");

    expect(result).toContain("- Adds a widget");
    expect(result.trim().startsWith("<!-- alphapr-summary -->")).toBe(true);
  });

  it("replaces only the marker block on a second run, preserving surrounding author content", () => {
    const first = mergeSummaryIntoDescription("Author notes here.", "- First summary");
    const second = mergeSummaryIntoDescription(first, "- Updated summary");

    expect(second).toContain("Author notes here.");
    expect(second).toContain("- Updated summary");
    expect(second).not.toContain("- First summary");
  });

  it("does not duplicate the marker block across multiple updates", () => {
    let body = "Original description.";
    for (const summary of ["- v1", "- v2", "- v3"]) {
      body = mergeSummaryIntoDescription(body, summary);
    }

    const occurrences = body.split("<!-- alphapr-summary -->").length - 1;
    expect(occurrences).toBe(1);
    expect(body).toContain("- v3");
    expect(body).not.toContain("- v1");
    expect(body).not.toContain("- v2");
  });
});