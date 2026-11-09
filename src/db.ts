// INTERFACES AND ENUMS

import type { TokenUsage } from './types';

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
	installationId: number,
	repoFullName: string,
	prNumber: number,
): Promise<{ last_reviewed_sha: string; last_review_body: string | null } | null> {
	const row = await db
		.prepare(
			`SELECT last_reviewed_sha, last_review_body
       FROM pr_reviews
       WHERE installation_id = ? AND repo_full_name = ? AND pr_number = ?`,
		)
		.bind(installationId, repoFullName, prNumber)
		.first<{ last_reviewed_sha: string; last_review_body: string | null }>();

	return row ?? null;
}

export async function saveReviewState(
	db: D1Database,
	installationId: number,
	repoFullName: string,
	prNumber: number,
	sha: string,
	reviewBody: string,
	usage?: TokenUsage | null,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO pr_reviews (installation_id, repo_full_name, pr_number, last_reviewed_sha, last_review_body, input_tokens, output_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(installation_id, repo_full_name, pr_number)
      DO UPDATE SET last_reviewed_sha = excluded.last_reviewed_sha,
        last_review_body = excluded.last_review_body,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reviewed_at = datetime('now')`,
		)
		.bind(installationId, repoFullName, prNumber, sha, reviewBody, usage?.inputTokens ?? null, usage?.outputTokens ?? null)
		.run();
}

export async function upsertInstallation(db: D1Database, installationId: number, accountLogin: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO installations (installation_id, account_login)
       VALUES (?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login`,
		)
		.bind(installationId, accountLogin)
		.run();
}

export async function deleteInstallation(db: D1Database, installationId: number): Promise<void> {
	await db.prepare(`DELETE FROM installations WHERE installation_id = ?`).bind(installationId).run();
}

export async function getInstallation(db: D1Database, installationId: number): Promise<InstallationConfig | null> {
	const row = await db
		.prepare(
			`SELECT installation_id, account_login, api_key_encrypted, model,
              severity_threshold, review_tone, ignore_paths, provider
       FROM installations WHERE installation_id = ?`,
		)
		.bind(installationId)
		.first<InstallationConfig>();
	return row ?? null;
}

/**
 * Replace the provider key for an installation. The plaintext never leaves this
 * call: the caller passes ciphertext plus a four-character hint taken from the
 * key, which is all the dashboard is allowed to show.
 */
export async function setInstallationKey(
	db: D1Database,
	installationId: number,
	apiKeyEncrypted: string,
	keyHint: string,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE installations
       SET api_key_encrypted = ?, key_hint = ?,
           last_error_code = NULL, last_error_message = NULL, last_error_at = NULL
       WHERE installation_id = ?`,
		)
		.bind(apiKeyEncrypted, keyHint, installationId)
		.run();

	// An UPDATE that matched nothing is not a success: the row was deleted or the
	// id was never ours, and telling the user "saved" would be a quiet lie.
	return (result.meta?.changes ?? 0) > 0;
}
