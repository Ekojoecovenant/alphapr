export async function getReviewState(
  db: D1Database,
  repoFullName: string,
  prNumber: number,
): Promise<{ last_reviewed_sha: string, last_review_body: string | null} | null> {
  const row = await db
    .prepare(
      `SELECT last_reviewed_sha, last_review_body
       FROM pr_reviews
       WHERE repo_full_name = ? AND pr_number = ?`
    )
    .bind(repoFullName, prNumber)
    .first<{ last_reviewed_sha: string; last_review_body: string | null }>();

  return row ?? null;
}

export async function saveReviewState(
  db: D1Database,
  repoFullName: string,
  prNumber: number,
  sha: string,
  reviewBody: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pr_reviews (repo_full_name, pr_number, last_reviewed_sha, last_review_body)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(repo_full_name, pr_number)
      DO UPDATE SET last_reviewed_sha = excluded.last_reviewed_sha,
        last_review_body = excluded.last_review_body,
        reviewed_at = datetime('now')`
    )
    .bind(repoFullName, prNumber, sha, reviewBody)
    .run();
}