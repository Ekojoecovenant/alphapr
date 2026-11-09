// A tiny in-memory stand-in for D1, big enough for the dashboard's queries.
// It matches on SQL shape rather than parsing SQL — deliberately: these tests
// assert the worker's behaviour, not a SQL engine's.

export interface FakeDbSeed {
	/** Rows the session lookup (`sessions JOIN users`) should return. */
	sessions?: Array<{
		session_id: string;
		/** Defaults to "just now"; set it to exercise the absolute session cap. */
		created_at?: string;
		last_used_at: string | null;
		expires_at: string;
		github_id: number;
		login: string;
		avatar_url: string | null;
	}>;
	/** Rows for the `user_installations LEFT JOIN installations` query. */
	installations?: Array<Record<string, unknown>>;
	/** Repo override rows, keyed by installation id. */
	repos?: Record<number, Array<{ owner: string; name: string; enabled: number }>>;
	/** The `installations` row a review resolves its defaults from. */
	installationConfig?: Record<string, unknown> | null;
	/** A single repo override row, keyed `"<installationId>:<owner>/<name>"`. */
	repoOverrides?: Record<string, Record<string, unknown>>;
	/** The `user_installations` row a write authorizes against, keyed `"<userId>:<installationId>"`. */
	access?: Record<string, { role: string; account_login: string; account_type: string }>;
	/** Rows changed by every `run()`; defaults to 1. Set to 0 to fake a no-op update. */
	changes?: number;
	/** Rows the P2 review-history queries read. */
	reviewHistory?: Array<{
		id?: number;
		installation_id: number;
		repo_full_name: string;
		pr_number: number;
		head_sha: string;
		provider?: string | null;
		model?: string | null;
		input_tokens?: number | null;
		output_tokens?: number | null;
		created_at: string;
	}>;
}

export interface FakeDb {
	db: D1Database;
	/** Every write, in order, with its bound arguments. */
	writes: Array<{ sql: string; args: unknown[] }>;
	/** All writes whose SQL starts with this prefix. */
	writesStartingWith(prefix: string): Array<{ sql: string; args: unknown[] }>;
}

function isExpired(expiresAt: string): boolean {
	// `datetime('now')` is UTC "YYYY-MM-DD HH:MM:SS"; compare the same way.
	return Date.parse(`${expiresAt.replace(' ', 'T')}Z`) <= Date.now();
}

/** `datetime('now')` in SQLite's text shape. */
function sqlNow(): string {
	return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** A session dies seven days after it was opened, however much it is used. */
const ABSOLUTE_CAP_MS = 7 * 24 * 60 * 60 * 1000;

function isPastAbsoluteCap(createdAt: string | undefined): boolean {
	if (!createdAt) return false; // no stamp means "opened now"
	return Date.parse(`${createdAt.replace(' ', 'T')}Z`) <= Date.now() - ABSOLUTE_CAP_MS;
}

export function makeFakeDb(seed: FakeDbSeed = {}): FakeDb {
	const writes: Array<{ sql: string; args: unknown[] }> = [];

	const prepare = (sql: string) => ({
		bind(...args: unknown[]) {
			const result = (rows: unknown[]) => ({ results: rows, success: true, meta: {} });
			return {
				async first<T>(): Promise<T | null> {
					if (/FROM sessions s\s+JOIN users u/.test(sql)) {
						const id = String(args[0]);
						const row = (seed.sessions ?? []).find(
							(s) => s.session_id === id && !isExpired(s.expires_at) && !isPastAbsoluteCap(s.created_at),
						);
						return row ? ({ ...row, created_at: row.created_at ?? sqlNow() } as T) : null;
					}
					if (/FROM user_installations WHERE user_id = \? AND installation_id = \?/.test(sql)) {
						const key = `${Number(args[0])}:${Number(args[1])}`;
						return ((seed.access ?? {})[key] as T) ?? null;
					}
					if (/FROM installations WHERE installation_id/.test(sql)) {
						return (seed.installationConfig as T) ?? null;
					}
					if (/FROM repos\s+WHERE installation_id = \? AND owner = \? AND name = \?/.test(sql)) {
						const key = `${Number(args[0])}:${String(args[1])}/${String(args[2])}`;
						return ((seed.repoOverrides ?? {})[key] as T) ?? null;
					}
					if (/FROM review_history/.test(sql)) {
						const ids = args.map(Number);
						const rows = (seed.reviewHistory ?? []).filter((row) => ids.includes(row.installation_id));
						return {
							reviews: rows.length,
							input_tokens: rows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0),
							output_tokens: rows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
						} as T;
					}
					return null;
				},
				async all<T>(): Promise<{ results: T[]; success: boolean; meta: unknown }> {
					if (/FROM user_installations ui/.test(sql)) {
						const rows = (seed.installations ?? []) as Array<{ role?: string }>;
						// The dashboard drops non-admin rows; ignoring that here would let a
						// test pass while the leak is still open.
						const scoped = /role = 'admin'/.test(sql) ? rows.filter((row) => (row.role ?? 'admin') === 'admin') : rows;
						return result(scoped as T[]) as never;
					}
					if (/FROM repos WHERE installation_id/.test(sql)) {
						return result((seed.repos?.[Number(args[0])] ?? []) as T[]) as never;
					}
					if (/FROM review_history/.test(sql)) {
						// Aggregate queries take only the installation ids; the list query
						// takes the ids and then the limit as its final argument.
						const ids = /GROUP BY|COUNT\(\*\)/.test(sql) ? args.map(Number) : args.slice(0, -1).map(Number);
						const rows = (seed.reviewHistory ?? []).filter((row) => ids.includes(row.installation_id));
						if (/GROUP BY model/.test(sql)) {
							const groups = new Map<
								string,
								{ model: string | null; provider: string | null; reviews: number; input_tokens: number; output_tokens: number }
							>();
							for (const row of rows) {
								const key = `${row.model ?? ''}|${row.provider ?? ''}`;
								const group = groups.get(key) ?? {
									model: row.model ?? null,
									provider: row.provider ?? null,
									reviews: 0,
									input_tokens: 0,
									output_tokens: 0,
								};
								group.reviews += 1;
								group.input_tokens += row.input_tokens ?? 0;
								group.output_tokens += row.output_tokens ?? 0;
								groups.set(key, group);
							}
							return result([...groups.values()].sort((a, b) => b.reviews - a.reviews) as T[]) as never;
						}
						const limit = /LIMIT \?/.test(sql) ? Number(args[args.length - 1]) : rows.length;
						const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
						return result(sorted.slice(0, limit).map((row, index) => ({ id: row.id ?? index + 1, ...row })) as T[]) as never;
					}
					return result([]) as never;
				},
				async run(): Promise<unknown> {
					writes.push({ sql, args });
					// Callers treat `changes === 0` as "nothing matched", so the fake
					// reports one changed row unless a seed says otherwise.
					return { success: true, meta: { changes: seed.changes ?? 1 } };
				},
			};
		},
	});

	return {
		db: { prepare } as unknown as D1Database,
		writes,
		writesStartingWith: (prefix: string) => writes.filter((w) => w.sql.trimStart().startsWith(prefix)),
	};
}
