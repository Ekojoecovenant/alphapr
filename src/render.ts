import type { Finding, ReviewResult } from "./llm";

const EMOJI: Record<string, string> = { major: "🔴", minor: "🟡", nit: "🟢" };
const ORDER: Record<string, number> = { major: 0, minor: 1, nit: 2 };

/**
 * Capitalizes the first character of a string.
 *
 * @param s - The string to capitalize
 * @returns The string with its first character converted to uppercase
 */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Sorts findings by severity while preserving the input array.
 *
 * @param findings - The findings to sort
 * @returns A new array ordered from highest to lowest severity
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/**
 * Formats a finding as a line-anchored Markdown review comment.
 *
 * @param f - The finding to render.
 * @returns The formatted comment body, including a suggestion block when provided.
 */
export function renderAnchoredComment(f: Finding): string {
  let out = `${EMOJI[f.severity]} **${cap(f.severity)}** — ${f.title}\n\n${f.body}`;
  if (f.suggestion) {
    out += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
  }
  return out;
}

/**
 * Renders a finding for inclusion in the summary comment.
 *
 * @param f - The finding to render
 * @returns Markdown containing the finding's severity, location, title, body, and optional suggestion
 */
function renderSummaryFinding(f: Finding): string {
  let out = `### ${EMOJI[f.severity]} ${cap(f.severity)} — \`${f.path}:${f.line}\`\n${f.title}\n\n${f.body}`;
  if (f.suggestion) {
    out += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
  }
  return out;
}

/**
 * Builds the review status comment with its verdict, inline comment count, and unanchored findings.
 *
 * @param result - The review result containing the verdict or raw fallback text.
 * @param anchoredCount - The number of inline comments posted on changed files.
 * @param unanchored - Findings that could not be posted as inline comments.
 * @returns The formatted Markdown status comment.
 */
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
    out += `\n\n---\n\n` + sortFindings(unanchored).map(renderSummaryFinding).join("\n\n---\n\n");
  }
  return out;
}

/**
 * Renders a complete review as Markdown for use as previous-review context.
 *
 * @param result - The review result to render
 * @returns The raw review text when available; otherwise, Markdown containing the verdict and findings
 */
export function renderForMemory(result: ReviewResult): string {
  if (result.raw) return result.raw;
  let out = `**Verdict:** ${result.verdict}`;
  if (result.findings.length > 0) {
    out += `\n\n` + sortFindings(result.findings).map(renderSummaryFinding).join("\n\n---\n\n");
  }
  return out;
}