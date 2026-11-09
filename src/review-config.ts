// Per-repo config resolution (ADR 0002, phase P1).
//
// One rule, applied everywhere: the installation row holds the defaults, and a
// `repos` row holds *overrides*. `NULL` in an override means "inherit". That is
// why a repo can be switched off without uninstalling, and why changing the org
// default still moves every repo that never overrode it.

export const SEVERITY_THRESHOLDS = ['all', 'minor', 'major'] as const;
export const REVIEW_TONES = ['thorough', 'concise'] as const;

export type SeverityThreshold = (typeof SEVERITY_THRESHOLDS)[number];
export type ReviewTone = (typeof REVIEW_TONES)[number];

/** The override columns as they come back from D1. `NULL` means inherit. */
export interface RepoOverrideRow {
	enabled: number;
	provider: string | null;
	model: string | null;
	severity_threshold: string | null;
	review_tone: string | null;
	ignore_paths: string | null;
}

/** The installation row's configurable fields. */
export interface InstallationDefaults {
	provider: string;
	model: string;
	severity_threshold: string;
	review_tone: string;
	ignore_paths: string;
}

/** The full row, as `loadRepoConfig` reads it in one query. */
interface InstallationRow extends InstallationDefaults {
	account_login: string;
	api_key_encrypted: string | null;
}

export interface ResolvedRepoConfig {
	/** Carried through so the review path needs a single query. */
	accountLogin: string;
	apiKeyEncrypted: string | null;
	enabled: boolean;
	provider: string;
	model: string;
	severityThreshold: SeverityThreshold;
	reviewTone: ReviewTone;
	/** Comma-split and trimmed, empty entries dropped. */
	ignorePaths: string[];
	/** The joined form, for storing back in a single column. */
	ignorePathsRaw: string;
	/** Which values came from the repo row rather than the installation. */
	inherits: {
		provider: boolean;
		model: boolean;
		severityThreshold: boolean;
		reviewTone: boolean;
		ignorePaths: boolean;
	};
}

/** A patch where `null` explicitly means "clear the override, inherit instead". */
export interface RepoOverridePatch {
	enabled?: boolean;
	provider?: string | null;
	model?: string | null;
	severityThreshold?: string | null;
	reviewTone?: string | null;
	ignorePaths?: string | null;
}

const SEVERITY_FALLBACK: SeverityThreshold = 'all';

/** Unknown severity values degrade to `all` rather than silently hiding findings. */
export function normalizeSeverity(value: string | null | undefined): SeverityThreshold {
	const trimmed = (value ?? '').trim().toLowerCase();
	return (SEVERITY_THRESHOLDS as readonly string[]).includes(trimmed) ? (trimmed as SeverityThreshold) : SEVERITY_FALLBACK;
}

/** Anything that is not `concise` is `thorough` — the safer of the two. */
export function normalizeTone(value: string | null | undefined): ReviewTone {
	return (value ?? '').trim().toLowerCase() === 'concise' ? 'concise' : 'thorough';
}

export function splitIgnorePaths(raw: string | null | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(',')
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

/** Pure: merge one installation row with an optional override row. */
export function mergeRepoConfig(
	installation: InstallationDefaults & { account_login?: string; api_key_encrypted?: string | null },
	override: RepoOverrideRow | null,
): ResolvedRepoConfig {
	const provider = override?.provider ?? installation.provider;
	const model = override?.model ?? installation.model;
	const severityRaw = override?.severity_threshold ?? installation.severity_threshold;
	const reviewTone = normalizeTone(override?.review_tone ?? installation.review_tone);
	const ignorePathsRaw = override?.ignore_paths ?? installation.ignore_paths;

	return {
		accountLogin: installation.account_login ?? '',
		apiKeyEncrypted: installation.api_key_encrypted ?? null,
		enabled: override ? override.enabled !== 0 : true,
		provider,
		model,
		severityThreshold: normalizeSeverity(severityRaw),
		reviewTone,
		ignorePaths: splitIgnorePaths(ignorePathsRaw),
		ignorePathsRaw: ignorePathsRaw ?? '',
		inherits: {
			provider: override?.provider === null || override?.provider === undefined,
			model: override?.model === null || override?.model === undefined,
			severityThreshold: override?.severity_threshold === null || override?.severity_threshold === undefined,
			reviewTone: override?.review_tone === null || override?.review_tone === undefined,
			ignorePaths: override?.ignore_paths === null || override?.ignore_paths === undefined,
		},
	};
}

export async function getRepoOverride(
	db: D1Database,
	installationId: number,
	owner: string,
	name: string,
): Promise<RepoOverrideRow | null> {
	const row = await db
		.prepare(
			`SELECT enabled, provider, model, severity_threshold, review_tone, ignore_paths
       FROM repos
       WHERE installation_id = ? AND owner = ? AND name = ?`,
		)
		.bind(installationId, owner, name)
		.first<RepoOverrideRow>();
	return row ?? null;
}

/**
 * Resolve what this repo's review should use. Returns null when the installation
 * has no row at all (nothing is configured yet) — the caller decides what that
 * means, which for AlphaPR is "tell the user to run /setup".
 */
export async function loadRepoConfig(
	db: D1Database,
	installationId: number,
	owner: string,
	name: string,
): Promise<ResolvedRepoConfig | null> {
	const installation = await db
		.prepare(
			`SELECT account_login, api_key_encrypted, provider, model, severity_threshold, review_tone, ignore_paths
       FROM installations WHERE installation_id = ?`,
		)
		.bind(installationId)
		.first<InstallationRow>();

	if (!installation) return null;

	const override = await getRepoOverride(db, installationId, owner, name);
	return mergeRepoConfig(installation, override);
}

/**
 * Should a review run for this repo? Fails **open**: a database hiccup must not
 * silently stop reviews, because silence is indistinguishable from "broken".
 */
export async function shouldReviewRepo(db: D1Database, installationId: number, owner: string, name: string): Promise<boolean> {
	try {
		const override = await getRepoOverride(db, installationId, owner, name);
		return override ? override.enabled !== 0 : true;
	} catch (err) {
		console.error(`Could not read repo overrides for ${owner}/${name} (reviewing anyway): ${err instanceof Error ? err.message : err}`);
		return true;
	}
}

/** Upsert an override. Fields left out of the patch keep their stored value. */
export async function saveRepoOverride(
	db: D1Database,
	installationId: number,
	owner: string,
	name: string,
	patch: RepoOverridePatch,
): Promise<void> {
	const existing = await getRepoOverride(db, installationId, owner, name);
	const pick = <T>(next: T | undefined, prev: T | null | undefined): T | null => (next === undefined ? (prev ?? null) : next);

	const enabled = patch.enabled === undefined ? (existing?.enabled ?? 1) : patch.enabled ? 1 : 0;
	const provider = pick(patch.provider, existing?.provider);
	const model = pick(patch.model, existing?.model);
	const severity = pick(patch.severityThreshold, existing?.severity_threshold);
	const tone = pick(patch.reviewTone, existing?.review_tone);
	const ignorePaths = pick(patch.ignorePaths, existing?.ignore_paths);

	await db
		.prepare(
			`INSERT INTO repos (installation_id, owner, name, enabled, provider, model, severity_threshold, review_tone, ignore_paths)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_id, owner, name) DO UPDATE SET
         enabled = excluded.enabled,
         provider = excluded.provider,
         model = excluded.model,
         severity_threshold = excluded.severity_threshold,
         review_tone = excluded.review_tone,
         ignore_paths = excluded.ignore_paths,
         updated_at = datetime('now')`,
		)
		.bind(installationId, owner, name, enabled, provider, model, severity, tone, ignorePaths)
		.run();
}

/** Drop the row entirely, so the repo inherits everything again. */
export async function clearRepoOverride(db: D1Database, installationId: number, owner: string, name: string): Promise<void> {
	await db.prepare(`DELETE FROM repos WHERE installation_id = ? AND owner = ? AND name = ?`).bind(installationId, owner, name).run();
}
