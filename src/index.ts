import {
  getReviewState,
  saveReviewState,
  upsertInstallation,
  deleteInstallation,
  getInstallation,
} from "./db";
import {
  postReviewComment,
  editComment,
  createReview,
  createCheckRun,
  completeCheckRun,
  type ReviewCommentInput,
  type CheckConclusion,
} from "./github-api";
import { createAppJWT, getInstallationToken } from "./github-auth";
import { reviewDiff, type Finding } from "./llm";
import { parseDiff } from "./diff";
import {
  renderAnchoredComment,
  renderSummary,
  renderForMemory,
  sortFindings,
} from "./render";
import { verifySignature } from "./verify";
import { decryptSecret } from "./crypto";
import { PermanentError } from "./errors";
import { handleSetup } from "./setup";

interface ReviewJob {
  installationId: number;
  owner: string;
  repo: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  action: "opened" | "synchronize";
  statusCommentId: number | null;
  checkRunId: number | null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Self-serve setup routes (own auth: OAuth + signed tokens)
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

    // PR events — post status placeholder + check run, then enqueue
    if (
      event === "pull_request" &&
      (payload.action === "opened" || payload.action === "synchronize")
    ) {
      const installationId = payload.installation.id;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const prNumber = payload.number;
      const headSha = payload.pull_request.head.sha;

      // Mint one token for both the status comment and the check run.
      // Best-effort: failures here must never block enqueueing the review.
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
        const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);

        if (isPermanent) {
          console.error(`Permanent failure, not retrying: ${errMsg}`);
        } else {
          console.error(`Review job failed (attempt ${message.attempts}): ${errMsg}`);
        }

        // Best-effort: surface the failure on the PR (status comment + check run).
        const body = message.body;
        if (body.statusCommentId !== null || body.checkRunId !== null) {
          try {
            const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
            const token = await getInstallationToken(jwt, body.installationId);

            if (body.statusCommentId !== null) {
              try {
                await editComment(
                  token,
                  body.owner,
                  body.repo,
                  body.statusCommentId,
                  isPermanent
                    ? "⚠️ **AlphaPR review failed.** This won't be retried — check your installation's configuration."
                    : "⚠️ **AlphaPR review failed.** Retrying automatically…"
                );
              } catch {
                /* fall through to the check-run update */
              }
            }

            if (body.checkRunId !== null) {
              try {
                await completeCheckRun(
                  token,
                  body.owner,
                  body.repo,
                  body.checkRunId,
                  isPermanent ? "failure" : "neutral",
                  "AlphaPR review failed",
                  isPermanent ? "This won't be retried." : "Retrying automatically…"
                );
              } catch {
                /* never let status-surfacing break the queue handler */
              }
            }
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
    model = "deepseek/deepseek-v4-flash";
  } else {
    // Installed but unconfigured — inform once, conclude the check, don't fail
    const setupMessage = `⚙️ **AlphaPR is installed but not configured yet.**\n\nAn OpenRouter API key is needed for this installation. Configure it at https://alphapr.covenantekojoe.workers.dev/setup — once configured, close and re-open this PR to trigger a review.`;

    if (job.statusCommentId !== null) {
      if (job.action === "opened") {
        await editComment(token, job.owner, job.repo, job.statusCommentId, setupMessage);
      } else {
        await editComment(
          token,
          job.owner,
          job.repo,
          job.statusCommentId,
          "⚙️ Not configured — see setup instructions above."
        );
      }
    } else if (job.action === "opened") {
      await postReviewComment(token, job.owner, job.repo, job.prNumber, setupMessage);
    }

    if (job.checkRunId !== null) {
      await completeCheckRun(
        token,
        job.owner,
        job.repo,
        job.checkRunId,
        "neutral",
        "AlphaPR not configured",
        "No OpenRouter API key is configured for this installation."
      );
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

  // Parse + annotate the diff so the model gets real line numbers
  const parsed = parseDiff(diff);

  const result = await reviewDiff(
    parsed.annotated,
    { apiKey, model },
    usedIncremental ? state!.last_review_body ?? undefined : undefined
  );

  // Split findings into anchorable vs not, validated against the real diff
  const anchored: Finding[] = [];
  const unanchored: Finding[] = [];
  for (const f of result.findings) {
    if (parsed.validLines.get(f.path)?.has(f.line)) {
      anchored.push(f);
    } else {
      console.log(`Unanchorable finding: ${f.path}:${f.line} (not in diff)`);
      unanchored.push(f);
    }
  }

  // Post anchored findings as inline review comments; on failure, demote to summary
  let anchoredCount = 0;
  if (anchored.length > 0) {
    const comments: ReviewCommentInput[] = sortFindings(anchored).map((f) => ({
      path: f.path,
      line: f.line,
      side: "RIGHT",
      body: renderAnchoredComment(f),
    }));
    try {
      await createReview(
        token,
        job.owner,
        job.repo,
        job.prNumber,
        job.headSha,
        result.verdict,
        comments
      );
      anchoredCount = anchored.length;
    } catch (err) {
      console.error(
        `createReview failed; demoting anchored findings to summary: ${err instanceof Error ? err.message : err}`
      );
      unanchored.push(...anchored);
    }
  }

  // Status comment morphs into the verdict + summary of anything unanchorable.
  // Best-effort: inline comments may already be posted — a failure here must not retry the LLM run.
  const summary = renderSummary(result, anchoredCount, unanchored);
  try {
    if (job.statusCommentId !== null) {
      await editComment(token, job.owner, job.repo, job.statusCommentId, summary);
    } else {
      await postReviewComment(token, job.owner, job.repo, job.prNumber, summary);
    }
  } catch (err) {
    console.error(
      `Failed to post/edit summary (inline comments may already be posted): ${err instanceof Error ? err.message : err}`
    );
  }

  // Conclude the check run based on the review outcome.
  if (job.checkRunId !== null) {
    const hasMajor = result.findings.some((f) => f.severity === "major");
    const conclusion: CheckConclusion = result.raw
      ? "neutral"
      : hasMajor
        ? "action_required"
        : result.findings.length > 0
          ? "neutral"
          : "success";
    const title = result.raw ? "Review posted" : result.verdict;
    try {
      await completeCheckRun(
        token,
        job.owner,
        job.repo,
        job.checkRunId,
        conclusion,
        title,
        `${anchoredCount} inline comment${anchoredCount === 1 ? "" : "s"}, ${unanchored.length} in summary.`
      );
    } catch (err) {
      console.error(`Failed to complete check run: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Memory stores the FULL review (all findings) regardless of where they were posted
  try {
    await saveReviewState(
      env.DB,
      job.repoFullName,
      job.prNumber,
      job.headSha,
      renderForMemory(result)
    );
  } catch (err) {
    console.error(
      `Failed to save review state (comments already posted): ${err instanceof Error ? err.message : err}`
    );
  }
  console.log(
    `✅ Posted ${usedIncremental ? "incremental" : "full"} review on PR #${job.prNumber} (${anchoredCount} inline, ${unanchored.length} in summary)`
  );
}