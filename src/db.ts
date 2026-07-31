// INTERFACES AND ENUMS

export interface InstallationConfig {
  installation_id: number;
  account_login: string;
  api_key_encrypted: string | null;
  model: string;
  severity_threshold: string;
  review_tone: string;
  ignore_paths: string;
  provider: string;
}


// HELPER FUNCTIONS

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

export async function upsertInstallation(
  db: D1Database,
  installationId: number,
  accountLogin: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO installations (installation_id, account_login)
       VALUES (?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login`
    )
    .bind(installationId, accountLogin)
    .run();
}

export async function deleteInstallation(db: D1Database, installationId: number): Promise<void> {
  await db.prepare(`DELETE FROM installations WHERE installation_id = ?`).bind(installationId).run();
}

export async function getInstallation(
  db: D1Database,
  installationId: number,
): Promise<InstallationConfig | null> {
  const row = await db
    .prepare(
      `SELECT installation_id, account_login, api_key_encrypted, model,
              severity_threshold, review_tone, ignore_paths, provider
       FROM installations WHERE installation_id = ?`
    )
    .bind(installationId)
    .first<InstallationConfig>();
  return row ?? null;
}
