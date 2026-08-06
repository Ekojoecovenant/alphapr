import { decryptSecret } from './crypto';
import { getInstallation, getReviewState, saveReviewState } from './db';
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
import type { CheckConclusion, ReviewCommentInput, ReviewJob } from './types';

export type { ReviewJob };

export async function surfaceFailure(
	job: ReviewJob,
	env: Env,
	isPermanent: boolean,
	willRetry: boolean,
	attempt?: number,
	maxAttempts?: number,
): Promise<void> {
	if (job.statusCommentId === null && job.checkRunId === null) return;

	const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
	const token = await getInstallationToken(jwt, job.installationId);

	const attemptSuffix = attempt && maxAttempts ? ` (attempt ${attempt}/${maxAttempts})` : '';

	const commentText = isPermanent
		? `⚠️ **AlphaPR review failed.** This won't be retried — check your installation's configuration.${attemptSuffix}`
		: willRetry
			? `⚠️ **AlphaPR review failed.** Retrying automatically…${attemptSuffix}`
			: `⚠️ **AlphaPR review failed.** All retry attempts exhausted.${attemptSuffix}`;

	if (job.statusCommentId !== null) {
		try {
			await editComment(token, job.owner, job.repo, job.statusCommentId, commentText);
		} catch {
			/* fall through to check-run update */
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

export async function handlePREvent(job: ReviewJob, env: Env): Promise<void> {
	const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
	const token = await getInstallationToken(jwt, job.installationId);

	// ─── BYOK: resolve per-installation key + model + config ───
	const installation = await getInstallation(env.DB, job.installationId);

	let apiKey: string;
	let model: string;
	let reviewTone: 'thorough' | 'concise' = 'thorough';
	let severityThreshold = 'all';
	let ignorePaths: string[] = [];
	let provider: Provider = 'openrouter';

	if (installation?.api_key_encrypted) {
		try {
			apiKey = await decryptSecret(installation.api_key_encrypted, env.KEY_ENCRYPTION_SECRET);
		} catch (err) {
			throw new PermanentError(
				`Failed to decrypt API key for installation ${job.installationId}: ${err instanceof Error ? err.message : err}`,
				{ cause: err },
			);
		}
		model = installation.model;
		reviewTone = installation.review_tone === 'concise' ? 'concise' : 'thorough';
		severityThreshold = installation.severity_threshold;
		ignorePaths = installation.ignore_paths ? installation.ignore_paths.split(',') : [];
		provider = parseProvider(installation.provider);
	} else if (job.owner === env.FALLBACK_OWNER) {
		apiKey = env.OPENROUTER_API_KEY;
		model = 'deepseek/deepseek-v4-flash';
	} else {
		const setupMessage = `⚙️ **AlphaPR is installed but not configured yet.**\n\nAn OpenRouter API key is needed for this installation. Configure it at https://alphapr.covenantekojoe.workers.dev/setup — once configured, close and re-open this PR to trigger a review.`;

		if (job.statusCommentId !== null) {
			if (job.action === 'opened') {
				await editComment(token, job.owner, job.repo, job.statusCommentId, setupMessage);
			} else {
				await editComment(token, job.owner, job.repo, job.statusCommentId, '⚙️ Not configured — see setup instructions above.');
			}
		} else if (job.action === 'opened') {
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

	const state = await getReviewState(env.DB, job.repoFullName, job.prNumber);
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
			supportsReasoning: model.includes('-pro'),
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
		try {
			await completeCheckRun(
				token,
				job.owner,
				job.repo,
				job.checkRunId,
				conclusion,
				title,
				`${anchoredCount} inline comment${anchoredCount === 1 ? '' : 's'}, ${unanchored.length} in summary.`,
			);
		} catch (err) {
			console.error(`Failed to complete check run: ${err instanceof Error ? err.message : err}`);
		}
	}

	try {
		await saveReviewState(env.DB, job.repoFullName, job.prNumber, job.headSha, renderForMemory(result));
	} catch (err) {
		console.error(`Failed to save review state (comments already posted): ${err instanceof Error ? err.message : err}`);
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
