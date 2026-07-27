import { PermanentError } from './errors';

// INTERFACES AND ENUMS

export interface ReviewCommentInput {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}


/**
 * Posts a comment to a GitHub pull request.
 *
 * @param owner - The GitHub repository owner
 * @param repo - The GitHub repository name
 * @param prNumber - The pull request number
 * @param body - The comment text
 * @returns The ID of the created comment
 */

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

/**
 * Updates the body of an existing GitHub issue comment.
 *
 * @param commentId - The identifier of the comment to update
 * @param body - The new comment body
 * @throws PermanentError If the comment is not found
 * @throws Error If the update request fails
 */
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

/**
 * Creates a pull request review with a comment and inline review comments.
 *
 * @param prNumber - The pull request number.
 * @param body - The review summary.
 * @param comments - The inline comments to include in the review.
 */
export async function createReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
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
      body: JSON.stringify({ body, event: "COMMENT", comments }),
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