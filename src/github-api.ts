import { PermanentError } from "./errors";

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
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/check-runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "alphapr",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "AlphaPR Review",
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 404 || res.status === 403) {
      throw new PermanentError(`Failed to create check run: ${res.status} ${text}`);
    }
    throw new Error(`Failed to create check run: ${res.status} ${text}`);
  }
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
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "alphapr",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output: { title, summary },
      }),
    }
  );
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 404 || res.status === 403) {
      throw new PermanentError(`Failed to complete check run: ${res.status} ${text}`);
    }
    throw new Error(`Failed to complete check run: ${res.status} ${text}`);
  }
}