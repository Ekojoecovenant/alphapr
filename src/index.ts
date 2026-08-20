import { deleteInstallation, upsertInstallation } from './db';
import { PermanentError } from './errors';
import { createCheckRun, postReviewComment } from './github/api';
import { createAppJWT, getInstallationToken } from './github/auth';
import { handlePREvent, type ReviewJob, surfaceFailure } from './review-handler';
import { handleSetup } from './setup';
import { landingPage } from './setup-pages';
import { shouldSkipReview } from './skip-review';
import { verifySignature } from './verify';

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

		if (event === 'pull_request' && (payload.action === 'opened' || payload.action === 'synchronize')) {
			if (shouldSkipReview(payload.pull_request.title)) {
				console.log(`⏭️ Skipping review for PR #${payload.number} — title contains "[skip alphapr]"`);
				return new Response('ok', { status: 200 });
			}

			const installationId = payload.installation.id;
			const owner = payload.repository.owner.login;
			const repo = payload.repository.name;
			const prNumber = payload.number;
			const headSha = payload.pull_request.head.sha;

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
		const MAX_RETRIES = 2; // must match wrangler.jsonc's consumer max_retries

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
