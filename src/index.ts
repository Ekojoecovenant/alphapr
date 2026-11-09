import { handleAuth } from './auth';
import { handleDashboard } from './dashboard';
import { deleteInstallation, getReviewState, upsertInstallation } from './db';
import { PermanentError } from './errors';
import { createCheckRun, postReviewComment } from './github/api';
import { createAppJWT, getInstallationToken } from './github/auth';
import { shouldReviewRepo } from './review-config';
import { decideReview, isReviewAction } from './review-gate';
import { handlePREvent, type ReviewJob, surfaceFailure } from './review-handler';
import { htmlHeaders, THREE_CDN_ORIGIN } from './security';
import { handleSetup } from './setup';
import { landingPage } from './setup-pages';
import { verifySignature } from './verify';

/** Queue name is declared in wrangler.jsonc — keep these in sync. */
const DEAD_LETTER_QUEUE_NAME = 'pr-review-dlq';

/** Must match wrangler.jsonc's consumer `max_retries` for pr-review-jobs. */
const MAX_RETRIES = 2;

/**
 * GitHub caps webhook payloads at 25 MB. Anything bigger is not a payload we
 * would have completed on anyway, and buffering it before the signature check
 * is free memory pressure for whoever sends it.
 */
const MAX_WEBHOOK_BYTES = 20_000_000;

/**
 * Dead-lettered jobs carry no error text (the worker that failed is gone), so
 * the surfaced reason has to be stated rather than quoted.
 */
const DEAD_LETTER_DETAIL = 'The review did not finish — the worker was interrupted or timed out. Re-run it by pushing a new commit.';

/**
 * Free-tier mode has no queue to retry in, so a transient failure gets one
 * inline retry. The budget is deliberately small: `ctx.waitUntil` work races the
 * worker's lifetime, and a retry is only worth it when the first attempt failed
 * *fast* (a 429, a 5xx, a reset connection). An attempt that burned 100s on a
 * timeout has already spent the allowance, so it is reported instead.
 */
const FREE_TIER_ATTEMPTS = 2;
const FREE_TIER_BACKOFF_MS = 2000;
const FREE_TIER_RETRY_ELAPSED_LIMIT_MS = 20_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorDetail(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Run one review inline (free tier), retrying a transient failure once.
 * Never throws — every outcome is reported on the PR or the check run.
 */
export async function runFreeTierReview(job: ReviewJob, env: Env): Promise<void> {
	const startedAt = Date.now();

	for (let attempt = 1; attempt <= FREE_TIER_ATTEMPTS; attempt++) {
		try {
			await handlePREvent(job, env);
			return;
		} catch (err) {
			const isPermanent = err instanceof PermanentError;
			const detail = errorDetail(err);
			const elapsed = Date.now() - startedAt;
			const canRetry = !isPermanent && attempt < FREE_TIER_ATTEMPTS && elapsed <= FREE_TIER_RETRY_ELAPSED_LIMIT_MS;

			console.error(`Free-tier review failed (attempt ${attempt}/${FREE_TIER_ATTEMPTS}): ${detail}`);

			if (!canRetry) {
				await surfaceFailure(job, env, isPermanent, false, attempt, FREE_TIER_ATTEMPTS, detail).catch(() => {
					// best-effort: a failure here must never crash the dispatch path
				});
				return;
			}

			// Tell the PR a retry is coming, so it does not sit on a stale "Reviewing…".
			await surfaceFailure(job, env, false, true, attempt, FREE_TIER_ATTEMPTS, detail).catch(() => {
				// best-effort: a failure here must never crash the dispatch path
			});
			await sleep(FREE_TIER_BACKOFF_MS);
		}
	}
}

/**
 * Drain the dead-letter queue.
 *
 * Messages only land here when the worker died outside the normal failure path
 * — a timeout, a crash, or a restart mid-review — so nothing was ever reported
 * to the PR. Log each one loudly and surface a failure, otherwise a PR sits
 * looking untouched with no review and no explanation.
 */
async function handleDeadLetter(batch: MessageBatch<ReviewJob>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const job = message.body;
		const where = job ? `${job.owner}/${job.repo} #${job.prNumber} @${job.headSha.slice(0, 7)}` : '(unreadable body)';

		console.error(
			`💀 Dead-lettered review job ${where} (action=${job?.action ?? 'unknown'}, attempts=${message.attempts}) — the review never completed and was not reported.`,
		);

		if (job) {
			await surfaceFailure(job, env, false, false, message.attempts, MAX_RETRIES + 1, DEAD_LETTER_DETAIL).catch(() => {
				// best-effort: draining must never fail on a status-surface error
			});
		}

		message.ack(); // nothing else can be done — drain so the queue does not accumulate
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const setupResponse = await handleSetup(request, env);
		if (setupResponse) return setupResponse;

		// Sign-in, sign-out and the dashboard. Both return null for other paths.
		const authResponse = await handleAuth(request, env);
		if (authResponse) return authResponse;

		const dashboardResponse = await handleDashboard(request, env);
		if (dashboardResponse) return dashboardResponse;

		if (request.method !== 'POST') {
			const { pathname } = new URL(request.url);
			if (pathname !== '/') {
				return new Response('not found', { status: 404 });
			}
			return new Response(landingPage(), {
				status: 200,
				headers: htmlHeaders({
					csp: { scripts: [THREE_CDN_ORIGIN] },
					cacheControl: 'public, max-age=300',
				}),
			});
		}

		const declaredLength = Number(request.headers.get('content-length') ?? '0');
		if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
			return new Response('payload too large', { status: 413 });
		}
		const rawBody = await request.text();
		// `string.length` counts UTF-16 code units, and a code unit can encode to
		// three UTF-8 bytes — so a payload full of non-ASCII text can exceed the
		// byte cap while looking short. Only the near-limit bodies pay for the
		// exact count; anything under a third of the cap is safely under it.
		if (rawBody.length > MAX_WEBHOOK_BYTES / 3 && new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) {
			return new Response('payload too large', { status: 413 });
		}

		const valid = await verifySignature(env.GITHUB_WEBHOOK_SECRET, rawBody, request.headers.get('x-hub-signature-256'));

		if (!valid) {
			console.log('Signature verification FAILED');
			return new Response('invalid signature', { status: 401 });
		}

		const event = request.headers.get('x-github-event');
		const payload = JSON.parse(rawBody);

		if (event === 'installation') {
			if (payload.action === 'created') {
				await upsertInstallation(env.DB, payload.installation.id, payload.installation.account.login);
				console.log(`📦 Installation created: ${payload.installation.account.login} (${payload.installation.id})`);
			} else if (payload.action === 'deleted') {
				await deleteInstallation(env.DB, payload.installation.id);
				console.log(`🗑️ Installation deleted: ${payload.installation.id}`);
			}
			return new Response('ok', { status: 200 });
		}

		if (event === 'pull_request' && isReviewAction(payload.action)) {
			const pullRequest = payload.pull_request;

			// Best-effort dedupe lookup: a database hiccup must never suppress a
			// review, so a failure here falls through to reviewing as normal.
			let lastReviewedSha: string | null = null;
			try {
				const prior = await getReviewState(env.DB, payload.installation.id, payload.repository.full_name, payload.number);
				lastReviewedSha = prior?.last_reviewed_sha ?? null;
			} catch (err) {
				console.error(`Could not read review state for dedupe (reviewing anyway): ${err instanceof Error ? err.message : err}`);
			}

			const decision = decideReview({
				draft: pullRequest.draft,
				title: pullRequest.title,
				headSha: pullRequest.head.sha,
				lastReviewedSha,
			});

			if (!decision.run) {
				console.log(`⏭️ Skipping review for PR #${payload.number} (${decision.reason})`);
				return new Response('ok', { status: 200 });
			}

			// A repo switched off on the dashboard is skipped silently: no status
			// comment, no check run. Disabling should look like AlphaPR is not here.
			if (!(await shouldReviewRepo(env.DB, payload.installation.id, payload.repository.owner.login, payload.repository.name))) {
				console.log(`⏭️ Skipping review for ${payload.repository.full_name} (disabled on dashboard)`);
				return new Response('ok', { status: 200 });
			}

			const installationId = payload.installation.id;
			const owner = payload.repository.owner.login;
			const repo = payload.repository.name;
			const prNumber = payload.number;
			const headSha = pullRequest.head.sha;

			let statusCommentId: number | null = null;
			let checkRunId: number | null = null;
			try {
				const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
				const token = await getInstallationToken(jwt, installationId);

				try {
					statusCommentId = await postReviewComment(token, owner, repo, prNumber, '🔍 **AlphaPR is reviewing this PR…**');
				} catch (err) {
					console.error(`Failed to post status comment (continuing): ${err instanceof Error ? err.message : err}`);
				}

				try {
					checkRunId = await createCheckRun(token, owner, repo, headSha);
				} catch (err) {
					console.error(`Failed to create check run (continuing): ${err instanceof Error ? err.message : err}`);
				}
			} catch (err) {
				console.error(`Failed to authenticate for pre-review setup (continuing): ${err instanceof Error ? err.message : err}`);
			}

			const job: ReviewJob = {
				installationId,
				owner,
				repo,
				repoFullName: payload.repository.full_name,
				prNumber,
				headSha,
				action: payload.action,
				statusCommentId,
				checkRunId,
			};

			if (env.QUEUE_MODE !== 'true') {
				// No queue on the free tier — retry transient failures inline instead.
				ctx.waitUntil(runFreeTierReview(job, env));
			} else {
				await env.REVIEW_QUEUE?.send(job);
			}
		}

		return new Response('ok', { status: 200 });
	},

	async queue(batch: MessageBatch<ReviewJob>, env: Env): Promise<void> {
		if (batch.queue === DEAD_LETTER_QUEUE_NAME) {
			await handleDeadLetter(batch, env);
			return;
		}

		for (const message of batch.messages) {
			try {
				await handlePREvent(message.body, env);
				message.ack();
			} catch (err) {
				const isPermanent = err instanceof PermanentError;
				const isFinalAttempt = message.attempts >= MAX_RETRIES + 1; // +1: attempts is 1-indexed
				const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);

				if (isPermanent) {
					console.error(`Permanent failure, not retrying: ${errMsg}`);
				} else if (isFinalAttempt) {
					console.error(`Final attempt (${message.attempts}/${MAX_RETRIES + 1}) failed, giving up: ${errMsg}`);
				} else {
					console.error(`Review job failed (attempt ${message.attempts}/${MAX_RETRIES + 1}): ${errMsg}`);
				}

				const willRetry = !isPermanent && !isFinalAttempt;
				await surfaceFailure(
					message.body,
					env,
					isPermanent,
					willRetry,
					message.attempts,
					MAX_RETRIES + 1,
					err instanceof Error ? err.message : String(err),
				).catch(() => {
					// best-effort: a failure here must never crash the queue consumer
				});

				if (isPermanent || isFinalAttempt) {
					message.ack(); // stop retrying — either permanent, or out of attempts
				} else {
					message.retry();
				}
			}
		}
	},
};
