import { deleteInstallation, getReviewState, upsertInstallation } from './db';
import { PermanentError } from './errors';
import { createCheckRun, postReviewComment } from './github/api';
import { createAppJWT, getInstallationToken } from './github/auth';
import { decideReview, isReviewAction } from './review-gate';
import { handlePREvent, type ReviewJob, surfaceFailure } from './review-handler';
import { handleSetup } from './setup';
import { landingPage } from './setup-pages';
import { verifySignature } from './verify';

/** Queue name is declared in wrangler.jsonc — keep these in sync. */
const DEAD_LETTER_QUEUE_NAME = 'pr-review-dlq';

/** Must match wrangler.jsonc's consumer `max_retries` for pr-review-jobs. */
const MAX_RETRIES = 2;

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
			await surfaceFailure(job, env, false, false, message.attempts, MAX_RETRIES + 1).catch(() => {
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

		if (request.method !== 'POST') {
			const { pathname } = new URL(request.url);
			if (pathname !== '/') {
				return new Response('not found', { status: 404 });
			}
			return new Response(landingPage(), {
				status: 200,
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		const rawBody = await request.text();

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
				const prior = await getReviewState(env.DB, payload.repository.full_name, payload.number);
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
				ctx.waitUntil(
					handlePREvent(job, env).catch(async (err) => {
						console.error(`Free-tier review failed (no retry): ${err instanceof Error ? err.message : err}`);
						await surfaceFailure(job, env, err instanceof PermanentError, false, 1, 1).catch(() => {
							// best-effort: a failure here must never crash the free-tier dispatch path
						});
					}),
				);
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
				await surfaceFailure(message.body, env, isPermanent, willRetry, message.attempts, MAX_RETRIES + 1).catch(() => {
					// best-effort: a failure here must never crash the free-tier dispatch path
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
