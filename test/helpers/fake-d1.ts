// A tiny in-memory stand-in for D1, big enough for the dashboard's queries.
// It matches on SQL shape rather than parsing SQL — deliberately: these tests
// assert the worker's behaviour, not a SQL engine's.

export interface FakeDbSeed {
	/** Rows the session lookup (`sessions JOIN users`) should return. */
	sessions?: Array<{
		session_id: string;
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

export function makeFakeDb(seed: FakeDbSeed = {}): FakeDb {
	const writes: Array<{ sql: string; args: unknown[] }> = [];

	const prepare = (sql: string) => ({
		bind(...args: unknown[]) {
			const result = (rows: unknown[]) => ({ results: rows, success: true, meta: {} });
			return {
				async first<T>(): Promise<T | null> {
					if (/FROM sessions s\s+JOIN users u/.test(sql)) {
						const id = String(args[0]);
						const row = (seed.sessions ?? []).find((s) => s.session_id === id && !isExpired(s.expires_at));
						return (row as T) ?? null;
					}
					if (/FROM installations WHERE installation_id/.test(sql)) {
						return (seed.installationConfig as T) ?? null;
					}
					if (/FROM repos\s+WHERE installation_id = \? AND owner = \? AND name = \?/.test(sql)) {
						const key = `${Number(args[0])}:${String(args[1])}/${String(args[2])}`;
						return ((seed.repoOverrides ?? {})[key] as T) ?? null;
					}
					return null;
				},
				async all<T>(): Promise<{ results: T[]; success: boolean; meta: unknown }> {
					if (/FROM user_installations ui/.test(sql)) {
						return result((seed.installations ?? []) as T[]) as never;
					}
					if (/FROM repos WHERE installation_id/.test(sql)) {
						return result((seed.repos?.[Number(args[0])] ?? []) as T[]) as never;
					}
					return result([]) as never;
				},
				async run(): Promise<unknown> {
					writes.push({ sql, args });
					return { success: true, meta: {} };
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
