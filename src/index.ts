import { getReviewState, saveReviewState } from './db';
import { postReviewComment } from './github-api';
import { createAppJWT, getInstallationToken } from './github-auth';
import { reviewDiff } from './llm';
import { verifySignature } from "./verify";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("PR Agent is alive", { status: 200 });
    }

    const rawBody = await request.text();

    const valid = await verifySignature(
      env.GITHUB_WEBHOOK_SECRET,
      rawBody,
      request.headers.get("x-hub-signature-256")
    );

    if (!valid) {
      console.log("Signature verification FAILED");
      return new Response("invalid signature", { status: 401 });
    }

    const event = request.headers.get("x-github-event");
    const payload = JSON.parse(rawBody);

    if (
			event === "pull_request" &&
			(payload.action === "opened" || payload.action === "synchronize")
		) {
			ctx.waitUntil(
				handlePREvent(payload, env).catch((err) => {
					console.error(`PR event handling failed:`, err);
				})
			);
		}

    return new Response("ok", { status: 200 });
  },
};

async function handlePREvent(payload: any, env: Env) {
	const installationId = payload.installation.id;
	const owner = payload.repository.owner.login;
	const repo = payload.repository.name;
	const repoFullName = payload.repository.full_name;
	const prNumber = payload.number;
	const headSha = payload.pull_request.head.sha;

	const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
	const token = await getInstallationToken(jwt, installationId);

	const state = await getReviewState(env.DB, repoFullName, prNumber);

	const incremental = state !== null && payload.action === "synchronize";

	const compareUrl = `https://api.github.com/repos/${owner}/${repo}/compare/${state?.last_reviewed_sha}...${headSha}`;
	const fullPrUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

	const diffHeaders = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github.diff",
		"User-Agent": "alphacode-pr-agent",
	};

	let diff: string;
	let usedIncremental = incremental;

	if (incremental) {
		const compareRes = await fetch(compareUrl, { headers: diffHeaders });

		if (compareRes.ok) {
			diff = await compareRes.text();
		} else if (compareRes.status === 404) {
			console.log(`Compare 404 (force-push?), falling back to full diff for PR #${prNumber}`);
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
	
	const review = await reviewDiff(
		diff,
		{ apiKey: env.OPENROUTER_API_KEY, model: "deepseek/deepseek-v4-pro" },
		usedIncremental ? state!.last_review_body ?? undefined : undefined
	);

	await postReviewComment(token, owner, repo, prNumber, review);
	await saveReviewState(env.DB, repoFullName, prNumber, headSha, review);
	console.log(`✅ Posted ${incremental ? "incremental" : "full"} review on PR #${prNumber}`);
}