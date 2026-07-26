import {
  getReviewState,
  saveReviewState,
  upsertInstallation,
  deleteInstallation,
  getInstallation,
} from "./db";
import { postReviewComment, editComment } from "./github-api";
import { createAppJWT, getInstallationToken } from "./github-auth";
import { reviewDiff } from "./llm";
import { verifySignature } from "./verify";
import { decryptSecret } from "./crypto";
import { PermanentError } from "./errors";

interface ReviewJob {
  installationId: number;
  owner: string;
  repo: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  action: "opened" | "synchronize";
  statusCommentId: number | null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("AlphaPR is alive", { status: 200 });
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

    // Installation lifecycle — creates/removes tenant rows
    if (event === "installation") {
      if (payload.action === "created") {
        await upsertInstallation(
          env.DB,
          payload.installation.id,
          payload.installation.account.login
        );
        console.log(
          `📦 Installation created: ${payload.installation.account.login} (${payload.installation.id})`
        );
      } else if (payload.action === "deleted") {
        await deleteInstallation(env.DB, payload.installation.id);
        console.log(`🗑️ Installation deleted: ${payload.installation.id}`);
      }
      return new Response("ok", { status: 200 });
    }

    // PR events — post status placeholder, then enqueue
    if (
      event === "pull_request" &&
      (payload.action === "opened" || payload.action === "synchronize")
    ) {
      const installationId = payload.installation.id;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const prNumber = payload.number;

      // Post the "reviewing..." placeholder. Best-effort: a failure here
      // must never block the actual review from being enqueued.
      let statusCommentId: number | null = null;
      try {
        const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
        const token = await getInstallationToken(jwt, installationId);
        statusCommentId = await postReviewComment(
          token,
          owner,
          repo,
          prNumber,
          "🔍 **AlphaPR is reviewing this PR…**"
        );
      } catch (err) {
        console.error("Failed to post status comment (continuing anyway):", err);
      }

      const job: ReviewJob = {
        installationId,
        owner,
        repo,
        repoFullName: payload.repository.full_name,
        prNumber,
        headSha: payload.pull_request.head.sha,
        action: payload.action,
        statusCommentId,
      };
      await env.REVIEW_QUEUE.send(job);
    }

    return new Response("ok", { status: 200 });
  },

  async queue(batch: MessageBatch<ReviewJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handlePREvent(message.body, env);
        message.ack();
      } catch (err) {
        const isPermanent = err instanceof PermanentError;

        if (isPermanent) {
          console.error(`Permanent failure, not retrying:`, err);
        } else {
          console.error(`Review job failed (attempt ${message.attempts}):`, err);
        }

        // Best-effort: surface the failure on the PR via the status comment.
        // Wrapped so a failed edit can never mask or break the queue handling.
        if (message.body.statusCommentId !== null) {
          try {
            const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
            const token = await getInstallationToken(jwt, message.body.installationId);
            await editComment(
              token,
              message.body.owner,
              message.body.repo,
              message.body.statusCommentId,
              isPermanent
                ? "⚠️ **AlphaPR review failed.** This won't be retried — check your installation's configuration."
                : "⚠️ **AlphaPR review failed.** Retrying automatically…"
            );
          } catch {
            /* never let status-surfacing break the queue handler */
          }
        }

        if (isPermanent) {
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },
};

async function handlePREvent(job: ReviewJob, env: Env) {
  const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const token = await getInstallationToken(jwt, job.installationId);

  // ─── BYOK: resolve per-installation key + model ───
  const installation = await getInstallation(env.DB, job.installationId);

  let apiKey: string;
  let model: string;

  if (installation?.api_key_encrypted) {
    try {
      apiKey = await decryptSecret(installation.api_key_encrypted, env.KEY_ENCRYPTION_SECRET);
    } catch (err) {
      throw new PermanentError(
        `Failed to decrypt API key for installation ${job.installationId}: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
    model = installation.model;
  } else if (job.owner === env.FALLBACK_OWNER) {
    // Owner fallback: my own installs use the env key
    apiKey = env.OPENROUTER_API_KEY;
    model = "deepseek/deepseek-v4-pro";
  } else {
    // Installed but unconfigured — inform once, don't fail
    const setupMessage = `⚙️ **AlphaPR is installed but not configured yet.**\n\nAn OpenRouter API key is needed for this installation. See the [setup guide](https://github.com/Ekojoecovenant/alphapr#self-hosting) or contact the person who installed AlphaPR. Once configured, close and re-open this PR to trigger a review.`;

    if (job.statusCommentId !== null) {
      // Edit the "reviewing..." placeholder so it doesn't strand forever
      await editComment(token, job.owner, job.repo, job.statusCommentId, setupMessage);
    } else if (job.action === "opened") {
      await postReviewComment(token, job.owner, job.repo, job.prNumber, setupMessage);
    }
    return; // handled outcome — no retry
  }
  // ─── end BYOK resolution ───

  const state = await getReviewState(env.DB, job.repoFullName, job.prNumber);
  const incremental = state !== null && job.action === "synchronize";

  const compareUrl = `https://api.github.com/repos/${job.owner}/${job.repo}/compare/${state?.last_reviewed_sha}...${job.headSha}`;
  const fullPrUrl = `https://api.github.com/repos/${job.owner}/${job.repo}/pulls/${job.prNumber}`;

  const diffHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.diff",
    "User-Agent": "alphapr",
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
        throw new Error(
          `Failed to fetch full diff after fallback: ${fullRes.status} ${(await fullRes.text()).slice(0, 300)}`
        );
      }
      diff = await fullRes.text();
    } else {
      throw new Error(
        `Failed to fetch compare diff: ${compareRes.status} ${(await compareRes.text()).slice(0, 300)}`
      );
    }
  } else {
    const fullRes = await fetch(fullPrUrl, { headers: diffHeaders });
    if (!fullRes.ok) {
      throw new Error(
        `Failed to fetch full diff: ${fullRes.status} ${(await fullRes.text()).slice(0, 300)}`
      );
    }
    diff = await fullRes.text();
  }

  const review = await reviewDiff(
    diff,
    { apiKey, model },
    usedIncremental ? state!.last_review_body ?? undefined : undefined
  );

  // Morph the placeholder into the verdict — or post fresh if the placeholder failed
  if (job.statusCommentId !== null) {
    await editComment(token, job.owner, job.repo, job.statusCommentId, review);
  } else {
    await postReviewComment(token, job.owner, job.repo, job.prNumber, review);
  }

  await saveReviewState(env.DB, job.repoFullName, job.prNumber, job.headSha, review);
  console.log(`✅ Posted ${usedIncremental ? "incremental" : "full"} review on PR #${job.prNumber}`);
}