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

/**
 * Remove an installation and everything that hung off it.
 *
 * There is deliberately no foreign key from `user_installations` to
 * `installations`: a user can sign in before the webhook that creates the
 * installation row has arrived, and the grant has to be storable at that point.
 * The cleanup therefore lives here, where the uninstall actually happens.
 */
export async function deleteInstallation(db: D1Database, installationId: number): Promise<void> {
	await db.prepare(`DELETE FROM user_installations WHERE installation_id = ?`).bind(installationId).run();
	await db.prepare(`DELETE FROM repos WHERE installation_id = ?`).bind(installationId).run();
	await db.prepare(`DELETE FROM pr_reviews WHERE installation_id = ?`).bind(installationId).run();
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

	// `changes` alone cannot answer "did this row exist": a provider can be told
	// to store a key it already had, and the count is then zero even though the
	// update matched. So a zero count is followed by one existence check rather
	// than turned into a 404 that would be wrong.
	const changes = result.meta?.changes ?? 0;
	if (changes > 0) return true;

	const row = await db
		.prepare('SELECT 1 AS present FROM installations WHERE installation_id = ?')
		.bind(installationId)
		.first<{ present: number }>();

	return row !== null;
}
