import { PermanentError } from './errors';

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

    throw new Error(`Failed to edit comment ${commentId}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}