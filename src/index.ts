import { upsertInstallation, deleteInstallation } from "./db";
import { postReviewComment, createCheckRun } from "./github/api";
import { createAppJWT, getInstallationToken } from "./github/auth";
import { verifySignature } from "./verify";
import { PermanentError } from "./errors";
import { handleSetup } from "./setup";
import { handlePREvent, surfaceFailure, type ReviewJob } from "./review-handler";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const setupResponse = await handleSetup(request, env);
    if (setupResponse) return setupResponse;

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

    if (
      event === "pull_request" &&
      (payload.action === "opened" || payload.action === "synchronize")
    ) {
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
          statusCommentId = await postReviewComment(
            token,
            owner,
            repo,
            prNumber,
            "🔍 **AlphaPR is reviewing this PR…**"
          );
        } catch (err) {
          console.error(
            `Failed to post status comment (continuing): ${err instanceof Error ? err.message : err}`
          );
        }

        try {
          checkRunId = await createCheckRun(token, owner, repo, headSha);
        } catch (err) {
          console.error(
            `Failed to create check run (continuing): ${err instanceof Error ? err.message : err}`
          );
        }
      } catch (err) {
        console.error(
          `Failed to authenticate for pre-review setup (continuing): ${err instanceof Error ? err.message : err}`
        );
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

      if (env.QUEUE_MODE !== "true") {
        ctx.waitUntil(
          handlePREvent(job, env).catch(async (err) => {
            console.error(
              `Free-tier review failed (no retry): ${err instanceof Error ? err.message : err}`
            );
            await surfaceFailure(job, env, err instanceof PermanentError, false).catch(() => {});
          })
        );
      } else {
        await env.REVIEW_QUEUE?.send(job);
      }
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
        const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);

        if (isPermanent) {
          console.error(`Permanent failure, not retrying: ${errMsg}`);
        } else {
          console.error(`Review job failed (attempt ${message.attempts}): ${errMsg}`);
        }

        await surfaceFailure(message.body, env, isPermanent, !isPermanent).catch(() => {});

        if (isPermanent) {
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },
};
