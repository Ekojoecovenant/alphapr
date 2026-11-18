import { decryptSecret } from './crypto';
import { getReviewState, markReviewFailure, markReviewSuccess, recordReview, saveReviewState } from './db';
import { PermanentError } from './errors';
import {
	completeCheckRun,
	createReview,
	editComment,
	getFailedCheckRuns,
	getPRDescription,
	markCheckRunRetrying,
	postReviewComment,
	updatePRDescription,
} from './github/api';
import { createAppJWT, getInstallationToken } from './github/auth';
import { parseDiff } from './review/diff';
import { type Finding, generateSummary, type ReviewResult, reviewDiff, summarizeExternalChecks } from './review/llm';
import { type Provider, parseProvider } from './review/provider-types';
import { mergeSummaryIntoDescription, renderAnchoredComment, renderForMemory, renderSummary, sortFindings } from './review/render';
import { formatUsage } from './review/usage';
import { loadRepoConfig } from './review-config';
import { isAlreadyReviewed } from './review-gate';
import type { CheckConclusion, ReviewCommentInput, ReviewJob } from './types';

export type { ReviewJob };

/**
 * Reduce an upstream error message to one safe, quotable line for a public PR
 * comment. A provider 4xx body is often the only explanation a tenant gets
 * (e.g. "Key limit exceeded"), so it is worth surfacing — but it must never
 * carry a credential, contain markup, or run away with the comment.
 */
export function sanitizeDetail(detail: string): string {
	const collapsed = detail
		.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
		.replace(/\s+/g, ' ')
		.replace(/[<>]/g, '')
		.trim();
	return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}

export async function surfaceFailure(
	job: ReviewJob,
	env: Env,
	isPermanent: boolean,
	willRetry: boolean,
	attempt?: number,
	maxAttempts?: number,
	detail?: string,
): Promise<void> {
	if (job.statusCommentId === null && job.checkRunId === null) return;

	const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
	const token = await getInstallationToken(jwt, job.installationId);

	const attemptSuffix = attempt && maxAttempts ? ` (attempt ${attempt}/${maxAttempts})` : '';
	const reason = detail ? sanitizeDetail(detail) : '';
	// The quote comes last, on its own paragraph: an attempt counter swallowed into
	// the blockquote reads as though the provider wrote it.
	const explanation = reason ? `\n\n> ${reason}` : '';

	const commentText = isPermanent
		? `⚠️ **AlphaPR review failed.** This won't be retried — check your installation's configuration.${attemptSuffix}${explanation}`
		: willRetry
			? `⚠️ **AlphaPR review failed.** Retrying automatically…${attemptSuffix}`
			: `⚠️ **AlphaPR review failed.** All retry attempts exhausted.${attemptSuffix}${explanation}`;

	if (job.statusCommentId !== null) {
		try {
			await editComment(token, job.owner, job.repo, job.statusCommentId, commentText);
		} catch {
			/* fall through to check-run update */
		}
	}

	// Terminal failures are what the dashboard banner is for. A retry that may
	// still succeed is not: recording it would flash a failure that then heals.
	if (!willRetry) {
		try {
			await markReviewFailure(env.DB, job.installationId, null, reason || 'The review failed.');
		} catch (err) {
			console.error(`Failed to record the installation failure: ${err instanceof Error ? err.message : err}`);
		}
	}

	if (job.checkRunId !== null) {
		try {
			if (willRetry) {
				// Retry pending — keep the check IN PROGRESS, do NOT complete it.
				await markCheckRunRetrying(token, job.owner, job.repo, job.checkRunId, commentText);
			} else {
				// Terminal state: either permanent failure or retries exhausted.
				await completeCheckRun(
					token,
					job.owner,
					job.repo,
					job.checkRunId,
					'failure',
					'AlphaPR review failed',
					isPermanent ? "This won't be retried." : `All retry attempts exhausted.${attemptSuffix}`,
				);
			}
		} catch {
			/* never let status-surfacing throw further */
		}
	}
}

/**
 * Resolve the status comment and check run for a review that was skipped as a
 * duplicate, so a no-op dispatch never leaves the PR showing "Reviewing…".
 */
async function concludeAlreadyReviewed(job: ReviewJob, token: string): Promise<void> {
	const text = '✅ **Already reviewed.** This commit is identical to the one AlphaPR last reviewed, so there is nothing new to report.';

	if (job.statusCommentId !== null) {
		try {
			await editComment(token, job.owner, job.repo, job.statusCommentId, text);
		} catch {
			/* best-effort: the check run below is the other signal */
		}
	}

	if (job.checkRunId !== null) {
		try {
			await completeCheckRun(
				token,
				job.owner,
				job.repo,
				job.checkRunId,
				'success',
				'Already reviewed',
				'No changes since the last review.',
			);
		} catch {
			/* never let status-surfacing throw further */
		}
	}
}

export async function handlePREvent(job: ReviewJob, env: Env): Promise<void> {
	const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
	const token = await getInstallationToken(jwt, job.installationId);

	// ─── BYOK: resolve the key + model + config, repo overrides included ───
	const installation = await loadRepoConfig(env.DB, job.installationId, job.owner, job.repo);

	let apiKey: string;
	let model: string;
	let reviewTone: 'thorough' | 'concise' = 'thorough';
	let severityThreshold = 'all';
	let ignorePaths: string[] = [];
	let provider: Provider = 'openrouter';

	if (installation?.apiKeyEncrypted) {
		try {
			apiKey = await decryptSecret(installation.apiKeyEncrypted, env.KEY_ENCRYPTION_SECRET);
		} catch (err) {
			throw new PermanentError(
				`Failed to decrypt API key for installation ${job.installationId}: ${err instanceof Error ? err.message : err}`,
				{ cause: err },
			);
		}
		model = installation.model;
		reviewTone = installation.reviewTone;
		severityThreshold = installation.severityThreshold;
		ignorePaths = installation.ignorePaths;
		provider = parseProvider(installation.provider);
	} else if (job.owner === env.FALLBACK_OWNER) {
		apiKey = env.OPENROUTER_API_KEY;
		model = 'deepseek/deepseek-v4-flash';
	} else {
		const setupMessage = `⚙️ **AlphaPR is installed but not configured yet.**\n\nAn OpenRouter API key is needed for this installation. Configure it at https://alphapr.covenantekojoe.workers.dev/setup — once configured, close and re-open this PR to trigger a review.`;

		if (job.statusCommentId !== null) {
			// A synchronize job always follows a prior review, so its status comment
			// already exists. A first-time action (opened / ready_for_review) may not.
			if (job.action !== 'synchronize') {
				await editComment(token, job.owner, job.repo, job.statusCommentId, setupMessage);
			} else {
				await editComment(token, job.owner, job.repo, job.statusCommentId, '⚙️ Not configured — see setup instructions above.');
			}
		} else if (job.action !== 'synchronize') {
			await postReviewComment(token, job.owner, job.repo, job.prNumber, setupMessage);
		}

		if (job.checkRunId !== null) {
			await completeCheckRun(
				token,
				job.owner,
				job.repo,
				job.checkRunId,
				'neutral',
				'AlphaPR not configured',
				'No OpenRouter API key is configured for this installation.',
			);
		}
		return;
	}
	// ─── end BYOK resolution ───

	const state = await getReviewState(env.DB, job.installationId, job.repoFullName, job.prNumber);

	// Race guard: two deliveries for the same push can both be dispatched before
	// either review has saved its state. index.ts already refuses the obvious
	// duplicates, but this is the check that actually holds under concurrency —
	// re-reviewing an identical commit posts duplicate comments and burns a full
	// LLM call. Resolve the status comment and check run before stopping, so the
	// PR is never left showing "Reviewing…".
	if (isAlreadyReviewed(state?.last_reviewed_sha, job.headSha)) {
		console.log(`⏭️ PR #${job.prNumber} commit ${job.headSha.slice(0, 7)} already reviewed — concluding instead of re-reviewing`);
		await concludeAlreadyReviewed(job, token);
		return;
	}

	const incremental = state !== null && job.action === 'synchronize';

	const compareUrl = `https://api.github.com/repos/${job.owner}/${job.repo}/compare/${state?.last_reviewed_sha}...${job.headSha}`;
	const fullPrUrl = `https://api.github.com/repos/${job.owner}/${job.repo}/pulls/${job.prNumber}`;

	const diffHeaders = {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github.diff',
		'User-Agent': 'alphapr',
	};

	let diff: string;
	let usedIncremental = incremental;

	if (incremental) {
		const compareRes = await fetch(compareUrl, { headers: diffHeaders });

		if (compareRes.ok) {
			diff = await compareRes.text();
		} else if (compareRes.status === 404) {
			console.log(`Compare 404 (force-push?), falling back to full diff for PR #${job.prNumber}`);
			usedIncremental = false;
			const fullRes = await fetch(fullPrUrl, { headers: diffHeaders });
			if (!fullRes.ok) {
				throw new Error(`Failed to fetch full diff after fallback: ${fullRes.status} ${(await fullRes.text()).slice(0, 300)}`);
			}
			diff = await fullRes.text();
		} else {
			throw new Error(`Failed to fetch compare diff: ${compareRes.status} ${(await compareRes.text()).slice(0, 300)}`);
		}
	} else {
		const fullRes = await fetch(fullPrUrl, { headers: diffHeaders });
		if (!fullRes.ok) {
			throw new Error(`Failed to fetch full diff: ${fullRes.status} ${(await fullRes.text()).slice(0, 300)}`);
		}
		diff = await fullRes.text();
	}

	const parsed = parseDiff(diff, ignorePaths);

	// Fetch other failing checks on this commit for corroborating context.
	// Best-effort: never let this block the review itself.
	let externalContext: string | undefined;
	try {
		const otherChecks = await getFailedCheckRuns(token, job.owner, job.repo, job.headSha, 'AlphaPR Review');
		externalContext = summarizeExternalChecks(otherChecks) ?? undefined;
	} catch (err) {
		console.log(`Failed to fetch external check runs (continuing without): ${err instanceof Error ? err.message : err}`);
	}

	const result = await reviewDiff(
		parsed.annotated,
		{
			apiKey,
			model,
			reviewTone,
			provider,
		},
		usedIncremental ? (state!.last_review_body ?? undefined) : undefined,
		externalContext,
	);

	const rank: Record<string, number> = { major: 0, minor: 1, nit: 2 };
	const thresholdRank = severityThreshold === 'major' ? 0 : severityThreshold === 'minor' ? 1 : 2;
	const filteredFindings = result.findings.filter((f) => rank[f.severity] <= thresholdRank);

	const verdict = result.raw
		? result.verdict
		: (() => {
				const majorCount = filteredFindings.filter((f) => f.severity === 'major').length;
				const minorCount = filteredFindings.filter((f) => f.severity === 'minor').length;
				const nitCount = filteredFindings.filter((f) => f.severity === 'nit').length;
				return filteredFindings.length === 0
					? '✅ LGTM — no issues found.'
					: `⚠️ ${filteredFindings.length} issues (${majorCount} major, ${minorCount} minor, ${nitCount} nits)`;
			})();

	const displayResult: ReviewResult = { ...result, findings: filteredFindings, verdict };

	const anchored: Finding[] = [];
	const unanchored: Finding[] = [];
	for (const f of displayResult.findings) {
		const lineValid = parsed.validLines.get(f.path)?.has(f.line);
		const endLineValid = f.endLine === undefined || parsed.validLines.get(f.path)?.has(f.endLine);
		if (lineValid && endLineValid) {
			anchored.push(f);
		} else {
			console.log(`Unanchorable finding: ${f.path}:${f.line}${f.endLine ? `-${f.endLine}` : ''} (not in diff)`);
			unanchored.push(f);
		}
	}

	let anchoredCount = 0;
	if (anchored.length > 0) {
		const comments: ReviewCommentInput[] = sortFindings(anchored).map((f) => {
			const comment: ReviewCommentInput = {
				path: f.path,
				line: f.endLine ?? f.line,
				side: 'RIGHT',
				body: renderAnchoredComment(f),
			};
			if (f.endLine !== undefined) {
				comment.start_line = f.line;
				comment.start_side = 'RIGHT';
			}
			return comment;
		});

		try {
			await createReview(token, job.owner, job.repo, job.prNumber, job.headSha, displayResult.verdict, comments);
			anchoredCount = anchored.length;
		} catch (err) {
			console.error(`createReview failed; demoting anchored findings to summary: ${err instanceof Error ? err.message : err}`);
			unanchored.push(...anchored);
		}
	}

	const summaryComment = renderSummary(displayResult, anchoredCount, unanchored);
	try {
		if (job.statusCommentId !== null) {
			await editComment(token, job.owner, job.repo, job.statusCommentId, summaryComment);
		} else {
			await postReviewComment(token, job.owner, job.repo, job.prNumber, summaryComment);
		}
	} catch (err) {
		console.error(`Failed to post/edit summary (inline comments may already be posted): ${err instanceof Error ? err.message : err}`);
	}

	if (job.checkRunId !== null) {
		const hasMajor = displayResult.findings.some((f) => f.severity === 'major');
		const conclusion: CheckConclusion = displayResult.raw
			? 'neutral'
			: hasMajor
				? 'action_required'
				: displayResult.findings.length > 0
					? 'neutral'
					: 'success';
		const title = displayResult.raw ? 'Review posted' : displayResult.verdict;
		const tokenCost = formatUsage(result.usage);
		const checkSummary = [`${anchoredCount} inline comment${anchoredCount === 1 ? '' : 's'}, ${unanchored.length} in summary.`, tokenCost]
			.filter(Boolean)
			.join(' ');
		try {
			await completeCheckRun(token, job.owner, job.repo, job.checkRunId, conclusion, title, checkSummary);
		} catch (err) {
			console.error(`Failed to complete check run: ${err instanceof Error ? err.message : err}`);
		}
	}

	try {
		await saveReviewState(env.DB, job.installationId, job.repoFullName, job.prNumber, job.headSha, renderForMemory(result), result.usage);
	} catch (err) {
		console.error(`Failed to save review state (comments already posted): ${err instanceof Error ? err.message : err}`);
	}

	// The audit trail: one row per posted review, separate from the per-PR
	// memory above (which is overwritten). Best-effort by design — the review
	// has already been posted, so a failed insert must not fail the job.
	try {
		await recordReview(env.DB, {
			installationId: job.installationId,
			repoFullName: job.repoFullName,
			prNumber: job.prNumber,
			headSha: job.headSha,
			provider,
			model,
			usage: result.usage,
		});
	} catch (err) {
		console.error(`Failed to record review history (review already posted): ${err instanceof Error ? err.message : err}`);
	}

	// Keep the installation's health current: the banner on the dashboard reads
	// exactly these columns, and a stale "last review never" is a lie.
	try {
		await markReviewSuccess(env.DB, job.installationId);
	} catch (err) {
		console.error(`Failed to mark the review successful (review already posted): ${err instanceof Error ? err.message : err}`);
	}
	if (env.QUEUE_MODE === 'true') {
		try {
			let fullDiffForSummary = diff;
			if (usedIncremental) {
				const fullRes = await fetch(fullPrUrl, { headers: diffHeaders });
				if (fullRes.ok) fullDiffForSummary = await fullRes.text();
			}

			const prSummary = await generateSummary(fullDiffForSummary, { apiKey, model, provider });
			if (prSummary) {
				const currentBody = await getPRDescription(token, job.owner, job.repo, job.prNumber);
				const updatedBody = mergeSummaryIntoDescription(currentBody, prSummary);
				await updatePRDescription(token, job.owner, job.repo, job.prNumber, updatedBody);
			}
		} catch (err) {
			console.error(`Failed to update PR description summary (non-critical): ${err instanceof Error ? err.message : err}`);
		}
	}

	console.log(
		`✅ Posted ${usedIncremental ? 'incremental' : 'full'} review on PR #${job.prNumber} (${anchoredCount} inline, ${unanchored.length} in summary)`,
	);
}
