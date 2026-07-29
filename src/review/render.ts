import type { Finding, ReviewResult, Severity } from "./llm";

const EMOJI: Record<Severity, string> = { major: "🔴", minor: "🟡", nit: "🟢" };
const ORDER: Record<Severity, number> = { major: 0, minor: 1, nit: 2 };

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/** Body for one line-anchored review comment. */
export function renderAnchoredComment(f: Finding): string {
  let out = `${EMOJI[f.severity]} **${cap(f.severity)}** — ${f.title}\n\n${f.body}`;
  if (f.suggestion) {
    out += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
  }
  return out;
}

/** One finding rendered for the summary comment (unanchorable fallback). */
function renderSummaryFinding(f: Finding): string {
  let out = `### ${EMOJI[f.severity]} ${cap(f.severity)} — \`${f.path}:${f.line}\`\n${f.title}\n\n${f.body}`;
  if (f.suggestion) {
    out += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
  }
  return out;
}

/** The status-comment body: verdict + inline-count note + any unanchorable findings. */
export function renderSummary(
  result: ReviewResult,
  anchoredCount: number,
  unanchored: Finding[]
): string {
  if (result.raw) return result.raw; // JSON fallback — old-style full text

  let out = `**Verdict:** ${result.verdict}`;
  if (anchoredCount > 0) {
    out += `\n\n💬 ${anchoredCount} inline comment${anchoredCount === 1 ? "" : "s"} posted on the changed files.`;
  }
  if (unanchored.length > 0) {
    out +=
      `\n\n---\n\n` + sortFindings(unanchored).map(renderSummaryFinding).join("\n\n---\n\n");
  }
  return out;
}

/** Full markdown of the whole review — stored in D1 as previous-review context. */
export function renderForMemory(result: ReviewResult): string {
  if (result.raw) return result.raw;
  let out = `**Verdict:** ${result.verdict}`;
  if (result.findings.length > 0) {
    out +=
      `\n\n` + sortFindings(result.findings).map(renderSummaryFinding).join("\n\n---\n\n");
  }
  return out;
}

// =========== SUMMARY =========== //
const SUMMARY_START = "<!-- alphapr-summary -->";
const SUMMARY_END = "<!-- /alphapr-summary -->";

/**
 * Merges a generated summary into a PR description, replacing only the
 * marker-delimited block if one already exists. Author-written content
 * outside the markers is never touched.
 */
export function mergeSummaryIntoDescription(existingBody: string, summaryMarkdown: string): string {
  const block = `${SUMMARY_START}\n## Summary by AlphaPR\n\n${summaryMarkdown}\n${SUMMARY_END}`;

  const startIdx = existingBody.indexOf(SUMMARY_START);
  const endIdx = existingBody.indexOf(SUMMARY_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingBody.slice(0, startIdx);
    const after = existingBody.slice(endIdx + SUMMARY_END.length);
    return `${before}${block}${after}`;
  }

  // No existing block — append below whatever the author wrote
  const separator = existingBody.trim().length > 0 ? "\n\n" : "";
  return `${existingBody}${separator}${block}`;
}