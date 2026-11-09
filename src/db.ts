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

export interface MemberRow {
	github_login: string;
	added_by: string;
	created_at: string;
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

// ─── Review history (ADR 0002, P2) ───
//
// `pr_reviews` is memory: one row per pull request, overwritten. This table is
// the record of what actually happened, one row per posted review. Writes are
// best-effort and happen after the review has already been posted, so a failure
// here can never turn a successful review into a failed one.

export interface ReviewEvent {
	id: number;
	installation_id: number;
	repo_full_name: string;
	pr_number: number;
	head_sha: string;
	provider: string | null;
	model: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	created_at: string;
}

export async function recordReview(
	db: D1Database,
	event: {
		installationId: number;
		repoFullName: string;
		prNumber: number;
		headSha: string;
		provider: string | null;
		model: string | null;
		usage?: TokenUsage | null;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO review_history (installation_id, repo_full_name, pr_number, head_sha, provider, model, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			event.installationId,
			event.repoFullName,
			event.prNumber,
			event.headSha,
			event.provider,
			event.model,
			event.usage?.inputTokens ?? null,
			event.usage?.outputTokens ?? null,
		)
		.run();
}

/** `IN (?, ?)` with one placeholder per id, or `NULL` when the list is empty. */
function idList(installationIds: number[]): { placeholders: string; ids: number[] } {
	return {
		placeholders: installationIds.map(() => '?').join(', ') || 'NULL',
		ids: installationIds,
	};
}

export async function listReviewHistory(db: D1Database, installationIds: number[], limit = 50): Promise<ReviewEvent[]> {
	if (installationIds.length === 0) return [];
	const { placeholders, ids } = idList(installationIds);
	const rows = await db
		.prepare(
			`SELECT id, installation_id, repo_full_name, pr_number, head_sha, provider, model,
              input_tokens, output_tokens, created_at
       FROM review_history
       WHERE installation_id IN (${placeholders})
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
		)
		.bind(...ids, limit)
		.all<ReviewEvent>();
	return rows.results ?? [];
}

export interface UsageTotals {
	reviews: number;
	inputTokens: number;
	outputTokens: number;
}

/** All-time totals across the installations the caller administers. */
export async function loadUsageTotals(db: D1Database, installationIds: number[]): Promise<UsageTotals> {
	if (installationIds.length === 0) return { reviews: 0, inputTokens: 0, outputTokens: 0 };
	const { placeholders, ids } = idList(installationIds);
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS reviews,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM review_history
       WHERE installation_id IN (${placeholders})`,
		)
		.bind(...ids)
		.first<{ reviews: number; input_tokens: number; output_tokens: number }>();
	return {
		reviews: row?.reviews ?? 0,
		inputTokens: row?.input_tokens ?? 0,
		outputTokens: row?.output_tokens ?? 0,
	};
}

export interface UsageByModel {
	model: string | null;
	provider: string | null;
	reviews: number;
	inputTokens: number;
	outputTokens: number;
}

export async function loadUsageByModel(db: D1Database, installationIds: number[]): Promise<UsageByModel[]> {
	if (installationIds.length === 0) return [];
	const { placeholders, ids } = idList(installationIds);
	const rows = await db
		.prepare(
			`SELECT model, provider, COUNT(*) AS reviews,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM review_history
       WHERE installation_id IN (${placeholders})
       GROUP BY model, provider
       ORDER BY reviews DESC`,
		)
		.bind(...ids)
		.all<{ model: string | null; provider: string | null; reviews: number; input_tokens: number; output_tokens: number }>();
	return (rows.results ?? []).map((row) => ({
		model: row.model,
		provider: row.provider,
		reviews: row.reviews,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
	}));
}

/**
 * How many review events exist, so a capped list can say what it is capped
 * from. Counted from the same table and the same installation set as
 * `listReviewHistory` — a token-summing aggregate would answer a different
 * question and go wrong the moment a review records no usage.
 */
export async function countReviewHistory(db: D1Database, installationIds: number[]): Promise<number> {
	if (installationIds.length === 0) return 0;
	const { placeholders, ids } = idList(installationIds);
	const row = await db
		.prepare(`SELECT COUNT(*) AS reviews FROM review_history WHERE installation_id IN (${placeholders})`)
		.bind(...ids)
		.first<{ reviews: number }>();
	return row?.reviews ?? 0;
}

// TEAMMATES
//
// An invite is a login, not a user id: the person may not have signed in yet.
// The grant is materialised at sign-in, and only for installations GitHub still
// lists for that account, so losing repo access loses the view on next sign-in.

export async function listMembers(db: D1Database, installationId: number): Promise<MemberRow[]> {
	const rows = await db
		.prepare('SELECT github_login, added_by, created_at FROM members WHERE installation_id = ? ORDER BY lower(github_login)')
		.bind(installationId)
		.all<MemberRow>();
	return rows.results ?? [];
}

/** Returns false when the invite already existed — the UI can say so instead of duplicating. */
export async function addMember(db: D1Database, installationId: number, githubLogin: string, addedBy: string): Promise<boolean> {
	const result = await db
		.prepare('INSERT OR IGNORE INTO members (installation_id, github_login, added_by) VALUES (?, ?, ?)')
		.bind(installationId, githubLogin, addedBy)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function removeMember(db: D1Database, installationId: number, githubLogin: string): Promise<void> {
	await db
		.prepare('DELETE FROM members WHERE installation_id = ? AND lower(github_login) = lower(?)')
		.bind(installationId, githubLogin)
		.run();
}

/** Installation ids this login has been invited to. Compared case-insensitively. */
export async function invitedInstallations(db: D1Database, githubLogin: string): Promise<number[]> {
	const rows = await db
		.prepare('SELECT installation_id FROM members WHERE lower(github_login) = lower(?)')
		.bind(githubLogin)
		.all<{ installation_id: number }>();
	return (rows.results ?? []).map((row) => row.installation_id);
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
	// Memory before the rows it describes, so no delete ordering can strand it.
	await db.prepare(`DELETE FROM pr_reviews WHERE installation_id = ?`).bind(installationId).run();
	await db.prepare(`DELETE FROM repos WHERE installation_id = ?`).bind(installationId).run();
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
