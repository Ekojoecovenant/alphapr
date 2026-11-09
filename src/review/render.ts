import type { Finding, ReviewResult, Severity } from './llm';

const EMOJI: Record<Severity, string> = { major: '🔴', minor: '🟡', nit: '🟢' };
const ORDER: Record<Severity, number> = { major: 0, minor: 1, nit: 2 };

const MAX_TITLE = 200;
const MAX_BODY = 4000;
const MAX_SUGGESTION = 4000;
const MAX_VERDICT = 160;

function cap(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function clamp(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/**
 * Model output is attacker-influenced: the diff it reads is written by the pull
 * request author, so anything the model echoes is untrusted text that would be
 * posted under the bot's identity. Neutralise the parts that carry authority —
 * HTML, @-mentions/team pings, link and image syntax that can dress up a
 * phishing URL, and code fences that could close our own suggestion block.
 */
function neutralize(text: string, fences = true): string {
	const out = text
		.replace(/\r\n?/g, '\n')
		// Raw HTML (including comments) never needs to survive into a comment.
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<\/?[a-zA-Z][^>\n]{0,200}>/g, '')
		// A zero-width space keeps the text readable but stops @org/team pings.
		.replace(/@(?=[A-Za-z0-9])/g, '@\u200B')
		// Defuse inline link/image syntax; the target stays visible as text.
		.replace(/\]\(/g, ']\\(')
		.replace(/!\[/g, '!\\[');
	// No field may open or close a fence of its own — except the raw fallback,
	// which legitimately *is* a whole markdown document.
	return fences ? out.replace(/```/g, '`\u200B``').replace(/\n{4,}/g, '\n\n\n') : out;
}

/** Single-line field (title, verdict): no newlines, capped. */
export function sanitizeInline(text: string, max = MAX_TITLE): string {
	return clamp(
		neutralize(text, false)
			.replace(/\s*\n+\s*/g, ' ')
			.trim(),
		max,
	);
}

/** Multi-line field (finding body, suggestion), capped. */
export function sanitizeBlock(text: string, max = MAX_BODY, fences = true): string {
	return clamp(neutralize(text, fences).trim(), max);
}

export function sortFindings(findings: Finding[]): Finding[] {
	return [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/** Body for one line-anchored review comment. */
export function renderAnchoredComment(f: Finding): string {
	let out = `${EMOJI[f.severity]} **${cap(f.severity)}** — ${sanitizeInline(f.title)}\n\n${sanitizeBlock(f.body)}`;
	if (f.suggestion) {
		out += `\n\n\`\`\`suggestion\n${sanitizeBlock(f.suggestion, MAX_SUGGESTION)}\n\`\`\``;
	}
	return out;
}

/** One finding rendered for the summary comment (unanchorable fallback). */
function renderSummaryFinding(f: Finding): string {
	let out = `### ${EMOJI[f.severity]} ${cap(f.severity)} — \`${f.path}:${f.line}\`\n${sanitizeInline(f.title)}\n\n${sanitizeBlock(f.body)}`;
	if (f.suggestion) {
		out += `\n\n\`\`\`suggestion\n${sanitizeBlock(f.suggestion, MAX_SUGGESTION)}\n\`\`\``;
	}
	return out;
}

/** The status-comment body: verdict + inline-count note + any unanchorable findings. */
export function renderSummary(result: ReviewResult, anchoredCount: number, unanchored: Finding[]): string {
	if (result.raw) return sanitizeBlock(result.raw, 20_000, false); // JSON fallback — old-style full text

	let out = `**Verdict:** ${sanitizeInline(result.verdict, MAX_VERDICT)}`;
	if (anchoredCount > 0) {
		out += `\n\n💬 ${anchoredCount} inline comment${anchoredCount === 1 ? '' : 's'} posted on the changed files.`;
	}
	if (unanchored.length > 0) {
		out += `\n\n---\n\n` + sortFindings(unanchored).map(renderSummaryFinding).join('\n\n---\n\n');
	}
	return out;
}

/** Full markdown of the whole review — stored in D1 as previous-review context. */
export function renderForMemory(result: ReviewResult): string {
	if (result.raw) return sanitizeBlock(result.raw, 20_000, false);
	let out = `**Verdict:** ${sanitizeInline(result.verdict, MAX_VERDICT)}`;
	if (result.findings.length > 0) {
		out += `\n\n` + sortFindings(result.findings).map(renderSummaryFinding).join('\n\n---\n\n');
	}
	return out;
}

// =========== SUMMARY =========== //
const SUMMARY_START = '<!-- alphapr-summary -->';
const SUMMARY_END = '<!-- /alphapr-summary -->';

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
	const separator = existingBody.trim().length > 0 ? '\n\n' : '';
	return `${existingBody}${separator}${block}`;
}
