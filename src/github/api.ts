import { PermanentError } from "../errors";

async function githubApiCall(
  token: string,
  url: string,
  init: RequestInit,
  errorPrefix: string
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "alphapr",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 404 || res.status === 403) {
      throw new PermanentError(`${errorPrefix}: ${res.status} ${text}`);
    }
    throw new Error(`${errorPrefix}: ${res.status} ${text}`);
  }
  return res;
}

export async function postReviewComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<number> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "alphapr",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 404) {
      throw new PermanentError(`Failed to post comment: ${res.status} ${text}`);
    }
    throw new Error(`Failed to post comment: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { id: number };
  return data.id;
}

export async function editComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "alphapr",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 404) {
      throw new PermanentError(`Failed to edit comment ${commentId}: ${res.status} ${text}`);
    }
    throw new Error(`Failed to edit comment ${commentId}: ${res.status} ${text}`);
  }
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export async function createReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string,
  body: string,
  comments: ReviewCommentInput[]
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "alphapr",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ commit_id: commitId, body, event: "COMMENT", comments }),
    }
  );
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 404) {
      throw new PermanentError(`Failed to create review: ${res.status} ${text}`);
    }
    throw new Error(`Failed to create review: ${res.status} ${text}`);
  }
}

export async function createCheckRun(
  token: string,
  owner: string,
  repo: string,
  headSha: string
): Promise<number> {
  const res = await githubApiCall(
    token,
    `https://api.github.com/repos/${owner}/${repo}/check-runs`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "AlphaPR Review",
        head_sha: headSha,
        status: "in_progress",
        started_at: new Date().toISOString(),
      }),
    },
    "Failed to create check run"
  );
  const data = (await res.json()) as { id: number };
  return data.id;
}

export type CheckConclusion = "success" | "neutral" | "action_required" | "failure";

export async function completeCheckRun(
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
  conclusion: CheckConclusion,
  title: string,
  summary: string
): Promise<void> {
  await githubApiCall(
    token,
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output: { title, summary },
      }),
    },
    "Failed to complete check run"
  );
}

// NOTE: getPRDescription + updatePRDescription is a non-atomic read-modify-write.
// An author edit to the PR description between these two calls will be silently
// overwritten. Acceptable here because this path is best-effort (never blocks
// the main review) and the window is short — but future callers of these two
// functions should not assume atomicity.
export async function getPRDescription(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const res = await githubApiCall(
    token,
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    { method: "GET" },
    "Failed to fetch PR description"
  );
  const data = (await res.json()) as { body: string | null };
  return data.body ?? "";
}

export async function updatePRDescription(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  await githubApiCall(
    token,
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    { method: "PATCH", body: JSON.stringify({ body }) },
    "Failed to update PR description"
  );
}
