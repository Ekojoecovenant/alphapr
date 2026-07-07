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
	const prNumber = payload.number;

	const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
	const token = await getInstallationToken(jwt, installationId);

	const diffRes = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github.diff",
				"User-Agent": "alphacode-pr-agent",
			},
		}
	);

	const diff = await diffRes.text();

	const review = await reviewDiff(diff, {
		apiKey: env.OPENROUTER_API_KEY,
		model: "deepseek/deepseek-v4-flash",
	});

	await postReviewComment(token, owner, repo, prNumber, review);
	console.log(`✅ Posted review on PR #${prNumber}`);
}