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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      
      if (env.QUEUE_MODE === "false") {
        ctx.waitUntil(
          handlePREvent(job, env).catch((err) => {
            console.error(
              `Free-tier review failed (no retry): ${err instanceof Error ? err.message : err}`
            );
            // Best-effort: surface the failure since there's no queue catch block to do it
            surfaceFailure(job, env, err instanceof PermanentError).catch(() => {});
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

        // Best-effort: surface the failure on the PR (status comment + check run).
        await surfaceFailure(message.body, env, isPermanent).catch(() => {});

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

  let reviewTone: "thorough" | "concise" = "thorough";
  let severityThreshold = "all";
  let ignorePaths: string[] = [];

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
    reviewTone = (installation.review_tone === "concise" ? "concise" : "thorough");
    severityThreshold = installation.severity_threshold;
    ignorePaths = installation.ignore_paths ? installation.ignore_paths.split(",") : [];
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
  const parsed = parseDiff(diff, ignorePaths);

  const result = await reviewDiff(
    parsed.annotated,
    { apiKey, model, reviewTone },
    usedIncremental ? state!.last_review_body ?? undefined : undefined
  );

  // Apply severity threshold for DISPLAY/CHECK only — never mutate result.findings,
  // since renderForMemory needs the FULL set for accurate incremental review state.
  const rank: Record<string, number> = { major: 0, minor: 1, nit: 2 };
  const thresholdRank =
    severityThreshold === "major" ? 0 : severityThreshold === "minor" ? 1 : 2;
  const filteredFindings = result.findings.filter((f) => rank[f.severity] <= thresholdRank);

  const verdict = result.raw
    ? result.verdict
    : (() => {
        const majorCount = filteredFindings.filter((f) => f.severity === "major").length;
        const minorCount = filteredFindings.filter((f) => f.severity === "minor").length;
        const nitCount = filteredFindings.filter((f) => f.severity === "nit").length;
        return filteredFindings.length === 0
          ? "✅ LGTM — no issues found."
          : `⚠️ ${filteredFindings.length} issues (${majorCount} major, ${minorCount} minor, ${nitCount} nits)`;
      })();

  const displayResult = { ...result, findings: filteredFindings, verdict };

  // Split findings into anchorable vs not, validated against the real diff
  const anchored: Finding[] = [];
  const unanchored: Finding[] = [];
  for (const f of displayResult.findings) {
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
        displayResult.verdict,
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

  const summary = renderSummary(displayResult, anchoredCount, unanchored);
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

  // Conclude the check run based on the DISPLAYED (filtered) outcome —
  // the check should reflect what the team asked to be shown, not the raw findings.
  if (job.checkRunId !== null) {
    const hasMajor = displayResult.findings.some((f) => f.severity === "major");
    const conclusion: CheckConclusion = displayResult.raw
      ? "neutral"
      : hasMajor
        ? "action_required"
        : displayResult.findings.length > 0
          ? "neutral"
          : "success";
    const title = displayResult.raw ? "Review posted" : displayResult.verdict;
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

  // Memory stores the FULL, UNFILTERED review — so future incremental context
  // knows about every point ever raised, regardless of what was shown this time.
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

async function surfaceFailure(job: ReviewJob, env: Env, isPermanent: boolean): Promise<void> {
  if (job.statusCommentId === null && job.checkRunId === null) return;
  const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const token = await getInstallationToken(jwt, job.installationId);

  if (job.statusCommentId !== null) {
    try {
      await editComment(
        token,
        job.owner,
        job.repo,
        job.statusCommentId,
        isPermanent
          ? "⚠️ **AlphaPR review failed.** This won't be retried — check your installation's configuration."
          : "⚠️ **AlphaPR review failed.**"
      );
    } catch {
      /* fall through to check-run update */
    }
  }

  if (job.checkRunId !== null) {
    try {
      await completeCheckRun(
        token,
        job.owner,
        job.repo,
        job.checkRunId,
        isPermanent ? "failure" : "neutral",
        "AlphaPR review failed",
        isPermanent ? "This won't be retried." : "Review failed."
      );
    } catch {
      /* never let status-surfacing throw further */
    }
  }
}